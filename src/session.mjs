import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { lock, sessionsDir, listSessions, readSession, settings, tokenFor, writeSession } from './store.mjs';
import { runJob } from './agent.mjs';
import { applyReview, inverseReview, ReviewRequired } from './changes.mjs';
import { Workspace } from './workspace.mjs';
import { refreshMemory } from './memory.mjs';
import { attachmentSize, maxAttachmentBytes, maxAttachments } from './attachments.mjs';
import { completedWire, pruneWire } from './wire-history.mjs';
import { latestChecks } from './repair.mjs';
import { modelFailure } from './model-transport.mjs';
import { maxDraftLength } from './draft.mjs';

export class Sessions {
  constructor(root, onEvent = () => {}) {
    this.root = root;
    this.onEvent = onEvent;
    this.open = new Map();
  }

  async list(onProblem) {
    return listSessions(this.root, onProblem);
  }

  async find(prefix) {
    const previous = await this.list();
    const matches = prefix === 'latest' ? previous.filter(session => !session.archived).slice(0, 1) :
      previous.filter(session => session.id.startsWith(prefix));
    if (matches.length !== 1) throw new Error(matches.length ? 'Session prefix is ambiguous.' : 'Session not found in this project.');
    return matches[0];
  }

  async select(prefix, defaults) {
    const found = prefix ? await this.find(prefix) : undefined;
    if (found && this.open.has(found.id)) return this.open.get(found.id);
    const config = await settings();
    let session = found ?? {
      id: randomUUID(),
      root: this.root,
      title: 'New session',
      profile: defaults.profile || config.defaultProfile || 'default',
      harness: defaults.harness || 'default',
      write: false,
      retrySeconds: 0,
      queue: [],
      turns: [],
      updated: new Date().toISOString(),
    };
    return this.openSession(session, Boolean(found));
  }

  async openSession(session, reload = false) {
    await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
    const id = session.id;
    const unlock = await lock(sessionsDir, id);
    try {
      if (reload) {
        session = await readSession(id);
        if (!session || session.root !== this.root) throw new Error('Session is no longer available in this project.');
      }
      session.memory = refreshMemory(session);
      const live = { session, unlock, active: null, held: Boolean(session.queue.length), writes: Promise.resolve() };
      this.open.set(session.id, live);
      await this.persist(live);
      return live;
    } catch (error) {
      this.open.delete(id);
      await unlock();
      throw error;
    }
  }

  async fork(live, number, { profile, visibleOnly = false } = {}) {
    const origin = live.session;
    const end = number === undefined ? origin.turns.length : Number(number);
    if (!Number.isInteger(end) || end < 0 || end > origin.turns.length)
      throw new Error('Choose a turn between 0 and ' + origin.turns.length + '.');
    const turns = origin.turns.slice(0, end).map(turn => {
      if (!visibleOnly) return turn;
      const { wire, ...visible } = turn;
      return visible;
    });
    return this.openSession({
      id: randomUUID(), root: origin.root, title: ('Fork · ' + origin.title).slice(0, 120),
      customTitle: true, profile: profile ?? origin.profile, harness: origin.harness, write: false, retrySeconds: 0,
      queue: [], turns: structuredClone(turns), ...(origin.pins?.length ? { pins: structuredClone(origin.pins) } : {}), forkedFrom: { id: origin.id, turn: end },
    });
  }

  persist(live) {
    live.session.updated = new Date().toISOString();
    // Finished turns are replaced as a list. Queue, review and check state remain mutable.
    const { turns, ...mutable } = live.session;
    const value = { ...structuredClone(mutable), turns };
    live.writes = live.writes.catch(() => {}).then(() => writeSession(value));
    return live.writes;
  }

  notify(live, event) {
    this.onEvent(live, event);
  }

