// Stage B: a transport-independent lifecycle for a *future* native WebRTC joiner.
// Deliberately not wired into the production server pool: availability of a
// reachable bootstrap endpoint and actual native tunnel must be demonstrated first.
import { verifyTransportBLease, type SignedTransportBLease } from './lease';

export type TransportBState = 'idle' | 'requesting' | 'connecting' | 'connected' | 'unavailable';
export type TransportBJoiner = {
  /** Must bind only the app's own network adapter; never a device-wide VPN. */
  start(joinLink: string, signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
};
export type TransportBOptions = {
  deviceId: string;
  realm: string;
  publicKeys: readonly string[];
  /** Transport offer is supplied by a separately reachable, authenticated bootstrap. */
  acquire(signal: AbortSignal): Promise<SignedTransportBLease>;
  joiner: TransportBJoiner;
  /** Persisted per-device, anti-replay sequence; not just a process-local variable. */
  loadSequence(): Promise<number>;
  saveSequence(sequence: number): Promise<void>;
  now?(): number;
};

export class TransportBController {
  private readonly options: TransportBOptions;
  private state: TransportBState = 'idle';
  private pending: Promise<boolean> | null = null;
  private abort: AbortController | null = null;
  private epoch = 0;
  private listeners = new Set<(state: TransportBState) => void>();

  constructor(options: TransportBOptions) {
    if (!options || !options.deviceId || !options.realm || !options.publicKeys?.length ||
        typeof options.acquire !== 'function' || typeof options.loadSequence !== 'function' ||
        typeof options.saveSequence !== 'function' || !options.joiner ||
        typeof options.joiner.start !== 'function' || typeof options.joiner.stop !== 'function') {
      throw new TypeError('a signed lease bootstrap, persistent anti-replay state and native joiner are required');
    }
    this.options = options;
  }

  get status(): TransportBState { return this.state; }

  subscribe(listener: (state: TransportBState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private setState(next: TransportBState) {
    if (this.state === next) return;
    this.state = next;
    for (const listener of this.listeners) {
      try { listener(next); } catch { /* subscriber cannot break the connection */ }
    }
  }

  /** Single in-flight attempt; never retries automatically in a tight loop. */
  start(): Promise<boolean> {
    if (this.state === 'connected') return Promise.resolve(true);
    if (this.pending) return this.pending;
    const abort = new AbortController();
    const epoch = ++this.epoch;
    this.abort = abort;

    const attempt = (async () => {
      this.setState('requesting');
      try {
        const previous = await this.options.loadSequence();
        if (!Number.isSafeInteger(previous) || previous < 0) throw new Error('invalid saved sequence');
        if (abort.signal.aborted) return false;
        const signed = await this.options.acquire(abort.signal);
        if (abort.signal.aborted) return false;
        const lease = verifyTransportBLease(signed, this.options.publicKeys, {
          deviceId: this.options.deviceId, realm: this.options.realm,
          now: this.options.now?.() ?? Date.now(), minSequence: previous,
        });
        if (!lease) throw new Error('invalid signed transport lease');
        // Save before using the link to rule out accepting the same offer after app restart.
        await this.options.saveSequence(lease.sequence);
        if (abort.signal.aborted) return false;
        this.setState('connecting');
        await this.options.joiner.start(lease.joinLink, abort.signal);
        if (abort.signal.aborted || this.epoch !== epoch) {
          await this.options.joiner.stop().catch(() => {});
          return false;
        }
        this.setState('connected');
        return true;
      } catch {
        await this.options.joiner.stop().catch(() => {});
        if (this.epoch === epoch) this.setState('unavailable');
        return false;
      }
    })().finally(() => {
      if (this.epoch === epoch) this.abort = null;
      if (this.pending === attempt) this.pending = null;
    });
    this.pending = attempt;
    return attempt;
  }

  /** Stops any ongoing setup or active tunnel. No traffic is sent after shutdown. */
  async stop(): Promise<void> {
    ++this.epoch;
    this.abort?.abort();
    this.abort = null;
    this.setState('idle');
    // Give an in-flight native start a chance to observe abort; its finalizer
    // calls stop again if it resolves after cancellation.
    await this.options.joiner.stop().catch(() => {});
  }
}
