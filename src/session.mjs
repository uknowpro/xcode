import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { lock, sessionsDir, listSessions, readSession, settings, tokenFor, writeSession } from './store.mjs';
import { runJob } from './agent.mjs';
import { applyReview, inverseReview, ReviewRequired } from './changes.mjs';
import { Workspace } from './workspace.mjs';
import { refreshMemory } from './memory.mjs';
import { attachmentSize, maxAttachmentBytes, maxAttachments } from './attachments.mjs';
import { completedWire, pruneWire } from './wire-history.mjs';

export class Sessions {
  constructor(root, onEvent = () => {}) {
    this.root = root;
    this.onEvent = onEvent;
    this.open = new Map();
  }

  async list(onProblem) {
    return listSessions(this.root, onProblem);
  }

  async select(prefix, defaults) {
    let found;
    if (prefix) {
      const previous = await this.list();
      const matches = prefix === 'latest' ? previous.slice(0, 1) : previous.filter(session => session.id.startsWith(prefix));
      if (matches.length !== 1) throw new Error(matches.length ? 'Session prefix is ambiguous.' : 'Session not found in this project.');
      found = matches[0];
      if (this.open.has(found.id)) return this.open.get(found.id);
    }
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
    await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
    const unlock = await lock(sessionsDir, session.id);
    try {
      if (found) {
        session = await readSession(found.id);
        if (!session || session.root !== this.root) throw new Error('Session is no longer available in this project.');
      }
      session.memory = refreshMemory(session);
      const live = { session, unlock, active: null, held: Boolean(session.queue.length), writes: Promise.resolve() };
      this.open.set(session.id, live);
      await this.persist(live);
      return live;
    } catch (error) {
      this.open.delete(found?.id ?? session.id);
      await unlock();
      throw error;
    }
  }

  persist(live) {
    live.session.updated = new Date().toISOString();
    const value = structuredClone(live.session);
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
    if (live.session.title === 'New session') live.session.title = prompt.replace(/\s+/g, ' ').slice(0, 72);
    live.session.queue.push(job);
    try {
      await this.persist(live);
    } catch (error) {
      const index = live.session.queue.indexOf(job);
      if (index >= 0) live.session.queue.splice(index, 1);
      if (!live.session.queue.length && !live.session.turns.length) live.session.title = 'New session';
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
      const answer = await runJob({ session, job, config, profile, token, signal,
        emit: event => this.notify(live, event), save: () => this.persist(live) });
      await this.finish(live, job, answer, 'complete');
      this.notify(live, { type: 'complete', answer });
      return { answer };
    } catch (error) {
      if (error instanceof ReviewRequired || (job.review && !active.advance)) {
        live.held = true;
        this.notify(live, { type: 'review', id: job.review.id, files: job.review.files.map(file => file.path) });
        return { review: job.review };
      }
      if (signal.aborted && active.advance) {
        await this.finish(live, job, '', 'stopped');
        this.notify(live, { type: 'note', text: 'Stopped current message. Sending the next queued message.' });
      } else {
        live.held = true;
        if (!signal.aborted) job.failure = error.message;
        await this.persist(live);
        this.notify(live, { type: 'error', error: signal.aborted ? new Error('Stopped. /continue resumes, /skip removes this message.') : error });
      }
      return { error };
    }
  }

  async finish(live, job, answer, status) {
    const queue = live.session.queue;
    const turns = live.session.turns;
    const item = {
      prompt: job.prompt, answer, status, completed: job.completed, changed: job.changed, tools: job.tools,
      checks: job.checks ?? [], attachments: job.attachments.map(file => file.name), time: new Date().toISOString(),
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
