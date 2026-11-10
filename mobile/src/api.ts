import { desktopBridge } from './desktop';
import { Platform } from 'react-native';
import { toByteArray } from 'base64-js';
import type { UserProfile } from './types';
import { APP_VERSION, SERVER_URL, SIMULATOR_TEST_BUILD } from './serverConfig';
import { currentEndpoint, markServerOk, reportFailure } from './servers/pool';
import { networkTier, reportRequest, timeoutFor } from './network/quality';
import { attestHeaders } from './attest/index';
import { markUpdateRequired } from './update/store';
import { deviceFields, deviceInfo } from './deviceInfo';
import type { SessionDetails } from './sessionAlerts';
import type { Attachment, Chat, DeviceSession, LocalFile, Message, RecoveryChallenge, RecoveryRequest, RecoveryStatus, SecurityStatus, Session, User, UsernameStatus } from './types';
import type { ClaimedBundle, CryptoDevice, EncryptedMessage, PublicBundle } from './e2ee/types';
import type { ScheduledMessage } from './scheduled/model';
import type { PlainUploadState } from './media/plainUploadCore';

/** Progress and resume of a chunked plaintext upload (a channel file, a post or a story above 20 MB). */
export type PlainUploadExtras = { state?: PlainUploadState; onState?: (state: PlainUploadState) => void; onProgress?: (sent: number, total: number) => void; signal?: AbortSignal };

type ApiErrorDetails = { code?: string; received?: number; attemptsRemaining?: number; attemptsLeft?: number; retryAfterSeconds?: number; readyAt?: string; serverTime?: string; expiresAt?: string };
// «iPhone», «Pixel 8», «Windows», «Chrome»: the session name shown on every device (deviceInfo.ts).
const deviceName = deviceInfo().deviceName;
// Announce the real build to the server so retired versions can be turned away.
const clientPlatform = desktopBridge() ? 'windows' : Platform.OS;
export const CLIENT_HEADER = `invizent; v=${APP_VERSION}; p=${clientPlatform}`;

export type CallMode = 'everyone' | 'contacts' | 'allowed';
/** «Время захода»: Все / Мои контакты (friends) / Никто, as in Telegram. */
export type LastSeenMode = 'everyone' | 'contacts' | 'nobody';
/** `showLastSeen` is the old on/off switch (kept by the server for older apps); new code uses `lastSeen`. */
export type Privacy = { allowNewChats: boolean; showAvatar: boolean; readReceipts: boolean; showLastSeen?: boolean; lastSeen?: LastSeenMode; hideReadTime?: boolean; calls?: CallMode };
export type CallRules = { allow: User[]; deny: User[] };
/** «Всегда показывать» (allow) and «Никогда не показывать» (deny) for «Время захода». */
export type LastSeenRules = { allow: User[]; deny: User[] };
/** `platinaOnly`: settings that only an active Platina may switch off. */
export type PrivacyResponse = { privacy: Privacy; platinaOnly?: (keyof Privacy)[]; platina?: boolean };

export class ApiError extends Error {
  readonly code?: string;
  readonly attemptsRemaining?: number;
  /** Wrong sign-ins left before the 5-minute lock (server LOGIN_FAILED). */
  readonly attemptsLeft?: number;
  readonly retryAfterSeconds?: number;
  readonly readyAt?: string;
  readonly serverTime?: string;
  readonly expiresAt?: string;
  /** Chunked uploads: how many bytes the server already has (409 OFFSET_MISMATCH), to resume from there. */
  readonly received?: number;
  constructor(message: string, public status: number, details: ApiErrorDetails = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = typeof details.code === 'string' ? details.code : undefined;
    this.attemptsRemaining = typeof details.attemptsRemaining === 'number' && Number.isInteger(details.attemptsRemaining) && details.attemptsRemaining >= 0 && details.attemptsRemaining <= 3 ? details.attemptsRemaining : undefined;
    this.attemptsLeft = typeof details.attemptsLeft === 'number' && Number.isInteger(details.attemptsLeft) && details.attemptsLeft >= 0 && details.attemptsLeft <= 5 ? details.attemptsLeft : undefined;
    this.retryAfterSeconds = typeof details.retryAfterSeconds === 'number' && Number.isFinite(details.retryAfterSeconds) && details.retryAfterSeconds >= 0 ? details.retryAfterSeconds : undefined;
    this.readyAt = typeof details.readyAt === 'string' ? details.readyAt : undefined;
    this.serverTime = typeof details.serverTime === 'string' ? details.serverTime : undefined;
    this.expiresAt = typeof details.expiresAt === 'string' ? details.expiresAt : undefined;
    this.received = typeof details.received === 'number' && Number.isSafeInteger(details.received) && details.received >= 0 ? details.received : undefined;
  }
}

