import { Platform } from 'react-native';
import { toByteArray } from 'base64-js';
import type { UserProfile } from './types';
import type { Attachment, Chat, DeviceSession, LocalFile, Message, RecoveryChallenge, RecoveryRequest, RecoveryStatus, SecurityStatus, Session, User, UsernameStatus } from './types';
import type { ClaimedBundle, CryptoDevice, EncryptedMessage, PublicBundle } from './e2ee/types';

type ApiErrorDetails = { code?: string; attemptsRemaining?: number; retryAfterSeconds?: number; readyAt?: string; serverTime?: string; expiresAt?: string };
const deviceName = Platform.OS === 'ios' ? 'iPhone / iPad' : Platform.OS === 'android' ? 'Android' : 'Браузер';

export type Privacy = { allowNewChats: boolean; showAvatar: boolean; readReceipts: boolean; showLastSeen?: boolean };
/** `platinaOnly`: settings that only an active Platina may switch off. */
export type PrivacyResponse = { privacy: Privacy; platinaOnly?: (keyof Privacy)[]; platina?: boolean };

export class ApiError extends Error {
  readonly code?: string;
  readonly attemptsRemaining?: number;
  readonly retryAfterSeconds?: number;
  readonly readyAt?: string;
  readonly serverTime?: string;
  readonly expiresAt?: string;
  constructor(message: string, public status: number, details: ApiErrorDetails = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = typeof details.code === 'string' ? details.code : undefined;
    this.attemptsRemaining = typeof details.attemptsRemaining === 'number' && Number.isInteger(details.attemptsRemaining) && details.attemptsRemaining >= 0 && details.attemptsRemaining <= 3 ? details.attemptsRemaining : undefined;
    this.retryAfterSeconds = typeof details.retryAfterSeconds === 'number' && Number.isFinite(details.retryAfterSeconds) && details.retryAfterSeconds >= 0 ? details.retryAfterSeconds : undefined;
    this.readyAt = typeof details.readyAt === 'string' ? details.readyAt : undefined;
    this.serverTime = typeof details.serverTime === 'string' ? details.serverTime : undefined;
    this.expiresAt = typeof details.expiresAt === 'string' ? details.expiresAt : undefined;
  }
}

// AI media jobs run much longer than ordinary API calls (video up to ~5 minutes).
const AI_TIMEOUTS: Record<string, number> = { '/ai/chat': 70000, '/ai/image': 130000, '/ai/speech': 70000, '/ai/transcribe': 130000, '/ai/video': 340000, '/ai/models': 20000 };
function requestTimeout(path: string) { return AI_TIMEOUTS[path] ?? (path === '/uploads' || path === '/e2ee/files' ? 120000 : 18000); }

