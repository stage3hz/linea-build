// A session bound to this device's key (server: devicebind.js).
//
// The session token on the disk is not enough for a bound session: every request also carries a «proof» — a random
// value the server hands out for ten minutes in exchange for a signature by the device's key (Secure Enclave,
// Android Keystore, the PC's TPM). The proof lives in memory only, never on the disk: a copied token, or the whole
// folder of the app, signs in nowhere else.
//
// This file is the app's side of that exchange, without any platform code (see deviceKey.ts for the keys):
//   challenge → (first time) bind the session to the key / (afterwards) sign the challenge → proof.
// An older server (no such routes) or a build without a key: nothing happens, the session works as before.

export type DeviceKey = {
  /** The public key (base64url of the 65-byte P-256 point) and where the private one lives. */
  ensure(): Promise<{ publicKey: string; kind: 'hardware' | 'software' }>;
  /** ECDSA P-256 / SHA-256 over the message's UTF-8 bytes, base64url. */
  sign(message: string): Promise<string>;
};
/** POST with the session token; rejects with an error that has `status` and `code` (ApiError) when the server says no. */
export type ProofPost = (path: string, body?: unknown) => Promise<any>;

/** `lost`: the session is bound to a key this device does not have — it cannot be used here any more (sign in again).
 *  `unavailable`: the key could not sign right now (the chip is busy, PowerShell failed): try again later. */
export class DeviceProofError extends Error {
  readonly reason: 'lost' | 'unavailable';
  constructor(reason: 'lost' | 'unavailable') { super(reason === 'lost' ? 'Сеанс привязан к другому устройству. Войди заново.' : 'Не удалось подтвердить устройство. Попробуй ещё раз.'); this.name = 'DeviceProofError'; this.reason = reason; }
}

/** Renew this long before the proof runs out. */
export const PROOF_MARGIN_MS = 90_000;
/** After a failed attempt the next request does not try again sooner than this. */
export const PROOF_RETRY_MS = 5_000;

const statusOf = (error: unknown) => (error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 0);
const codeOf = (error: unknown) => (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '');

export class DeviceProof {
  private proof: string | null = null;
  private until = 0;
  private busy: Promise<boolean> | null = null;
  /** Nothing to do for this session in this run: the server has no binding, or there is no key to bind with. */
  private off = false;
  private failedAt = -PROOF_RETRY_MS;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private issued = 0;

  private readonly key: () => DeviceKey | null;
  private readonly post: ProofPost;
  private readonly now: () => number;
  private readonly schedule: boolean;
  // (Plain fields, not parameter properties: the tests load this file with Node's type stripping.)
  constructor(key: () => DeviceKey | null, post: ProofPost, now: () => number = () => Date.now(), schedule = true) { this.key = key; this.post = post; this.now = now; this.schedule = schedule; }

  /** The proof to send with a request, or null. */
  get current(): string | null { return this.proof && this.until > this.now() ? this.proof : null; }
  /** Grows with every proof received: lets a refused request tell whether a newer proof has arrived since it left. */
  get generation(): number { return this.issued; }
  /** Whether a proof was ever held in this run: only then is the session known to need one. */
  get known(): boolean { return this.until > 0; }
  /** Whether a request should first wait for `refresh()`. */
  get due(): boolean { return !this.off && this.until - this.now() < PROOF_MARGIN_MS && this.now() - this.failedAt >= PROOF_RETRY_MS; }

  /**
   * Gets a proof (binding the session to the key first, if it has none). Resolves true when a proof is held, false
   * when this session does not use one. Rejects with DeviceProofError, or with the transport's own error.
   * `force`: the server has just refused the proof we hold. `seen`: the generation when the refused request was
   * sent — if a newer proof has arrived since (many requests were refused together), that one is used.
   */
  refresh(force = false, seen?: number): Promise<boolean> {
    if (this.busy) return this.busy;
    if (this.off) return Promise.resolve(false);
    if (force && seen !== undefined && seen !== this.issued && this.current) return Promise.resolve(true);
    if (!force && this.current && this.until - this.now() >= PROOF_MARGIN_MS) return Promise.resolve(true);
    const run: Promise<boolean> = this.exchange(true).then(result => result, error => { this.failedAt = this.now(); throw error; }).finally(() => { if (this.busy === run) this.busy = null; });
    this.busy = run;
    return run;
  }

  private async exchange(again: boolean): Promise<boolean> {
    const key = this.key();
    let challenge: { challenge: string; sessionId: string; bound: boolean };
    try { challenge = await this.post('/auth/device/challenge'); }
    catch (error) {
      // A server from before device binding: the session stays as it is.
      if (statusOf(error) === 404) { this.off = true; return false; }
      throw error;
    }
    if (!challenge || typeof challenge.challenge !== 'string' || typeof challenge.sessionId !== 'string') throw new DeviceProofError('unavailable');
    if (!challenge.bound) {
      // Not bound yet. Without a key (a browser, an older shell) it stays unbound.
      if (!key) { this.off = true; return false; }
      let own: { publicKey: string; kind: 'hardware' | 'software' }, signature: string;
      try { own = await key.ensure(); signature = await key.sign(`invizent-device-bind-v1\n${challenge.sessionId}\n${challenge.challenge}`); }
      catch { this.off = true; return false; } // no working key on this device: as before, by the token
      try { return this.take(await this.post('/auth/device/bind', { publicKey: own.publicKey, kind: own.kind, signature })); }
      catch (error) {
        // Bound a moment ago by another request of this app: prove it instead.
        if (again && (codeOf(error) === 'device_bound' || codeOf(error) === 'device_challenge')) return this.exchange(false);
        if (statusOf(error) === 400 || statusOf(error) === 403) { this.off = true; return false; }
        throw error;
      }
    }
    if (!key) throw new DeviceProofError('lost');
    let signature: string;
    try { signature = await key.sign(`invizent-device-proof-v1\n${challenge.sessionId}\n${challenge.challenge}`); }
    // «key changed»: the chip no longer holds the key the session was bound to (a cleared TPM) — not a passing failure.
    catch (error) { throw new DeviceProofError(/key changed/i.test(error instanceof Error ? error.message : '') ? 'lost' : 'unavailable'); }
    try { return this.take(await this.post('/auth/device/proof', { signature })); }
    catch (error) {
      if (codeOf(error) === 'device_signature') throw new DeviceProofError('lost');
      if (again && codeOf(error) === 'device_challenge') return this.exchange(false);
      throw error;
    }
  }

  private take(answer: { proof?: unknown; expiresIn?: unknown }): boolean {
    if (typeof answer?.proof !== 'string' || typeof answer.expiresIn !== 'number' || !(answer.expiresIn > 0)) throw new DeviceProofError('unavailable');
    this.proof = answer.proof;
    this.issued++;
    this.until = this.now() + answer.expiresIn * 1000;
    if (this.schedule) {
      if (this.timer) clearTimeout(this.timer);
      // Renewed by itself while the app runs, so a long upload or an open socket never meets an expired proof.
      this.timer = setTimeout(() => { this.timer = null; void this.refresh().catch(() => {}); }, Math.max(30_000, answer.expiresIn * 1000 - PROOF_MARGIN_MS - 30_000));
    }
    return true;
  }
}