// AI media jobs run much longer than ordinary API calls (video up to ~5 minutes).
const AI_TIMEOUTS: Record<string, number> = { '/ai/chat': 70000, '/ai/image': 130000, '/ai/speech': 70000, '/ai/transcribe': 130000, '/ai/video': 340000, '/ai/models': 20000 };
// Ordinary limits grow on slow links (EDGE/3G), so a message is not cut off half-way.
function requestTimeout(path: string, method = 'GET') {
  if (AI_TIMEOUTS[path]) return AI_TIMEOUTS[path];
  const bare = path.split('?')[0];
  // One-request uploads and the chunks of big ones (PUT /uploads/sessions/…, /e2ee/uploads/…) get the upload time.
  // Sign-in, sign-up, recovery and secret changes hash up to three secrets with scrypt on the server and
  // queue behind other password jobs: under load an 18 s limit cut off a sign-up the server then completed,
  // and the retry met «Этот логин уже занят». Those POSTs get 45 s (×1.5 / ×3 on slow links).
  // The CI simulator build waits up to 4 min: on that runner the local server took 82 s for one sign-up
  // (scrypt starved by the simulator), measured by the test proxy. Release builds keep 45 s.
  if (method === 'POST' && /^\/auth\/(?:login|register|recovery\/(?:verify|reset)|password|confirmation-word|recovery-word)$/.test(bare)) return SIMULATOR_TEST_BUILD ? 240_000 : Math.round(45_000 * timeoutFor('read', networkTier()) / timeoutFor('read', 'fast'));
  const kind = bare === '/uploads' || bare === '/e2ee/files' || (method === 'PUT' && /^\/(?:e2ee\/)?uploads\//.test(bare)) ? 'upload' : method !== 'GET' && /\/messages(\?|$)/.test(path) ? 'send' : 'read';
  return timeoutFor(kind, networkTier());
}

/** No answer at all (as opposed to an error the server returned). */
export class NetworkError extends Error { constructor(message: string, readonly notDelivered = false) { super(message); this.name = 'NetworkError'; } }
/** The server did not answer in time: the request may or may not have arrived (only idempotent sends retry on it). */
/** No answer in time. A kind of NetworkError on purpose: a silent server (a typical block) still fails over
 *  to the next server and lets messages go by Mesh; only the text tells it apart from «no connection». */
export class RequestTimeoutError extends NetworkError { constructor(message: string) { super(message); this.name = 'TimeoutError'; } }

export class Api {
  /** `base` is the account's realm (fixed: keys and history on the device are tied to it). */
  constructor(public readonly base: string, public readonly token?: string) {}
  /** Where requests go now: for the main realm, the fastest live server from the pool. */
  get endpoint(): string { return this.pooled ? currentEndpoint() : this.base; }
  private get pooled() { return this.base.replace(/\/+$/, '') === SERVER_URL; }
  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const target = this.endpoint;
    try { return await this.requestOnce<T>(path, options, target); }
    catch (error) {
      if (!(error instanceof NetworkError) || !this.pooled) throw error;
      reportFailure(target);
      const method = (options.method || 'GET').toUpperCase();
      // Only reads are repeated on the next server automatically; writes have their own retries
      // (messages are idempotent by clientId) so nothing is ever done twice.
      if ((method === 'GET' || method === 'HEAD' || error.notDelivered) && this.endpoint !== target && !(options.body instanceof ReadableStream)) return this.requestOnce<T>(path, options, this.endpoint);
      throw error;
    }
  }
  private async requestOnce<T>(path: string, options: RequestInit, target: string): Promise<T> {
    const abort = new AbortController();
    const caller=options.signal;
    const cancel=()=>abort.abort();
    caller?.addEventListener('abort',cancel,{once:true});
    if(caller?.aborted)cancel();
    const timeoutMs=requestTimeout(path,(options.method||'GET').toUpperCase());const started=Date.now();
    // Our own timer, not the caller: React Native's fetch rejects an aborted request with a TypeError
    // («Network request failed»), not an AbortError, so the timeout was reported as «Нет связи с сервером».
    let timedOut=false;
    const timeout = setTimeout(()=>{timedOut=true;cancel();},timeoutMs);
    const abortError=()=>{const error=new Error('Запрос отменён.');error.name='AbortError';return error;};
    try {
      if(abort.signal.aborted)throw abortError();
      const headers: Record<string, string> = { 'X-Linea-Client': CLIENT_HEADER, ...attestHeaders(options.method || 'GET', path), ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) };
      const response = await fetch(target + path, { credentials: 'omit', cache: 'no-store', redirect: 'error', ...options, headers: { ...headers, ...(options.headers || {}) }, signal: abort.signal });
      const raw = await response.text().catch(() => '');
      let data: any = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
      if(abort.signal.aborted)throw abortError();
      if (response.status < 500) { markServerOk(); reportRequest(Date.now() - started, raw.length); }
      if (response.status === 426) markUpdateRequired();
      // 502/503/504 come from the proxy in front of a server that is down: the request never
      // reached Invizent itself, so it is safe to send it to the next server.
      if (response.status === 502 || response.status === 503 || response.status === 504) throw new NetworkError('Сервер недоступен.', true);
      if (!response.ok) throw new ApiError(typeof data.error === 'string' ? data.error : 'Не удалось выполнить запрос. Попробуй ещё раз.', response.status, data);
      return data as T;
    } catch (error) {
      if (error instanceof ApiError || error instanceof NetworkError) throw error;
      if(caller?.aborted)throw abortError();
      if (timedOut || (error instanceof Error && error.name === 'AbortError')) throw new RequestTimeoutError('Сервер не ответил вовремя. Проверь подключение.');
      throw new NetworkError('Нет связи с сервером. Проверь интернет и адрес подключения.');
    } finally { clearTimeout(timeout);caller?.removeEventListener('abort',cancel); }
  }
  /** Raw bytes of a successful response of the expected type (used for AI video). */
  async binary(path: string, options: RequestInit, expectedType: string): Promise<ArrayBuffer> {
    const abort = new AbortController(); const caller = options.signal;
    const cancel = () => abort.abort(); caller?.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; cancel(); }, requestTimeout(path));
    try {
      const response = await fetch(this.endpoint + path, { credentials: 'omit', cache: 'no-store', redirect: 'error', ...options, headers: { 'X-Linea-Client': CLIENT_HEADER, ...attestHeaders(options.method || 'GET', path), 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) }, signal: abort.signal });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new ApiError(typeof data.error === 'string' ? data.error : 'Не удалось выполнить запрос. Попробуй ещё раз.', response.status, data);
      }
      if ((response.headers.get('content-type') || '').split(';')[0].trim() !== expectedType) throw new Error('Сервер вернул файл неожиданного типа.');
      return await response.arrayBuffer();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (caller?.aborted) { const e = new Error('Запрос отменён.'); e.name = 'AbortError'; throw e; }
      if (timedOut || (error instanceof Error && error.name === 'AbortError')) throw new Error('Сервер не ответил вовремя. Попробуй ещё раз.');
      throw error instanceof Error ? error : new Error('Нет связи с сервером.');
    } finally { clearTimeout(timeout); caller?.removeEventListener('abort', cancel); }
  }
  health = () => this.request<{status: string}>('/health');
  me = () => this.request<{user: User; securitySetupRequired?: boolean}>('/me');
  login = (username: string, password: string, confirmationWord: string) => this.request<Session>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password, confirmationWord, ...deviceFields() }) });
  register = (username: string, password: string, displayName: string, confirmationWord: string, recoveryWord: string, publicUsername?: string) => this.request<Session>('/auth/register', { method: 'POST', body: JSON.stringify({ username, ...(publicUsername ? { publicUsername } : {}), password, displayName, confirmationWord, recoveryWord, ...deviceFields() }) });
  verifyRecovery = (username: string, recoveryWord: string) => this.request<RecoveryChallenge>('/auth/recovery/verify', { method: 'POST', body: JSON.stringify({ username, recoveryWord, deviceName }) });
  recoveryStatus = (resetToken: string) => this.request<RecoveryStatus>('/auth/recovery/status', { method: 'POST', body: JSON.stringify({ resetToken }) });
  resetPassword = (resetToken: string, newPassword: string) => this.request<{ok: true}>('/auth/recovery/reset', { method: 'POST', body: JSON.stringify({ resetToken, newPassword }) });
  recoveryRequests = () => this.request<{requests: RecoveryRequest[]}>('/auth/recovery/requests');
  cancelRecovery = (requestId: string) => this.request<{ok: true}>('/auth/recovery/cancel', { method: 'POST', body: JSON.stringify({ requestId }) });
  security = () => this.request<SecurityStatus>('/auth/security');
  changePassword = (currentPassword: string, newPassword: string, currentConfirmationWord?: string) => this.request<{ok: true}>('/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword, currentConfirmationWord }) });
  changeConfirmationWord = (currentPassword: string, confirmationWord: string, currentConfirmationWord?: string) => this.request<{ok: true}>('/auth/confirmation-word', { method: 'POST', body: JSON.stringify({ currentPassword, confirmationWord, currentConfirmationWord }) });
  changeRecoveryWord = (currentPassword: string, recoveryWord: string, currentConfirmationWord?: string) => this.request<{ok: true}>('/auth/recovery-word', { method: 'POST', body: JSON.stringify({ currentPassword, recoveryWord, currentConfirmationWord }) });
  /** Current device first; each with model, OS, app version and the sign-in address as text (F6). */
  sessions = () => this.request<{sessions: SessionDetails[]}>('/auth/sessions');
  revokeSession = (sessionId: string) => this.request<{ok: true}>('/auth/sessions/revoke', { method: 'POST', body: JSON.stringify({ sessionId }) });
  revokeOtherSessions = () => this.request<{ok: true}>('/auth/sessions/revoke-others', { method: 'POST', body: JSON.stringify({}) });
  registerCryptoDevice = (deviceId: string, bundle: PublicBundle) => this.request<{device: CryptoDevice; preKeyCount: number}>('/e2ee/devices', {method: 'POST', body: JSON.stringify({deviceId, deviceName, ...bundle})});
  cryptoDevices = (userId: string) => this.request<{devices: CryptoDevice[]}>(`/e2ee/devices?userId=${encodeURIComponent(userId)}`);
  ownCryptoDevices = () => this.request<{devices: CryptoDevice[]}>('/e2ee/devices/self');
  claimPreKey = (userId: string, deviceId: string) => this.request<{device: CryptoDevice; bundle: ClaimedBundle}>('/e2ee/prekeys/claim', {method: 'POST', body: JSON.stringify({userId, deviceId})});
  revokeCryptoDevice = (deviceId: string) => this.request<{ok: true}>('/e2ee/devices/revoke', {method: 'POST', body: JSON.stringify({deviceId})});
  cryptoInbox = (deviceId: string, chatId: string, after: number) => this.request<{messages: Message[]; nextCursor: number; hasMore: boolean}>(`/e2ee/inbox?lean=1&deviceId=${encodeURIComponent(deviceId)}&chatId=${encodeURIComponent(chatId)}&after=${after}&limit=100`);
  logout = () => this.request('/auth/logout', { method: 'POST' });
  chats = () => this.request<{chats: Chat[]}>('/chats?lean=1');
  users = (query: string) => this.request<{users: User[]}>(`/users?q=${encodeURIComponent(query)}`);
  createChat = (userId: string) => this.request<{chat: Chat}>('/chats', {method: 'POST', body: JSON.stringify({userId})});
  userProfile = (userId: string) => this.request<UserProfile>(`/users/${encodeURIComponent(userId)}`);
  // Profile posts and stories (friends only; a story lives 24 h).
  profilePosts = (userId: string) => this.request<ProfilePosts>(`/users/${encodeURIComponent(userId)}/posts`);
  publishPost = (uploadId: string, kind: 'post' | 'story', caption = '') => this.request<{post: ProfilePost}>('/me/posts', {method: 'POST', body: JSON.stringify({uploadId, kind, caption})});
  deletePost = (id: string) => this.request<{ok: true}>(`/me/posts/${encodeURIComponent(id)}`, {method: 'DELETE'});
  // The stories strip above the chat list: friends with a live story (unseen first) and my own stories.
  storiesFeed = () => this.request<StoriesFeed>('/stories/feed');
  /** Marks a story watched (idempotent; the server ignores the owner's own view). */
  viewStory = (id: string) => this.request<{ok: true; seen: true}>(`/stories/${encodeURIComponent(id)}/view`, {method: 'POST', body: '{}'});
  /** Who watched my story — the owner only. */
  storyViewers = (id: string) => this.request<StoryViewers>(`/stories/${encodeURIComponent(id)}/viewers`);
  // Gifts friends send each other, shown on the profile (friends only).
  profileGifts = (userId: string) => this.request<{visible: boolean; gifts: ProfileGift[]}>(`/users/${encodeURIComponent(userId)}/gifts`);
  sendGift = (userId: string, gift: string, message = '') => this.request<{gift: ProfileGift}>(`/users/${encodeURIComponent(userId)}/gifts`, {method: 'POST', body: JSON.stringify({gift, message})});
  removeGift = (id: string) => this.request<{ok: true}>(`/me/gifts/${encodeURIComponent(id)}`, {method: 'DELETE'});
  blocks = () => this.request<{users: User[]}>('/blocks');
  block = (userId: string) => this.request<{ok: true}>(`/blocks/${encodeURIComponent(userId)}`, {method: 'PUT'});
  unblock = (userId: string) => this.request<{ok: true}>(`/blocks/${encodeURIComponent(userId)}`, {method: 'DELETE'});
  report = (target: {userId?: string; communityId?: string}, reason: import('./types').ReportReason, comment = '') => this.request<{ok: true}>('/reports', {method: 'POST', body: JSON.stringify({...target, reason, ...(comment.trim() ? {comment: comment.trim()} : {})})});
  deleteAccount = (currentPassword: string, currentConfirmationWord: string) => this.request<{ok: true}>('/auth/delete-account', {method: 'POST', body: JSON.stringify({currentPassword, currentConfirmationWord})});
  contacts = () => this.request<{users: User[]}>('/contacts');
  /** Sends a friend request, or accepts the other person's one: status says which happened. */
  addContact = (userId: string) => this.request<{ok: true; status?: 'requested' | 'friends'}>(`/contacts/${encodeURIComponent(userId)}`, {method: 'PUT'});
  friendRequests = () => this.request<{incoming: import('./types').FriendRequest[]; outgoing: import('./types').FriendRequest[]}>('/friends/requests');
  acceptFriend = (userId: string) => this.request<{ok: true}>(`/friends/requests/${encodeURIComponent(userId)}/accept`, {method: 'POST'});
  /** Declines an incoming request or cancels our own. */
  dropFriendRequest = (userId: string) => this.request<{ok: true}>(`/friends/requests/${encodeURIComponent(userId)}`, {method: 'DELETE'});
  removeContact = (userId: string) => this.request<{ok: true}>(`/contacts/${encodeURIComponent(userId)}`, {method: 'DELETE'});
  /** muted: true = «Навсегда»; mutedUntil (ISO, in the future, up to a year) = «на время»; muted: false or mutedUntil: null = sound on. */
  chatSettings = (chatId: string, change: Partial<{pinned: boolean; archived: boolean; muted: boolean; mutedUntil: string | null}>) => this.request<{chat: Chat}>(`/chats/${encodeURIComponent(chatId)}/settings`, {method: 'PATCH', body: JSON.stringify(change)});
  messages = (chatId: string, before?: number) => this.request<{messages: Message[]; hasMore: boolean}>(`/chats/${encodeURIComponent(chatId)}/messages?lean=1&limit=${networkTier() === 'slow' ? 15 : networkTier() === 'medium' ? 30 : 50}${before ? `&before=${before}` : ''}`);
  /** push: what the recipient's phone shows ('call' rings, 'none' for reactions/edits); an older server without push gets no field. */
  private pushField = true;
  sendEncrypted = async (chatId: string, clientId: string, encrypted: EncryptedMessage, push?: 'message' | 'call' | 'none' | 'silent') => {
    // lean=1: the server does not echo our own (large) ciphertext back; we put it in from here.
    const post = async (withPush: boolean) => {
      const result = await this.request<{message: Message}>(`/chats/${encodeURIComponent(chatId)}/messages?lean=1`, {method: 'POST', body: JSON.stringify(withPush && push ? {clientId, encrypted, push} : {clientId, encrypted})});
      if (result?.message && !result.message.encrypted) result.message = { ...result.message, encrypted };
      return result;
    };
    if (!push || !this.pushField) return post(false);
    try { return await post(true); }
    catch (error) {
      if (error instanceof ApiError && error.status === 400 && /неизвестные поля/.test(error.message)) { this.pushField = false; return post(false); }
      // An older server knows no quiet push: the message still goes, with an ordinary notification.
      if (error instanceof ApiError && error.status === 400 && push === 'silent' && /вид уведомления/.test(error.message)) return post(false);
      throw error;
    }
  };
  // F4 «Отправить позже»: the same envelopes with `deliverAt`; the server keeps them (never decrypted) and releases them at that time.
  // A server without F4 answers 400 «неизвестные поля» (deliverAt) or 404 on /scheduled: remembered for the session, no more requests.
  private scheduledSupported = true;
  get supportsScheduled() { return this.scheduledSupported; }
  scheduleEncrypted = async (chatId: string, clientId: string, encrypted: EncryptedMessage, deliverAt: string, push?: 'silent') => {
    if (!this.scheduledSupported) throw new ApiError('Сервер не поддерживает отложенные сообщения.', 400, {code: 'SCHEDULE_UNSUPPORTED'});
    try { return await this.request<{scheduled: ScheduledMessage}>(`/chats/${encodeURIComponent(chatId)}/messages?lean=1`, {method: 'POST', body: JSON.stringify({clientId, encrypted, deliverAt, ...(push ? {push} : {})})}); }
    catch (error) {
      if (error instanceof ApiError && error.status === 400 && /неизвестные поля/.test(error.message)) { this.scheduledSupported = false; throw new ApiError('Сервер не поддерживает отложенные сообщения.', 400, {code: 'SCHEDULE_UNSUPPORTED'}); }
      throw error;
    }
  };
  /** Own scheduled items; the server releases whatever is due before answering. `lean`: ids, times and states without the ciphertext (the periodic refresh). */
  scheduled = async (options: {chatId?: string; lean?: boolean} = {}) => {
    if (!this.scheduledSupported) return {items: [] as ScheduledMessage[]};
    const query = [options.chatId ? `chatId=${encodeURIComponent(options.chatId)}` : '', options.lean ? 'lean=1' : ''].filter(Boolean).join('&');
    try { return await this.request<{items: ScheduledMessage[]}>(`/scheduled${query ? `?${query}` : ''}`); }
    catch (error) { if (error instanceof ApiError && error.status === 404 && !error.code) { this.scheduledSupported = false; return {items: [] as ScheduledMessage[]}; } throw error; }
  };
  deleteScheduled = (id: string) => this.request<{ok: true}>(`/scheduled/${encodeURIComponent(id)}`, {method: 'DELETE'});
  /** «Отправить сейчас»; 409 E2EE_DEVICES_CHANGED when the stored envelopes no longer fit the peer's devices (the app re-encrypts). */
  sendScheduledNow = (id: string) => this.request<{message: Message}>(`/scheduled/${encodeURIComponent(id)}/send?lean=1`, {method: 'POST'});
  /** android: FCM registration token; ios: APNs device token as hex. */
  registerPush = (token: string, platform: 'android' | 'ios') => this.request<{ok: true; enabled: boolean}>('/me/push', {method: 'PUT', body: JSON.stringify({token, platform})});
  unregisterPush = () => this.request<{ok: true}>('/me/push', {method: 'DELETE'});
  read = (chatId: string, messageId: number) => this.request<{ok: boolean; lastReadMessageId: number}>(`/chats/${encodeURIComponent(chatId)}/read`, {method: 'POST', body: JSON.stringify({messageId})});
  privacy = () => this.request<PrivacyResponse>('/me/privacy');
  updatePrivacy = (change: Partial<Privacy>) => this.request<PrivacyResponse>('/me/privacy', {method: 'PATCH', body: JSON.stringify(change)});
  lastSeenRules = () => this.request<LastSeenRules>('/me/last-seen-rules');
  setLastSeenRule = (userId: string, rule: 'allow' | 'deny') => this.request<LastSeenRules>(`/me/last-seen-rules/${encodeURIComponent(userId)}`, {method: 'PUT', body: JSON.stringify({rule})});
  removeLastSeenRule = (userId: string) => this.request<LastSeenRules>(`/me/last-seen-rules/${encodeURIComponent(userId)}`, {method: 'DELETE'});
  callRules = () => this.request<CallRules>('/me/call-rules');
  setCallRule = (userId: string, rule: 'allow' | 'deny') => this.request<CallRules>(`/me/call-rules/${encodeURIComponent(userId)}`, {method: 'PUT', body: JSON.stringify({rule})});
  removeCallRule = (userId: string) => this.request<CallRules>(`/me/call-rules/${encodeURIComponent(userId)}`, {method: 'DELETE'});
  /** outgoing: may I call them; incoming: may they call me. */
  callPermission = (userId: string, direction: 'outgoing' | 'incoming' = 'outgoing') => this.request<{allowed: boolean}>(`/calls/permission/${encodeURIComponent(userId)}${direction === 'incoming' ? '?direction=incoming' : ''}`);
  profile = (fields: Partial<Pick<User, 'displayName'|'bio'|'birthday'|'gender'|'avatarColor'|'avatarId'|'avatarVideoId'|'avatarFrame'|'bannerId'|'bannerPreset'|'profileEffect'|'nameplate'|'profilePattern'>>) => this.request<{user: User}>('/me', {method: 'PATCH', body: JSON.stringify(fields)});
  changeLoginName = (newLogin: string, currentPassword: string, currentConfirmationWord?: string) => this.request<{ok: true; loginName: string}>('/auth/login-name', { method: 'POST', body: JSON.stringify({ newLogin, currentPassword, currentConfirmationWord }) });
  callIce = () => this.request<{iceServers: {urls: string[]; username?: string; credential?: string}[]; ttl: number}>('/calls/ice');
  usernameStatus = () => this.request<UsernameStatus>('/me/username');
  changeUsername = (username:string) => this.request<{user:User;status:UsernameStatus}>('/me/username',{method:'PATCH',body:JSON.stringify({username})});
  changeStatusEmoji = (statusEmoji:string|null) => this.request<{user:User;status:UsernameStatus}>('/me/status-emoji',{method:'PATCH',body:JSON.stringify({statusEmoji})});
  fileUrl = (id: string) => `${this.endpoint}/files/${encodeURIComponent(id)}`;
  socketUrl = () => this.endpoint.replace(/^http/, 'ws') + '/ws';

  // Communities (game servers and blog channels). Not end-to-end encrypted by design.
  communities = () => this.request<{communities: import('./communities/types').CommunitySummary[]}>('/communities');
  createCommunity = (fields: {kind: 'server'|'blog'; name: string; description?: string; avatarId?: string|null; category?: string}) => this.request<{community: import('./communities/types').Community}>('/communities', {method: 'POST', body: JSON.stringify(fields)});
  community = (id: string) => this.request<{community: import('./communities/types').Community}>(`/communities/${encodeURIComponent(id)}`);
  updateCommunity = (id: string, fields: {name?: string; description?: string; avatarId?: string|null; category?: string; closed?: boolean}) => this.request<{community: import('./communities/types').Community}>(`/communities/${encodeURIComponent(id)}`, {method: 'PATCH', body: JSON.stringify(fields)});
  /** Deletes a private chat with all messages for both participants. */
  deleteChatForEveryone = (chatId: string) => this.request<{ok: true}>(`/chats/${encodeURIComponent(chatId)}`, {method: 'DELETE'});
  /** When the peer read my message (null + reason when unread, older than 7 days or hidden by privacy). */
  readDate = (chatId: string, messageId: number) => this.request<{readAt: string|null; reason?: 'unread'|'old'|'hidden'|'unknown'}>(`/chats/${encodeURIComponent(chatId)}/messages/${messageId}/read-date`);
  /** Marks a channel read; an older server without per-channel marks gets the community-wide one. */
  readChannel = async (communityId: string, channelId: string, lastReadId: number) => {
    try { return await this.request<{unread: number; mentions: number}>(`/communities/${encodeURIComponent(communityId)}/channels/${encodeURIComponent(channelId)}/read`, {method: 'POST', body: JSON.stringify({lastReadId})}); }
    catch (e) { if ((e as {status?: number})?.status === 404) { await this.communityMe(communityId, {lastReadId}); return null; } throw e; }
  };
  communityMe = (id: string, fields: {muted?: boolean; lastReadId?: number}) => this.request<{community: import('./communities/types').CommunitySummary}>(`/communities/${encodeURIComponent(id)}/me`, {method: 'PATCH', body: JSON.stringify(fields)});
  deleteCommunity = (id: string) => this.request<{ok: true}>(`/communities/${encodeURIComponent(id)}`, {method: 'DELETE'});
  leaveCommunity = (id: string) => this.request<{ok: true}>(`/communities/${encodeURIComponent(id)}/leave`, {method: 'POST', body: '{}'});
  communityMembers = (id: string) => this.request<{members: import('./communities/types').CommunityMember[]}>(`/communities/${encodeURIComponent(id)}/members`);
  banMember = (id: string, userId: string, reason?: string) => this.request<{ok: true}>(`/communities/${encodeURIComponent(id)}/bans/${encodeURIComponent(userId)}`, {method: 'PUT', body: JSON.stringify(reason ? {reason} : {})});
  unbanMember = (id: string, userId: string) => this.request<{ok: true}>(`/communities/${encodeURIComponent(id)}/bans/${encodeURIComponent(userId)}`, {method: 'DELETE'});
  communityBans = (id: string) => this.request<{bans: {user: import('./types').User; reason: string; createdAt: string}[]}>(`/communities/${encodeURIComponent(id)}/bans`);
  setMemberVoice = (id: string, userId: string, flags: {muted?: boolean; deafened?: boolean}) => this.request<{ok: true; serverMuted: boolean; serverDeafened: boolean}>(`/communities/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}/voice`, {method: 'PUT', body: JSON.stringify(flags)});
  kickMember = (id: string, userId: string) => this.request<{ok: true}>(`/communities/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, {method: 'DELETE'});
  setMemberRoles = (id: string, userId: string, roleIds: string[]) => this.request<{roleIds: string[]}>(`/communities/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}/roles`, {method: 'PUT', body: JSON.stringify({roleIds})});
  createRole = (id: string, fields: {name?: string; color?: string; perms?: number}) => this.request<{role: import('./communities/types').CommunityRole}>(`/communities/${encodeURIComponent(id)}/roles`, {method: 'POST', body: JSON.stringify(fields)});
  updateRole = (id: string, roleId: string, fields: {name?: string; color?: string; perms?: number}) => this.request<{role: import('./communities/types').CommunityRole}>(`/communities/${encodeURIComponent(id)}/roles/${encodeURIComponent(roleId)}`, {method: 'PATCH', body: JSON.stringify(fields)});
  deleteRole = (id: string, roleId: string) => this.request<{ok: true}>(`/communities/${encodeURIComponent(id)}/roles/${encodeURIComponent(roleId)}`, {method: 'DELETE'});
  createChannel = (id: string, fields: {kind: 'text'|'voice'; name: string; topic?: string; category?: string; roleIds?: string[]}) => this.request<{channel: import('./communities/types').CommunityChannel}>(`/communities/${encodeURIComponent(id)}/channels`, {method: 'POST', body: JSON.stringify(fields)});
  updateChannel = (id: string, channelId: string, fields: {name?: string; topic?: string; category?: string; roleIds?: string[]}) => this.request<{channel: import('./communities/types').CommunityChannel}>(`/communities/${encodeURIComponent(id)}/channels/${encodeURIComponent(channelId)}`, {method: 'PATCH', body: JSON.stringify(fields)});
  deleteChannel = (id: string, channelId: string) => this.request<{ok: true}>(`/communities/${encodeURIComponent(id)}/channels/${encodeURIComponent(channelId)}`, {method: 'DELETE'});
  channelMessages = (id: string, channelId: string, before?: number) => this.request<{messages: import('./communities/types').CommunityMessage[]; users: User[]; hasMore: boolean}>(`/communities/${encodeURIComponent(id)}/channels/${encodeURIComponent(channelId)}/messages${before ? `?before=${before}` : ''}`);
  /** `clientKey` (≤ 64 chars) makes the send idempotent: the same key from the same sender returns the message already stored. */
  sendChannelMessage = (id: string, channelId: string, fields: {text?: string; attachmentId?: string; replyTo?: number; clientKey?: string}) => this.request<{message: import('./communities/types').CommunityMessage}>(`/communities/${encodeURIComponent(id)}/channels/${encodeURIComponent(channelId)}/messages`, {method: 'POST', body: JSON.stringify(fields)});
  editChannelMessage = (id: string, channelId: string, messageId: number, text: string) => this.request<{message: import('./communities/types').CommunityMessage}>(`/communities/${encodeURIComponent(id)}/channels/${encodeURIComponent(channelId)}/messages/${messageId}`, {method: 'PATCH', body: JSON.stringify({text})});
  reactChannelMessage = (id: string, channelId: string, messageId: number, emoji: string) => this.request<{message: import('./communities/types').CommunityMessage}>(`/communities/${encodeURIComponent(id)}/channels/${encodeURIComponent(channelId)}/messages/${messageId}/reactions`, {method: 'POST', body: JSON.stringify({emoji})});
  deleteChannelMessage = (id: string, channelId: string, messageId: number) => this.request<{ok: true}>(`/communities/${encodeURIComponent(id)}/channels/${encodeURIComponent(channelId)}/messages/${messageId}`, {method: 'DELETE'});
  createInvite = (id: string) => this.request<{invite: {code: string}}>(`/communities/${encodeURIComponent(id)}/invites`, {method: 'POST', body: '{}'});
  invite = (code: string) => this.request<import('./communities/types').InvitePreview>(`/invites/${encodeURIComponent(code)}`);
  acceptInvite = (code: string) => this.request<{community: import('./communities/types').Community}>(`/invites/${encodeURIComponent(code)}/accept`, {method: 'POST', body: '{}'});
  inviteUrl = (code: string) => `${this.base}/i/${encodeURIComponent(code)}`;
  /**
   * A file for a channel: metadata is cleaned like any upload, but the file is stored as is (no E2EE). Never refused
   * for its size below the account limits: above 20 MB it is cleaned by the streamed cleaner and sent in resumable chunks.
   */
  async uploadChannelFile(file: LocalFile, options: PlainUploadExtras = {}): Promise<Attachment> {
    if(Platform.OS==='web'&&!desktopBridge())throw new Error('Файлы в каналах отправляются из приложения Android/iPhone.');
    return this.uploadPlain(file,'channel',options);
  }

  /**
   * A profile file. `purpose: 'post'` — a post or a story (photo or MP4/MOV of any size up to the account limits, sent in
   * chunks above 20 MB); without it — the avatar, the banner, a community picture, which keep their small limits.
   */
  async upload(file: LocalFile, options: PlainUploadExtras & {purpose?: 'post'} = {}): Promise<Attachment> {
    if(Platform.OS==='web'&&!desktopBridge())throw new Error('Обработка и загрузка фото профиля доступны в приложении Android/iPhone.');
    if(options.purpose==='post')return this.uploadPlain(file,'post',options);
    if((file.size||0)>20*1024*1024&&!(await import('./photo/formats')).isPhotoCandidate(file))throw new Error('Для профиля подойдёт видео или файл до 20 МБ.');
    const {prepareMediaForUpload}=await import('./media/pipeline');
    const prepared=await prepareMediaForUpload(file);
    try{
      const clean=prepared.file;
      if(clean.size&&clean.size>20*1024*1024)throw new Error('Файл слишком большой. Максимум — 20 МБ.');
      return await this.sendMultipart(clean,'/uploads');
    }finally{await prepared.dispose().catch(()=>{});}
  }

  /**
   * Channel files, posts and stories. Up to 20 MB: the usual pipeline cleans the file and it goes in one request. Bigger
   * (or media the pipeline cannot take, or content it did not recognise as media but the streamed sniffing does): the
   * streamed cleaner, chunked and resumable. A photo above 20 MB is re-encoded by the pipeline as before.
   */
  private async uploadPlain(file: LocalFile, purpose: 'channel'|'post', options: PlainUploadExtras): Promise<Attachment> {
    const plain=await import('./media/plainUpload');
    // A caller that does not keep the state for a later resume gets the server's reservation freed on failure.
    const large=async()=>{
      let state=options.state;
      try{return await plain.uploadPlainLarge(this,file,{purpose,...options,onState:next=>{state=next;options.onState?.(next);}});}
      catch(error){if(!options.onState)await plain.cancelPlainUpload(this,state);throw error;}
    };
    const {isPhotoCandidate}=await import('./photo/formats');
    // The real size (content:// included) decides, not only what the picker reported.
    const size=(await import('./e2ee/attachments')).localFileSize(file);
    if(size>plain.SMALL_UPLOAD&&!isPhotoCandidate(file))return large();
    const {prepareMediaForUpload}=await import('./media/pipeline');
    let prepared:import('./media/pipeline').PreparedMedia;
    try{prepared=await prepareMediaForUpload(file);}
    catch(error){if(await plain.streamRouteNeeded(file).catch(()=>false))return large();throw error;}
    try{
      const clean=prepared.file,big=(clean.size||0)>plain.SMALL_UPLOAD,path=purpose==='channel'?'/uploads?purpose=channel':'/uploads?purpose=post';
      if(prepared.photo){if(big)throw new Error('Не удалось уменьшить фото до 20 МБ.');return await this.sendMultipart(clean,path);}
      if(!big&&(prepared.video||clean.mimeType==='image/gif'||!(await plain.streamRouteNeeded(file).catch(()=>false))))return await this.sendMultipart(clean,path);
    }finally{await prepared.dispose().catch(()=>{});}
    return large();
  }

  private async sendMultipart(clean: LocalFile, path: string): Promise<Attachment> {
    const FileSystem=await import('expo-file-system/legacy');
    const bytes=toByteArray(await FileSystem.readAsStringAsync(clean.uri,{encoding:FileSystem.EncodingType.Base64}));
    const part=multipartFile(bytes,clean.name,clean.mimeType);
    return (await this.request<{attachment:Attachment}>(path,{method:'POST',body:part.body as unknown as BodyInit,headers:{'Content-Type':part.contentType}})).attachment;
  }

}

/**
 * Builds a one-file multipart/form-data body in memory. Expo's fetch (the global
 * fetch on iOS and Android since SDK 52+) rejects React Native's {uri,name,type}
 * FormData parts, which surfaced as «Нет связи с сервером» on every upload.
 */
export function multipartFile(bytes: Uint8Array, filename: string, mimeType: string): { body: Uint8Array; contentType: string } {
  const boundary = `----invizent${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const safeName = filename.replace(/["\\\r\n]/g, '_').slice(0, 200) || 'file';
  const safeType = /^[\w.+-]+\/[\w.+-]+$/.test(mimeType) ? mimeType : 'application/octet-stream';
  const head = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${safeType}\r\n\r\n`);
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** `views`: how many people watched a story (the owner only); `seen`: whether I have watched it (a friend's story). */
export type ProfilePost = { id: string; kind: 'post' | 'story'; caption: string; createdAt: string; expiresAt: string | null; media: { id: string; mimeType: string; isImage: boolean; isVideo: boolean; size: number }; views?: number; seen?: boolean };
export type ProfilePosts = { visible: boolean; posts: ProfilePost[]; stories: ProfilePost[] };
/** One friend in the stories strip: their live stories oldest first, and how many I have not seen. */
export type StoryFeedItem = { user: User; stories: ProfilePost[]; unseen: number };
export type StoriesFeed = { items: StoryFeedItem[]; mine: ProfilePost[] };
export type StoryViewers = { count: number; viewers: { user: User; viewedAt: string }[] };
export type ProfileGift = { id: string; gift: string; message: string; createdAt: string; sender: { id: string; username: string; displayName: string; avatarColor: string } | null };
