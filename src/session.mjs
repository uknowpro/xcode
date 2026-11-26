import { randomUUID } from 'node:crypto';
import { lock, saveJson, sessionsDir, sessionPath, listSessions, settings, tokenFor } from './store.mjs';
import { runJob } from './agent.mjs';

export class Sessions {
  constructor(root, onEvent = () => {}) {
    this.root = root;
    this.onEvent = onEvent;
    this.open = new Map();
  }

  async list() {
    return listSessions(this.root);
  }

  async select(prefix, defaults) {
    const previous = await this.list();
    let found;
    if (prefix) {
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
    const unlock = await lock(sessionsDir, session.id);
    try {
      if (found) session = (await this.list()).find(item => item.id === found.id) ?? found;
      const live = { session, unlock, active: null, held: Boolean(session.queue.length), writes: Promise.resolve() };
      this.open.set(session.id, live);
      await this.persist(live);
      return live;
    } catch (error) {
      this.open.delete(session.id);
      await unlock();
      throw error;
    }
  }

  persist(live) {
    live.session.updated = new Date().toISOString();
    const value = structuredClone(live.session);
    live.writes = live.writes.catch(() => {}).then(() => saveJson(sessionPath(value.id), value));
    return live.writes;
  }

  notify(live, event) {
    this.onEvent(live, event);
  }

  async enqueue(live, prompt, attachments = []) {
    if (live.session.queue.length >= 12) throw new Error('The session queue already has 12 messages.');
    if (attachments.length > 8 || Buffer.byteLength(JSON.stringify(attachments)) > 12 * 1024 * 1024)
      throw new Error('Maximum 8 attachments and 12 MiB of encoded attachment data per message.');
    const job = { prompt, attachments, completed: [], changed: [], tools: [] };
    if (live.session.title === 'New session') live.session.title = prompt.replace(/\s+/g, ' ').slice(0, 72);
    live.session.queue.push(job);
    try {
      await this.persist(live);
    } catch (error) {
      live.session.queue.splice(live.session.queue.indexOf(job), 1);
      throw error;
    }
    if (live.active || live.held) this.notify(live, { type: 'queue', count: live.session.queue.length - Number(Boolean(live.active)) });
    return { run: this.pump(live) };
  }

  pump(live) {
    if (this.closing || live.active || live.held || !live.session.queue.length) return live.active?.promise;
    const controller = new AbortController();
    const active = { controller, advance: false };
    live.active = active;
    active.promise = this.execute(live, active).finally(() => {
      live.active = null;
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
      const answer = await runJob({ session, job, config, profile, token, signal,
        emit: event => this.notify(live, event), save: () => this.persist(live) });
      await this.finish(live, job, answer, 'complete');
      this.notify(live, { type: 'complete', answer });
      return { answer };
    } catch (error) {
      if (signal.aborted && active.advance) {
        await this.finish(live, job, '', 'stopped');
        this.notify(live, { type: 'note', text: 'Stopped current message. Sending the next queued message.' });
      } else {
        live.held = true;
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
      attachments: job.attachments.map(file => file.name), time: new Date().toISOString(),
    };
    turns.push(item);
    queue.shift();
    try {
      await this.persist(live);
    } catch (error) {
      queue.unshift(job);
      turns.pop();
      throw error;
    }
  }

  stop(live, advance = false) {
    if (!live.active) return false;
    live.active.advance = advance && live.session.queue.length > 1;
    live.active.controller.abort();
    return true;
  }

  async skip(live) {
    if (live.active) throw new Error('Stop the active request first, or use /next.');
    if (!live.session.queue.length) return;
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
