class WorkLimit {
  constructor(max) {
    this.max = max;
    this.running = 0;
    this.waiting = [];
  }

  async run(signal, work) {
    signal?.throwIfAborted();
    if (this.running < this.max) this.running++;
    else await new Promise((resolve, reject) => {
      const start = () => {
        signal?.removeEventListener('abort', cancel);
        resolve();
      };
      const cancel = () => {
        this.waiting.splice(this.waiting.indexOf(start), 1);
        reject(signal.reason);
      };
      this.waiting.push(start);
      signal?.addEventListener('abort', cancel, { once: true });
    });
    try {
      signal?.throwIfAborted();
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
}

export const modelLimit = new WorkLimit(3);
export const checkLimit = new WorkLimit(2);

export function executionLimits(config = {}, options = {}) {
  const number = (flag, key, fallback) => {
    const raw = options[flag] ?? config?.[key] ?? fallback;
    if (!/^\d+$/.test(String(raw)) || !Number.isInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > 12)
      throw new Error('--' + flag + ' needs a number from 1 to 12.');
    return Number(raw);
  };
  return { modelJobs: number('model-jobs', 'modelJobs', 3), checkJobs: number('check-jobs', 'checkJobs', 2) };
}

export function setLimits(config) {
  const limits = executionLimits(config);
  modelLimit.max = limits.modelJobs;
  checkLimit.max = limits.checkJobs;
}