  async enqueue(live, prompt, attachments = []) {
    if (live.session.queue.length >= 12) throw new Error('The session queue already has 12 messages.');
    if (attachments.length > maxAttachments ||
      1 + attachments.reduce((bytes, item) => bytes + attachmentSize(item), 0) > maxAttachmentBytes)
      throw new Error('Maximum 8 attachments and 12 MiB of encoded attachment data per message.');
    const job = { prompt, attachments, completed: [], changed: [], tools: [] };
    if (!live.session.customTitle && live.session.title === 'New session') live.session.title = prompt.replace(/\s+/g, ' ').slice(0, 72);
    live.session.queue.push(job);
    try {
      await this.persist(live);
    } catch (error) {
      const index = live.session.queue.indexOf(job);
      if (index >= 0) live.session.queue.splice(index, 1);
      if (!live.session.customTitle && !live.session.queue.length && !live.session.turns.length) live.session.title = 'New session';
      throw error;
    }
    if (live.active || live.held) this.notify(live, { type: 'queue', count: live.session.queue.length - Number(Boolean(live.active)) });
    return { run: this.pump(live) };
  }

  pump(live) {
    if (this.closing || live.active || live.held || live.reviewing || live.session.queue[0]?.review || live.session.undoInProgress?.state === 'applying' || !live.session.queue.length) return live.active?.promise;
    const controller = new AbortController();
    const active = { controller, advance: false };
    live.active = active;
    active.promise = this.execute(live, active).finally(() => {
      live.active = null;
      if (live.holdAfterCurrent) live.held = true;
      const next = this.pump(live);
      next?.catch(error => this.notify(live, { type: 'error', error }));
    });
    return active.promise;
  }

  async execute(live, active) {
    const { session } = live;
    const job = session.queue[0];
    const signal = active.controller.signal;
    try {
      const config = await settings();
      if (!Object.hasOwn(config.profiles, session.profile))
        throw new Error('Set up a model profile first with xcode setup.');
      const profile = config.profiles[session.profile];
      const token = await tokenFor(session.profile);
      delete job.failure;
      delete job.failureInfo;
      const answer = await runJob({ session, job, config, profile, token, signal,
        emit: event => {
          if (event.type === 'attempt') active.partial = undefined;
          if (event.type === 'text' && !event.intermediate) {
            const combined = (active.partial?.text ?? '') + event.text;
            active.partial = { text: combined.slice(-16000), truncated: Boolean(active.partial?.truncated || combined.length > 16000) };
          }
          if (event.type === 'request' || event.type === 'stage') {
            active.stage = event.stage;
            active.tool = undefined;
          } else if (event.type === 'tool-start') {
            active.tool = event.name;
          }
          this.notify(live, event);
        }, save: () => this.persist(live) });
      const failedChecks = latestChecks(job.checks).filter(check => check.status !== 'passed').map(check => check.name);
      await this.finish(live, job, answer, 'complete', failedChecks);
      this.notify(live, { type: 'complete', answer, failedChecks });
      return { answer, failedChecks };
    } catch (error) {
      if (error instanceof ReviewRequired || (job.review && !active.advance)) {
        live.held = true;
        this.notify(live, { type: 'review', id: job.review.id, files: job.review.files.map(file => file.path) });
        return { review: job.review };
      }
      if (active.partial?.text) job.partial = active.partial;
      if (signal.aborted && active.advance) {
        await this.finish(live, job, '', 'stopped');
        this.notify(live, { type: 'note', text: 'Stopped current message. Sending the next queued message.' });
      } else {
        live.held = true;
        if (!signal.aborted) {
          const { detail, ...failureInfo } = modelFailure(error);
          job.failure = detail;
          if (failureInfo.phase) job.failureInfo = failureInfo;
        }
        await this.persist(live);
        this.notify(live, { type: 'error', error: signal.aborted ? new Error('Stopped. /continue resumes, /skip removes this message.') : error });
      }
      return { error };
    }
  }