export class Api {
  constructor(public readonly base: string, public readonly token?: string) {}
  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const abort = new AbortController();
    const caller=options.signal;
    const cancel=()=>abort.abort();
    caller?.addEventListener('abort',cancel,{once:true});
    if(caller?.aborted)cancel();
    const timeoutMs=requestTimeout(path);
    const timeout = setTimeout(cancel,timeoutMs);
    const abortError=()=>{const error=new Error('Запрос отменён.');error.name='AbortError';return error;};
    try {
      if(abort.signal.aborted)throw abortError();
      const headers: Record<string, string> = { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) };
      const response = await fetch(this.base + path, { credentials: 'omit', cache: 'no-store', redirect: 'error', ...options, headers: { ...headers, ...(options.headers || {}) }, signal: abort.signal });
      const data = await response.json().catch(() => ({}));
      if(abort.signal.aborted)throw abortError();
      if (!response.ok) throw new ApiError(typeof data.error === 'string' ? data.error : 'Не удалось выполнить запрос. Попробуй ещё раз.', response.status, data);
      return data as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if(caller?.aborted)throw abortError();
      if (error instanceof Error && error.name === 'AbortError') throw new Error('Сервер не ответил вовремя. Проверь подключение.');
      throw new Error('Нет связи с сервером. Проверь интернет и адрес подключения.');
    } finally { clearTimeout(timeout);caller?.removeEventListener('abort',cancel); }
  }
  /** Raw bytes of a successful response of the expected type (used for AI video). */
  async binary(path: string, options: RequestInit, expectedType: string): Promise<ArrayBuffer> {
    const abort = new AbortController(); const caller = options.signal;
    const cancel = () => abort.abort(); caller?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(cancel, requestTimeout(path));
    try {
      const response = await fetch(this.base + path, { credentials: 'omit', cache: 'no-store', redirect: 'error', ...options, headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) }, signal: abort.signal });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new ApiError(typeof data.error === 'string' ? data.error : 'Не удалось выполнить запрос. Попробуй ещё раз.', response.status, data);
      }
      if ((response.headers.get('content-type') || '').split(';')[0].trim() !== expectedType) throw new Error('Сервер вернул файл неожиданного типа.');
      return await response.arrayBuffer();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (caller?.aborted) { const e = new Error('Запрос отменён.'); e.name = 'AbortError'; throw e; }
      if (error instanceof Error && error.name === 'AbortError') throw new Error('Сервер не ответил вовремя. Попробуй ещё раз.');
      throw error instanceof Error ? error : new Error('Нет связи с сервером.');
    } finally { clearTimeout(timeout); caller?.removeEventListener('abort', cancel); }
  }
  health = () => this.request<{status: string}>('/health');
  me = () => this.request<{user: User; securitySetupRequired?: boolean}>('/me');
  login = (username: string, password: string, confirmationWord: string) => this.request<Session>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password, confirmationWord, deviceName }) });
  register = (username: string, password: string, displayName: string, confirmationWord: string, recoveryWord: string) => this.request<Session>('/auth/register', { method: 'POST', body: JSON.stringify({ username, password, displayName, confirmationWord, recoveryWord, deviceName }) });
  verifyRecovery = (username: string, recoveryWord: string) => this.request<RecoveryChallenge>('/auth/recovery/verify', { method: 'POST', body: JSON.stringify({ username, recoveryWord, deviceName }) });
  recoveryStatus = (resetToken: string) => this.request<RecoveryStatus>('/auth/recovery/status', { method: 'POST', body: JSON.stringify({ resetToken }) });
  resetPassword = (resetToken: string, newPassword: string) => this.request<{ok: true}>('/auth/recovery/reset', { method: 'POST', body: JSON.stringify({ resetToken, newPassword }) });
  recoveryRequests = () => this.request<{requests: RecoveryRequest[]}>('/auth/recovery/requests');
  cancelRecovery = (requestId: string) => this.request<{ok: true}>('/auth/recovery/cancel', { method: 'POST', body: JSON.stringify({ requestId }) });
  security = () => this.request<SecurityStatus>('/auth/security');
  changePassword = (currentPassword: string, newPassword: string, currentConfirmationWord?: string) => this.request<{ok: true}>('/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword, currentConfirmationWord }) });
  changeConfirmationWord = (currentPassword: string, confirmationWord: string, currentConfirmationWord?: string) => this.request<{ok: true}>('/auth/confirmation-word', { method: 'POST', body: JSON.stringify({ currentPassword, confirmationWord, currentConfirmationWord }) });
  changeRecoveryWord = (currentPassword: string, recoveryWord: string, currentConfirmationWord?: string) => this.request<{ok: true}>('/auth/recovery-word', { method: 'POST', body: JSON.stringify({ currentPassword, recoveryWord, currentConfirmationWord }) });
  sessions = () => this.request<{sessions: DeviceSession[]}>('/auth/sessions');
  revokeSession = (sessionId: string) => this.request<{ok: true}>('/auth/sessions/revoke', { method: 'POST', body: JSON.stringify({ sessionId }) });
  revokeOtherSessions = () => this.request<{ok: true}>('/auth/sessions/revoke-others', { method: 'POST', body: JSON.stringify({}) });
  registerCryptoDevice = (deviceId: string, bundle: PublicBundle) => this.request<{device: CryptoDevice; preKeyCount: number}>('/e2ee/devices', {method: 'POST', body: JSON.stringify({deviceId, deviceName, ...bundle})});
  cryptoDevices = (userId: string) => this.request<{devices: CryptoDevice[]}>(`/e2ee/devices?userId=${encodeURIComponent(userId)}`);
  ownCryptoDevices = () => this.request<{devices: CryptoDevice[]}>('/e2ee/devices/self');
  claimPreKey = (userId: string, deviceId: string) => this.request<{device: CryptoDevice; bundle: ClaimedBundle}>('/e2ee/prekeys/claim', {method: 'POST', body: JSON.stringify({userId, deviceId})});
  revokeCryptoDevice = (deviceId: string) => this.request<{ok: true}>('/e2ee/devices/revoke', {method: 'POST', body: JSON.stringify({deviceId})});
  cryptoInbox = (deviceId: string, chatId: string, after: number) => this.request<{messages: Message[]; nextCursor: number; hasMore: boolean}>(`/e2ee/inbox?deviceId=${encodeURIComponent(deviceId)}&chatId=${encodeURIComponent(chatId)}&after=${after}&limit=100`);
  logout = () => this.request('/auth/logout', { method: 'POST' });
  chats = () => this.request<{chats: Chat[]}>('/chats');
  users = (query: string) => this.request<{users: User[]}>(`/users?q=${encodeURIComponent(query)}`);
  createChat = (userId: string) => this.request<{chat: Chat}>('/chats', {method: 'POST', body: JSON.stringify({userId})});
  userProfile = (userId: string) => this.request<UserProfile>(`/users/${encodeURIComponent(userId)}`);
  contacts = () => this.request<{users: User[]}>('/contacts');
  addContact = (userId: string) => this.request<{ok: true}>(`/contacts/${encodeURIComponent(userId)}`, {method: 'PUT'});
  removeContact = (userId: string) => this.request<{ok: true}>(`/contacts/${encodeURIComponent(userId)}`, {method: 'DELETE'});
  chatSettings = (chatId: string, change: Partial<{pinned: boolean; archived: boolean; muted: boolean}>) => this.request<{chat: Chat}>(`/chats/${encodeURIComponent(chatId)}/settings`, {method: 'PATCH', body: JSON.stringify(change)});
  messages = (chatId: string, before?: number) => this.request<{messages: Message[]; hasMore: boolean}>(`/chats/${encodeURIComponent(chatId)}/messages?limit=50${before ? `&before=${before}` : ''}`);
  sendEncrypted = (chatId: string, clientId: string, encrypted: EncryptedMessage) => this.request<{message: Message}>(`/chats/${encodeURIComponent(chatId)}/messages`, {method: 'POST', body: JSON.stringify({clientId, encrypted})});
  read = (chatId: string, messageId: number) => this.request<{ok: boolean; lastReadMessageId: number}>(`/chats/${encodeURIComponent(chatId)}/read`, {method: 'POST', body: JSON.stringify({messageId})});
  privacy = () => this.request<PrivacyResponse>('/me/privacy');
  updatePrivacy = (change: Partial<Privacy>) => this.request<PrivacyResponse>('/me/privacy', {method: 'PATCH', body: JSON.stringify(change)});
  profile = (fields: Partial<Pick<User, 'displayName'|'bio'|'avatarColor'|'avatarId'|'avatarVideoId'|'avatarFrame'|'bannerId'|'bannerPreset'>>) => this.request<{user: User}>('/me', {method: 'PATCH', body: JSON.stringify(fields)});
  changeLoginName = (newLogin: string, currentPassword: string, currentConfirmationWord?: string) => this.request<{ok: true; loginName: string}>('/auth/login-name', { method: 'POST', body: JSON.stringify({ newLogin, currentPassword, currentConfirmationWord }) });
  callIce = () => this.request<{iceServers: {urls: string[]; username?: string; credential?: string}[]; ttl: number}>('/calls/ice');
  usernameStatus = () => this.request<UsernameStatus>('/me/username');
  changeUsername = (username:string) => this.request<{user:User;status:UsernameStatus}>('/me/username',{method:'PATCH',body:JSON.stringify({username})});
  changeStatusEmoji = (statusEmoji:string|null) => this.request<{user:User;status:UsernameStatus}>('/me/status-emoji',{method:'PATCH',body:JSON.stringify({statusEmoji})});
  fileUrl = (id: string) => `${this.base}/files/${encodeURIComponent(id)}`;
  socketUrl = () => this.base.replace(/^http/, 'ws') + '/ws';

  // Communities (game servers and blog channels). Not end-to-end encrypted by design.
  communities = () => this.request<{communities: import('./communities/types').CommunitySummary[]}>('/communities');
  createCommunity = (fields: {kind: 'server'|'blog'; name: string; description?: string; avatarId?: string|null; category?: string}) => this.request<{community: import('./communities/types').Community}>('/communities', {method: 'POST', body: JSON.stringify(fields)});
  community = (id: string) => this.request<{community: import('./communities/types').Community}>(`/communities/${encodeURIComponent(id)}`);
  updateCommunity = (id: string, fields: {name?: string; description?: string; avatarId?: string|null; category?: string}) => this.request<{community: import('./communities/types').Community}>(`/communities/${encodeURIComponent(id)}`, {method: 'PATCH', body: JSON.stringify(fields)});
  communityMe = (id: string, fields: {muted?: boolean; lastReadId?: number}) => this.request<{community: import('./communities/types').CommunitySummary}>(`/communities/${encodeURIComponent(id)}/me`, {method: 'PATCH', body: JSON.stringify(fields)});
  deleteCommunity = (id: string) => this.request<{ok: true}>(`/communities/${encodeURIComponent(id)}`, {method: 'DELETE'});
  leaveCommunity = (id: string) => this.request<{ok: true}>(`/communities/${encodeURIComponent(id)}/leave`, {method: 'POST', body: '{}'});
  communityMembers = (id: string) => this.request<{members: import('./communities/types').CommunityMember[]}>(`/communities/${encodeURIComponent(id)}/members`);
  kickMember = (id: string, userId: string) => this.request<{ok: true}>(`/communities/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, {method: 'DELETE'});
  setMemberRoles = (id: string, userId: string, roleIds: string[]) => this.request<{roleIds: string[]}>(`/communities/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}/roles`, {method: 'PUT', body: JSON.stringify({roleIds})});
  createRole = (id: string, fields: {name?: string; color?: string; perms?: number}) => this.request<{role: import('./communities/types').CommunityRole}>(`/communities/${encodeURIComponent(id)}/roles`, {method: 'POST', body: JSON.stringify(fields)});
  updateRole = (id: string, roleId: string, fields: {name?: string; color?: string; perms?: number}) => this.request<{role: import('./communities/types').CommunityRole}>(`/communities/${encodeURIComponent(id)}/roles/${encodeURIComponent(roleId)}`, {method: 'PATCH', body: JSON.stringify(fields)});
  deleteRole = (id: string, roleId: string) => this.request<{ok: true}>(`/communities/${encodeURIComponent(id)}/roles/${encodeURIComponent(roleId)}`, {method: 'DELETE'});
  createChannel = (id: string, fields: {kind: 'text'|'voice'; name: string; topic?: string; category?: string; roleIds?: string[]}) => this.request<{channel: import('./communities/types').CommunityChannel}>(`/communities/${encodeURIComponent(id)}/channels`, {method: 'POST', body: JSON.stringify(fields)});
  updateChannel = (id: string, channelId: string, fields: {name?: string; topic?: string; category?: string; roleIds?: string[]}) => this.request<{channel: import('./communities/types').CommunityChannel}>(`/communities/${encodeURIComponent(id)}/channels/${encodeURIComponent(channelId)}`, {method: 'PATCH', body: JSON.stringify(fields)});
  deleteChannel = (id: string, channelId: string) => this.request<{ok: true}>(`/communities/${encodeURIComponent(id)}/channels/${encodeURIComponent(channelId)}`, {method: 'DELETE'});
  channelMessages = (id: string, channelId: string, before?: number) => this.request<{messages: import('./communities/types').CommunityMessage[]; users: User[]; hasMore: boolean}>(`/communities/${encodeURIComponent(id)}/channels/${encodeURIComponent(channelId)}/messages${before ? `?before=${before}` : ''}`);
  sendChannelMessage = (id: string, channelId: string, fields: {text?: string; attachmentId?: string; replyTo?: number}) => this.request<{message: import('./communities/types').CommunityMessage}>(`/communities/${encodeURIComponent(id)}/channels/${encodeURIComponent(channelId)}/messages`, {method: 'POST', body: JSON.stringify(fields)});
  editChannelMessage = (id: string, channelId: string, messageId: number, text: string) => this.request<{message: import('./communities/types').CommunityMessage}>(`/communities/${encodeURIComponent(id)}/channels/${encodeURIComponent(channelId)}/messages/${messageId}`, {method: 'PATCH', body: JSON.stringify({text})});
  deleteChannelMessage = (id: string, channelId: string, messageId: number) => this.request<{ok: true}>(`/communities/${encodeURIComponent(id)}/channels/${encodeURIComponent(channelId)}/messages/${messageId}`, {method: 'DELETE'});
  createInvite = (id: string) => this.request<{invite: {code: string}}>(`/communities/${encodeURIComponent(id)}/invites`, {method: 'POST', body: '{}'});
  invite = (code: string) => this.request<import('./communities/types').InvitePreview>(`/invites/${encodeURIComponent(code)}`);
  acceptInvite = (code: string) => this.request<{community: import('./communities/types').Community}>(`/invites/${encodeURIComponent(code)}/accept`, {method: 'POST', body: '{}'});
  inviteUrl = (code: string) => `${this.base}/i/${encodeURIComponent(code)}`;
  /** A file for a channel: metadata is cleaned like any upload, but the file is stored as is (no E2EE). */
  async uploadChannelFile(file: LocalFile): Promise<Attachment> {
    if(Platform.OS==='web')throw new Error('Файлы в каналах отправляются из приложения Android/iPhone.');
    const {prepareMediaForUpload}=await import('./media/pipeline');
    const prepared=await prepareMediaForUpload(file);
    try{
      const clean=prepared.file;
      if(clean.size&&clean.size>20*1024*1024)throw new Error('Файл слишком большой. Максимум — 20 МБ.');
      const FileSystem=await import('expo-file-system/legacy');
      const bytes=toByteArray(await FileSystem.readAsStringAsync(clean.uri,{encoding:FileSystem.EncodingType.Base64}));
      const part=multipartFile(bytes,clean.name,clean.mimeType);
      return (await this.request<{attachment:Attachment}>('/uploads?purpose=channel',{method:'POST',body:part.body as unknown as BodyInit,headers:{'Content-Type':part.contentType}})).attachment;
    }finally{await prepared.dispose().catch(()=>{});}
  }

  async upload(file: LocalFile): Promise<Attachment> {
    if(Platform.OS==='web')throw new Error('Обработка и загрузка фото профиля доступны в приложении Android/iPhone.');
    const {prepareMediaForUpload}=await import('./media/pipeline');
    const prepared=await prepareMediaForUpload(file);
    try{
      const clean=prepared.file;
      if(clean.size&&clean.size>20*1024*1024)throw new Error('Файл слишком большой. Максимум — 20 МБ.');
      const FileSystem=await import('expo-file-system/legacy');
      const bytes=toByteArray(await FileSystem.readAsStringAsync(clean.uri,{encoding:FileSystem.EncodingType.Base64}));
      const part=multipartFile(bytes,clean.name,clean.mimeType);
      return (await this.request<{attachment:Attachment}>('/uploads',{method:'POST',body:part.body as unknown as BodyInit,headers:{'Content-Type':part.contentType}})).attachment;
    }finally{await prepared.dispose().catch(()=>{});}
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
