type Disposable = { dispose: () => Promise<void> };
type Entry<T> = { value: T; leases: number; retired: boolean; disposed: boolean };

/** Owns generated previews, never the user's original file. An upload leases a
 * preview so that unmount or a new render cannot remove it while it is read. */
export class PreviewSession<T extends Disposable> {
  private current: Entry<T> | null = null;
  private pending = new Set<Promise<void>>();
  private version = 0;
  private closed = false;

  get revision() { return this.version; }
  get isClosed() { return this.closed; }
  isCurrent(revision: number) { return !this.closed && revision === this.version; }

  revise() {
    this.version += 1;
    this.retireCurrent();
    return this.version;
  }

  accept(revision: number, value: T): boolean {
    if (!this.isCurrent(revision)) {
      this.dispose(value);
      return false;
    }
    this.retireCurrent();
    this.current = { value, leases: 0, retired: false, disposed: false };
    return true;
  }

  acquire(): { value: T; release: () => void } | null {
    const entry = this.current;
    if (this.closed || !entry) return null;
    entry.leases += 1;
    let released = false;
    return { value: entry.value, release: () => {
      if (released) return;
      released = true;
      entry.leases -= 1;
      this.disposeRetired(entry);
    } };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.revise();
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private retireCurrent() {
    const entry = this.current;
    this.current = null;
    if (!entry) return;
    entry.retired = true;
    this.disposeRetired(entry);
  }

  private disposeRetired(entry: Entry<T>) {
    if (!entry.retired || entry.leases !== 0 || entry.disposed) return;
    entry.disposed = true;
    this.dispose(entry.value);
  }

  private dispose(value: T) {
    const job = Promise.resolve().then(() => value.dispose()).catch(() => {});
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
  }
}