  async finish(live, job, answer, status, failedChecks = []) {
    const queue = live.session.queue;
    const turns = live.session.turns;
    const item = {
      prompt: job.prompt, answer, status, completed: job.completed, changed: job.changed, tools: job.tools,
      checks: job.checks ?? [], attachments: job.attachments.map(file => file.name), time: new Date().toISOString(),
      ...(failedChecks.length ? { verificationFailed: true } : {}),
      ...(status !== 'complete' && job.partial ? { partial: job.partial } : {}),
      ...(status === 'complete' && job.wire ? { wire: completedWire(job) } : {}),
    };
    const previousMemory = live.session.memory;
    live.session.turns = pruneWire([...turns, item]);
    queue.shift();
    live.session.memory = refreshMemory(live.session);
    try {
      await this.persist(live);
    } catch (error) {
      queue.unshift(job);
      live.session.turns = turns;
      live.session.memory = previousMemory;
      throw error;
    }
  }

  stop(live, advance = false) {
    if (!live.active) return false;
    live.active.advance = advance && live.session.queue.length > 1;
    live.active.controller.abort();
    return true;
  }

  async review(live, decision, paths = []) {
    const job = live.session.queue[0];
    const review = job?.review;
    if (!review) throw new Error('There is no pending change set.');
    if (live.active || live.reviewing) throw new Error('Wait for this session to finish its current action.');
    if (live.session.undoInProgress?.state === 'applying')
      throw new Error('Finish the interrupted undo before reviewing another change.');
    if (decision === 'reject' && review.state === 'applying') throw new Error('An interrupted apply must be reconciled before it can be discarded.');
    const chosen = paths.length || review.state === 'applying' ? paths : review.markedPaths ?? paths;
    if (decision === 'apply' && review.state !== 'applying' && review.markedPaths && !chosen.length)
      throw new Error('Select at least one file in /diff or pass paths to apply.');
    live.reviewing = true;
    try {
      const tool = job.stageHistory?.findLast(message => {
        if (message.role !== 'tool' || message.tool_call_id !== review.callId) return false;
        try {
          return JSON.parse(message.content).reviewId === review.id;
        } catch {
          return false;
        }
      });
      if (!tool) throw new Error('Missing the tool result for this review.');
      const files = decision === 'apply'
        ? await applyReview(new Workspace(this.root), review, () => this.persist(live), chosen)
        : [];
      const previous = tool.content;
      const oldChanged = job.changed;
      const oldHistory = live.session.changes;
      const approvals = job.approvals;
      job.changed = [...new Set([...oldChanged, ...files])];
      const excluded = review.files.map(file => file.path).filter(path => !files.includes(path));
      if (decision === 'apply') {
        job.approvals = [...(approvals ?? []), { stageIndex: job.completed.length, files }];
        live.session.changes = [...(oldHistory ?? []), {
          id: review.id, prompt: job.prompt.slice(0, 160), appliedAt: new Date().toISOString(),
          files: review.files.filter(file => files.includes(file.path)),
        }];
      }
      tool.content = JSON.stringify(decision === 'apply'
        ? { status: 'applied', reviewId: review.id, files, excluded,
          ...(excluded.length ? { instruction: 'The excluded paths were declined. Do not propose them again without a new user request.' } : {}) }
        : { status: 'rejected_by_user', reviewId: review.id, instruction: 'Do not repeat the rejected proposal. Continue with an explanation.' });
      delete job.review;
      try {
        await this.persist(live);
      } catch (error) {
        job.review = review;
        job.changed = oldChanged;
        job.approvals = approvals;
        live.session.changes = oldHistory;
        tool.content = previous;
        throw error;
      }
      return files;
    } finally {
      live.reviewing = false;
    }
  }

