type Job = { source: string; resolve: (uri: string) => void; reject: (error: Error) => void };

/** Owns only images created by the video thumbnail generator, never originals. */
export class ThumbnailSession {
  private create: (source: string) => Promise<string>;
  private remove: (uri: string) => Promise<void>;
  private byId = new Map<string, Promise<string>>();
  private owned = new Set<string>();
  private pending = new Set<Promise<void>>();
  private queued: Job[] = [];
  private active = 0;
  private closed = false;

  constructor(create: (source: string) => Promise<string>, remove: (uri: string) => Promise<void>) {
    this.create = create;
    this.remove = remove;
  }

  get(id: string, source: string): Promise<string> {
    if (this.closed) return Promise.reject(new Error('Панель закрыта.'));
    const existing = this.byId.get(id);
    if (existing) return existing;
    const result = new Promise<string>((resolve, reject) => this.queued.push({ source, resolve, reject }));
    this.byId.set(id, result);
    this.pump();
    return result;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.queued) job.reject(new Error('Панель закрыта.'));
    this.queued = [];
    for (const uri of this.owned) this.dispose(uri);
    this.owned.clear();
    this.byId.clear();
  }

  async drain() {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private pump() {
    while (!this.closed && this.active < 2 && this.queued.length) {
      const job = this.queued.shift()!;
      this.active += 1;
      this.track(this.run(job).finally(() => { this.active -= 1; this.pump(); }));
    }
  }

  private async run(job: Job) {
    try {
      const uri = await this.create(job.source);
      if (!uri || uri === job.source) throw new Error('Не удалось создать отдельную миниатюру.');
      if (this.closed) { this.dispose(uri); throw new Error('Панель закрыта.'); }
      this.owned.add(uri);
      job.resolve(uri);
    } catch (error) { job.reject(error instanceof Error ? error : new Error('Миниатюра недоступна.')); }
  }

  private dispose(uri: string) { this.track(Promise.resolve().then(() => this.remove(uri)).catch(() => {})); }
  private track(job: Promise<void>) {
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
  }
}