  async undo(live, id) {
    const session = live.session;
    if (live.active || live.reviewing) throw new Error('Pause the session before undoing an applied change.');
    if (session.queue[0]?.review?.state === 'applying') throw new Error('Finish the interrupted apply before undoing a change.');
    const journal = session.undoInProgress;
    if (journal && id && journal.id !== id) throw new Error('First finish undoing ' + journal.id + '.');
    const history = session.changes ?? [];
    const change = id || journal
      ? history.find(item => item.id === (id || journal.id))
      : history.findLast(item => !item.undoneAt);
    if (!change) throw new Error('No applied change to undo in this session.');
    if (change.undoneAt) throw new Error('Change ' + change.id + ' was already undone.');

    live.reviewing = true;
    const undo = journal ?? inverseReview(change);
    session.undoInProgress = undo;
    try {
      let files;
      try {
        files = await applyReview(new Workspace(this.root), undo, () => this.persist(live));
      } catch (error) {
        if (undo.state !== 'applying') {
          delete session.undoInProgress;
          await this.persist(live);
        }
        throw error;
      }
      change.undoneAt = new Date().toISOString();
      delete session.undoInProgress;
      try {
        await this.persist(live);
      } catch (error) {
        delete change.undoneAt;
        session.undoInProgress = undo;
        throw error;
      }
      return { id: change.id, files };
    } finally {
      live.reviewing = false;
    }
  }

  async updateMetadata(live, action, title) {
    const { session } = live;
    if (action === 'rename') {
      const name = title.trim();
      if (!name || name.length > 120 || /[\x00-\x1f\x7f-\x9f]/.test(name))
        throw new Error('Enter a single-line session title up to 120 characters.');
      session.title = name;
      session.customTitle = true;
    } else if (action === 'pin' || action === 'unpin') {
      session.pinned = action === 'pin';
    } else if (action === 'archive' || action === 'restore') {
      if (action === 'archive' && (live.active || session.queue.length || session.undoInProgress))
        throw new Error('Finish pending work before archiving this session.');
      session.archived = action === 'archive';
    } else {
      throw new Error('Use rename, pin, unpin, archive or restore.');
    }
    await this.persist(live);
    return session;
  }

  async updateQueue(live, action, position, value) {
    const queue = live.session.queue;
    const index = Number(position) - 1;
    const job = Number.isInteger(index) && index >= 0 ? queue[index] : undefined;
    if (!job) throw new Error('Select a message number from /queue.');
    const active = live.active;
    const locked = item => (active && item === queue[0]) || item?.harness || item?.review;
    if (locked(job)) throw new Error('This message has started. Use /stop, /continue or /skip.');
    const previous = queue.slice();
    const oldPrompt = job.prompt;
    const sendNow = action === 'send';

    if (action === 'edit') {
      if (!value.trim() || value.length > maxDraftLength) throw new Error('Enter a prompt up to 32,000 characters.');
      job.prompt = value;
    } else if (action === 'drop') {
      queue.splice(index, 1);
    } else if (action === 'move' || sendNow) {
      const target = sendNow ? Number(Boolean(active)) : Number(value) - 1;
      if (!Number.isInteger(target) || target < 0 || target >= queue.length || locked(queue[target]))
        throw new Error('Select another waiting message position.');
      if (sendNow && (queue[0].review || live.session.undoInProgress))
        throw new Error('Finish the pending review or undo before sending a different message.');
      queue.splice(index, 1);
      queue.splice(target, 0, job);
    } else {
      throw new Error('Use /queue edit, move, drop or send.');
    }

    try {
      await this.persist(live);
    } catch (error) {
      if (live.active === active) {
        job.prompt = oldPrompt;
        queue.splice(0, queue.length, ...previous);
      }
      throw error;
    }
    if (sendNow && live.active === active) {
      live.held = false;
      if (active) this.stop(live, true);
      else this.pump(live)?.catch(error => this.notify(live, { type: 'error', error }));
    }
  }

  async skip(live) {
    if (live.active) throw new Error('Stop the active request first, or use /next.');
    if (!live.session.queue.length) return;
    if (live.session.queue[0].review?.state === 'applying') throw new Error('Reconcile the interrupted apply before discarding this message.');
    await this.finish(live, live.session.queue[0], '', 'stopped');
    live.held = false;
    this.pump(live)?.catch(error => this.notify(live, { type: 'error', error }));
  }

  async close() {
    this.closing = true;
    const lives = [...this.open.values()];
    for (const live of lives) this.stop(live);
    await Promise.all(lives.map(async live => {
      try {
        await live.active?.promise.catch(() => {});
        await live.writes;
      } finally {
        await live.unlock();
      }
    }));
  }
}
