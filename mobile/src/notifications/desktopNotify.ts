// Системные уведомления на ПК и в браузере (F11, как в Telegram Desktop): когда окно не в фокусе
// или свёрнуто в трей, новое сообщение показывается системным уведомлением «Имя» / «Новое
// сообщение» (текст — только если в «Уведомления и звуки» включён предпросмотр), входящий звонок —
// уведомлением с кнопкой «Ответить» (где система это умеет). Клик по уведомлению возвращает окно
// и открывает чат. Телефоны получают push от сервера (push.ts) — здесь они ничего не делают.
//
// Что решается чисто (без платформы) и покрыто тестами: показывать ли и с каким текстом —
// decideNotification(); какие сообщения новые — newIncoming(); что показать по обновлению списка —
// planNotifications(); настройки — effectivePrefs() и parseDesktopPrefs().
// Инварианты: текст сообщения никогда не уходит в уведомление без явного разрешения; при
// код-пароле (lock/isLocked) не показывается даже имя; без звука и уведомлений — при «не беспокоить»
// и для чатов без звука; никаких сетевых запросов.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { desktopBridge, type DesktopNotification } from '../desktop';
import { isLocked } from '../lock/LockGate';
import { navigate } from '../navigation';
import { chatListText } from '../messageMeta';
import { attachmentLabel } from '../voice/voice';
import { countsAsUnread } from '../chatUnread';
import { OFFER_TTL_MS, offerIsFresh } from '../calls/callModel';
import type { Chat, Message, User } from '../types';
import { getNotificationPrefs } from './prefs';
import { isMuted, muteEndLabel, type NotificationPrefs } from './model';

// ---- настройки ----
// Общие переключатели берутся из «Уведомления и звуки» (F2, prefs.ts): показывать ли, звук, имя
// отправителя. Чего там нет и что нужно только на ПК — текст сообщения в уведомлении (по умолчанию
// выключен) и «не беспокоить» — лежит здесь, в своём маленьком хранилище.
/** textPreview — показывать текст сообщения; dndUntil — «не беспокоить» до этого времени (Date.now()), null = выключено, Infinity = пока не выключат. */
export type DesktopNotifyPrefs = { textPreview: boolean; dndUntil: number | null };
export const DEFAULT_DESKTOP_PREFS: DesktopNotifyPrefs = { textPreview: false, dndUntil: null };
const PREFS_KEY = 'linea.desktop-notify.v1';
export function parseDesktopPrefs(raw: string | null): DesktopNotifyPrefs {
  if (!raw) return DEFAULT_DESKTOP_PREFS;
  try {
    const value = JSON.parse(raw) as { textPreview?: unknown; dndUntil?: unknown } | null;
    const until = value?.dndUntil;
    return { textPreview: value?.textPreview === true, dndUntil: until === 'forever' ? Infinity : typeof until === 'number' && until > 0 ? until : null };
  } catch { return DEFAULT_DESKTOP_PREFS; }
}
const serializePrefs = (value: DesktopNotifyPrefs) => JSON.stringify({ textPreview: value.textPreview, dndUntil: value.dndUntil === Infinity ? 'forever' : value.dndUntil });
let desktopPrefs: DesktopNotifyPrefs = DEFAULT_DESKTOP_PREFS;
const prefsListeners = new Set<() => void>();
let prefsLoaded: Promise<void> | null = null;
function loadPrefs() {
  if (!prefsLoaded) prefsLoaded = AsyncStorage.getItem(PREFS_KEY).then(raw => { desktopPrefs = parseDesktopPrefs(raw); prefsListeners.forEach(l => l()); }).catch(() => {});
  return prefsLoaded;
}
export function getDesktopPrefs(): DesktopNotifyPrefs { void loadPrefs(); return desktopPrefs; }
export function setDesktopPrefs(change: Partial<DesktopNotifyPrefs>) {
  desktopPrefs = { ...desktopPrefs, ...change }; prefsListeners.forEach(l => l());
  void AsyncStorage.setItem(PREFS_KEY, serializePrefs(desktopPrefs)).catch(() => {});
}
export function useDesktopPrefs(): DesktopNotifyPrefs {
  void loadPrefs();
  return useSyncExternalStore(l => { prefsListeners.add(l); return () => { prefsListeners.delete(l); }; }, () => desktopPrefs, () => desktopPrefs);
}
/** «Не беспокоить» действует: до срока или бессрочно. */
export const dndActive = (value: Pick<DesktopNotifyPrefs, 'dndUntil'>, now: number) => value.dndUntil !== null && value.dndUntil > now;
/** Строка настройки «Не беспокоить»: «Выкл», «До выключения», «До 18:30» / «До завтра, 09:15». */
export function dndLabel(value: Pick<DesktopNotifyPrefs, 'dndUntil'>, now = Date.now()): string {
  if (!dndActive(value, now)) return 'Выкл';
  if (value.dndUntil === Infinity) return 'До выключения';
  const end = muteEndLabel(new Date(value.dndUntil as number).toISOString(), now);
  return end ? `До ${end}` : 'До выключения';
}

/** Что видит модель решения: общие переключатели F2 + добавки ПК, в одном плоском объекте. */
export type NotifyPrefs = { enabled: boolean; senderName: boolean; textPreview: boolean; sound: boolean; calls: boolean; dndUntil: number | null };
export function effectivePrefs(common: Pick<NotificationPrefs, 'chats' | 'calls'>, desktop: DesktopNotifyPrefs): NotifyPrefs {
  // «Без мелодии» выключает только звук звонка в приложении; уведомление о звонке всё равно нужно.
  return { enabled: common.chats.show, senderName: common.chats.preview, textPreview: desktop.textPreview, sound: common.chats.sound, calls: true, dndUntil: desktop.dndUntil };
}
export const currentPrefs = (): NotifyPrefs => effectivePrefs(getNotificationPrefs(), getDesktopPrefs());

// ---- чистая модель: показывать ли и что писать ----
export type NotifyEvent =
  /** quiet: «Отправить без звука» (F4) — shown, never with sound. */
  | { kind: 'message'; chatId: string; senderName: string; text: string; fromSelf: boolean; muted: boolean; quiet?: boolean }
  | { kind: 'call'; chatId: string; senderName: string; video: boolean; muted: boolean }
  /** Много чатов за один раз (переподключение): одно уведомление вместо лавины. */
  | { kind: 'summary'; count: number };
export type NotifyContext = { windowActive: boolean; locked: boolean; prefs: NotifyPrefs; now: number };
export type NotifyDecision =
  | { show: false; reason: 'self' | 'disabled' | 'dnd' | 'muted' | 'calls-off' | 'active' | 'empty' }
  | { show: true; kind: 'message' | 'call'; chatId: string | null; tag: string; title: string; body: string; silent: boolean; answer: boolean };

export const APP_TITLE = 'Инвиз';
const BODY_LIMIT = 120;
/** Одна строка без управляющих символов и лишних пробелов, не длиннее лимита (многоточие в конце). */
export function clipText(text: string, limit = BODY_LIMIT): string {
  const line = text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
  if (line.length <= limit) return line;
  return `${Array.from(line).slice(0, limit - 1).join('').trimEnd()}…`;
}
export const callTag = (chatId: string) => `call:${chatId}`;
export const messageTag = (chatId: string) => `chat:${chatId}`;

export function decideNotification(event: NotifyEvent, context: NotifyContext): NotifyDecision {
  const { prefs: p } = context;
  if (event.kind === 'message' && event.fromSelf) return { show: false, reason: 'self' };
  if (!p.enabled) return { show: false, reason: 'disabled' };
  if (dndActive(p, context.now)) return { show: false, reason: 'dnd' };
  // Окно перед глазами: список чатов и сам чат уже всё показывают; звонок рисует свой экран.
  if (context.windowActive) return { show: false, reason: 'active' };
  if (event.kind === 'summary') {
    if (event.count < 1) return { show: false, reason: 'empty' };
    return { show: true, kind: 'message', chatId: null, tag: 'summary', title: APP_TITLE, body: `Новых сообщений: ${event.count}`, silent: !p.sound, answer: false };
  }
  if (event.kind === 'message' && event.muted) return { show: false, reason: 'muted' };
  // Звонок в чате без звука всё равно звонит (как в Telegram); выключают звонки отдельно.
  if (event.kind === 'call' && !p.calls) return { show: false, reason: 'calls-off' };
  const name = p.senderName ? clipText(event.senderName, 60) || APP_TITLE : APP_TITLE;
  if (event.kind === 'call') {
    // Звук звонка играет само приложение — системное уведомление молчит, чтобы не звенеть дважды.
    const body = event.video ? 'Входящий видеозвонок' : 'Входящий звонок';
    return { show: true, kind: 'call', chatId: event.chatId, tag: callTag(event.chatId), title: context.locked ? APP_TITLE : name, body: context.locked ? 'Входящий звонок' : body, silent: true, answer: true };
  }
  // Под код-паролем — ни имени, ни текста: экран заперт, уведомление не должно его обходить.
  const silent = !p.sound || event.quiet === true;
  if (context.locked) return { show: true, kind: 'message', chatId: event.chatId, tag: messageTag(event.chatId), title: APP_TITLE, body: 'Новое сообщение', silent, answer: false };
  const text = p.textPreview ? clipText(event.text) : '';
  return { show: true, kind: 'message', chatId: event.chatId, tag: messageTag(event.chatId), title: name, body: text || 'Новое сообщение', silent, answer: false };
}

/** Что писать в предпросмотре (как в списке чатов): текст без спойлеров, иначе подпись вложения. Нерасшифрованное — пусто. */
export function previewText(message: Message): string {
  if (message.cryptoState && message.cryptoState !== 'decrypted' && message.cryptoState !== 'legacy') return '';
  const text = chatListText(message);
  if (text.trim()) return text;
  return message.attachment ? attachmentLabel(message.attachment) : '';
}

// ---- чистая модель: какие сообщения новые ----
/** Сколько отдельных уведомлений за одно обновление списка; больше — одно общее. */
export const BATCH_LIMIT = 5;
export type Arrival = { chat: Chat; message: Message };
/**
 * Сравнивает последние сообщения чатов с тем, что уже видели (id последнего сообщения по чату).
 * Возвращает новые входящие, которые считаются непрочитанными (не свои, не реакции/правки), и
 * обновлённую карту. При первом вызове (seen = null) только запоминает — при запуске лавины нет.
 * Mesh-сообщения (локальные id ≥ 9e15) в карту не попадают: иначе настоящие серверные id никогда
 * их не превысят и чат замолчит навсегда. Чат без непрочитанного (прочитан на телефоне) не новость.
 */
export function newIncoming(seen: ReadonlyMap<string, number> | null, chats: readonly Chat[], userId: string): { arrivals: Arrival[]; seen: Map<string, number> } {
  const next = new Map<string, number>(), arrivals: Arrival[] = [];
  for (const chat of chats) {
    const last = chat.lastMessage;
    const before = seen?.get(chat.id);
    const lastId = last && !last.mesh ? last.id : 0;
    next.set(chat.id, Math.max(lastId, before ?? 0));
    if (!seen || !last || last.mesh) continue;
    if (!chat.unreadCount) continue;
    // Новый чат (before === undefined) тоже новость, если в нём уже есть непрочитанное.
    if (before !== undefined && last.id <= before) continue;
    if (!countsAsUnread(last, userId)) continue;
    arrivals.push({ chat, message: last });
  }
  return { arrivals, seen: next };
}

export type ShownDecision = Extract<NotifyDecision, { show: true }>;
/**
 * Что показать по обновлению списка чатов — чисто, без платформы. `ready` — список уже загружен:
 * пока его нет (при запуске chats = []), ничего не запоминается, иначе первый настоящий список
 * выглядел бы как лавина новых сообщений. Чаты без звука отсеиваются до подсчёта лавины, чтобы
 * общее «Новых сообщений: N» их не считало. Возвращает новую карту и решения, которые нужно показать.
 */
export function planNotifications(seen: ReadonlyMap<string, number> | null, chats: readonly Chat[], userId: string, ctx: NotifyContext & { ready: boolean }): { seen: Map<string, number> | null; decisions: ShownDecision[] } {
  if (!ctx.ready && seen === null) return { seen: null, decisions: [] };
  const result = newIncoming(seen, chats, userId);
  const fresh = result.arrivals.filter(({ chat }) => !isMuted(chat.settings, ctx.now));
  if (!fresh.length) return { seen: result.seen, decisions: [] };
  const shown = (decision: NotifyDecision): decision is ShownDecision => decision.show;
  // The summary rings only if at least one of the new messages was not sent «без звука».
  if (fresh.length > BATCH_LIMIT) return { seen: result.seen, decisions: [decideNotification({ kind: 'summary', count: fresh.length }, ctx)].filter(shown).map(d => fresh.every(({ message }) => message.meta?.silent === true) ? { ...d, silent: true } : d) };
  const decisions = fresh.map(({ chat, message }) => decideNotification({ kind: 'message', chatId: chat.id, senderName: chat.peer.displayName, text: previewText(message), fromSelf: message.senderId === userId, muted: false, quiet: message.meta?.silent === true }, ctx)).filter(shown);
  return { seen: result.seen, decisions };
}

// ---- показ: Electron через мост, браузер через Notification API ----
type Shown = { close(): void };
const live = new Map<string, Shown>();
type WebNotification = { close(): void; onclick: ((this: unknown, ev: unknown) => unknown) | null; onclose: ((this: unknown, ev: unknown) => unknown) | null };
type WebNotificationCtor = { new (title: string, options?: { body?: string; tag?: string; silent?: boolean; renotify?: boolean; requireInteraction?: boolean }): WebNotification; permission: 'granted' | 'denied' | 'default'; requestPermission(): Promise<'granted' | 'denied' | 'default'> };
const webNotification = (): WebNotificationCtor | undefined => (globalThis as unknown as { Notification?: WebNotificationCtor }).Notification;

export type WebPermission = 'granted' | 'denied' | 'default' | 'unsupported' | 'desktop';
/** Браузер: разрешение на уведомления; 'desktop' — Electron, спрашивать нечего; 'unsupported' — API нет. */
export function webNotificationPermission(): WebPermission {
  if (Platform.OS !== 'web') return 'unsupported';
  if (desktopBridge()?.notifications) return 'desktop';
  const ctor = webNotification();
  return ctor ? ctor.permission : 'unsupported';
}
/** Спрашивается один раз из настроек («Уведомления и звуки»), не при запуске — браузеры иначе глушат вопрос. */
export async function requestWebNotificationPermission(): Promise<WebPermission> {
  const current = webNotificationPermission();
  if (current !== 'default') return current;
  try { return await webNotification()!.requestPermission(); } catch { return 'denied'; }
}

const windowActive = () => typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();

/** Показывает принятое решение; клик открывает чат. Возвращает true, если уведомление ушло в систему. */
export async function showDecision(decision: NotifyDecision, onOpen: (chatId: string | null, answer: boolean) => void): Promise<boolean> {
  if (!decision.show) return false;
  live.get(decision.tag)?.close(); live.delete(decision.tag);
  const bridge = desktopBridge()?.notifications;
  if (bridge) {
    const payload: DesktopNotification = { tag: decision.tag, title: decision.title, body: decision.body, silent: decision.silent, kind: decision.kind, chatId: decision.chatId, answer: decision.answer };
    const ok = await bridge.show(payload).catch(() => false);
    if (ok) live.set(decision.tag, { close: () => { void bridge.close(decision.tag).catch(() => {}); } });
    return ok;
  }
  const ctor = webNotification();
  if (!ctor || ctor.permission !== 'granted') return false;
  try {
    const shown = new ctor(decision.title, { body: decision.body, tag: decision.tag, silent: decision.silent, renotify: true, requireInteraction: decision.kind === 'call' });
    shown.onclick = () => { try { (globalThis as { focus?: () => void }).focus?.(); } catch { /* браузер может запретить */ } onOpen(decision.chatId, false); shown.close(); };
    shown.onclose = () => { if (live.get(decision.tag) === shown) live.delete(decision.tag); };
    live.set(decision.tag, shown);
    return true;
  } catch { return false; }
}
/** Чат открыли или прочитали, звонок кончился — его уведомление снимается. */
export function closeNotification(tag: string) {
  const shown = live.get(tag); live.delete(tag);
  shown?.close();
  void desktopBridge()?.notifications?.close(tag).catch(() => {});
}

// ---- хук: одна точка подключения в useMessenger ----
/** `ready` — список чатов загружен (не listLoading): до этого новых сообщений нет по определению. */
export function useDesktopNotifications(input: { user: User; chats: readonly Chat[]; selectedId: string | null; ready: boolean; onCallSignal: (listener: (message: Message) => void) => () => void }) {
  const { user, chats, selectedId, ready, onCallSignal } = input;
  const seen = useRef<Map<string, number> | null>(null);
  const chatsRef = useRef(chats); chatsRef.current = chats;
  const calls = useRef(new Set<string>());
  const callTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const supported = Platform.OS === 'web';
  const open = (chatId: string | null) => {
    if (!chatId) return;
    const chat = chatsRef.current.find(c => c.id === chatId);
    // App.tsx слушает navigate: переключает страницу на чаты и открывает разговор с этим человеком.
    if (chat) navigate({ to: 'chat', userId: chat.peer.id });
  };
  const context = (): NotifyContext => ({ windowActive: windowActive(), locked: isLocked(), prefs: currentPrefs(), now: Date.now() });
  // Новые сообщения: по изменению списка чатов (сокет, обновление списка) — без вмешательства в приём сообщений.
  useEffect(() => {
    if (!supported) return;
    const plan = planNotifications(seen.current, chats, user.id, { ...context(), ready }); seen.current = plan.seen;
    for (const decision of plan.decisions) void showDecision(decision, open);
  }, [chats, user.id, ready, supported]);
  // Открытый или прочитанный чат снимает своё уведомление; общее «Новых сообщений: N» — когда непрочитанного не осталось.
  useEffect(() => { if (supported && selectedId) closeNotification(messageTag(selectedId)); }, [selectedId, supported]);
  useEffect(() => {
    if (!supported) return;
    for (const chat of chats) if (!chat.unreadCount && live.has(messageTag(chat.id))) closeNotification(messageTag(chat.id));
    if (live.has('summary') && !chats.some(chat => chat.unreadCount)) closeNotification('summary');
  }, [chats, supported]);
  // Входящие звонки: оффер — уведомление с «Ответить»; ответ/конец — снять. Если конца не пришло
  // (звонивший пропал), карточка уходит сама, когда оффер устарел (OFFER_TTL_MS): звонить уже нечему.
  useEffect(() => {
    if (!supported) return;
    const timers = callTimers.current;
    const clearTimer = (chatId: string) => { const timer = timers.get(chatId); if (timer) clearTimeout(timer); timers.delete(chatId); };
    const stop = onCallSignal(message => {
      const action = message.meta?.action; if (action?.type !== 'call') return;
      if (action.step !== 'offer') { clearTimer(message.chatId); closeNotification(callTag(message.chatId)); return; }
      if (!offerIsFresh(message.createdAt, Date.now(), calls.current, action.call)) return;
      calls.current.add(action.call); if (calls.current.size > 50) calls.current.delete(calls.current.values().next().value as string);
      const chat = chatsRef.current.find(c => c.id === message.chatId);
      const event: NotifyEvent = { kind: 'call', chatId: message.chatId, senderName: chat?.peer.displayName || '', video: !!action.video, muted: isMuted(chat?.settings) };
      void showDecision(decideNotification(event, context()), open).then(shown => {
        if (!shown) return;
        clearTimer(message.chatId);
        timers.set(message.chatId, setTimeout(() => { timers.delete(message.chatId); closeNotification(callTag(message.chatId)); }, OFFER_TTL_MS));
      });
    });
    return () => { stop(); for (const timer of timers.values()) clearTimeout(timer); timers.clear(); };
  }, [onCallSignal, supported]);
  // Клик по уведомлению Electron (главный процесс уже вернул окно): открыть чат; «Ответить» — чат и запрос ответа.
  useEffect(() => {
    if (!supported) return;
    const bridge = desktopBridge()?.notifications; if (!bridge) return;
    return bridge.onAction(action => { open(action.chatId); const chatId = action.chatId; if (action.kind === 'answer' && chatId) answerListeners.forEach(l => { try { l(chatId); } catch { /* один слушатель не мешает другим */ } }); });
  }, [supported]);
}

// «Ответить» из уведомления: экран звонка подписывается и принимает текущий входящий звонок этого чата.
const answerListeners = new Set<(chatId: string) => void>();
export function onAnswerFromNotification(listener: (chatId: string) => void) { answerListeners.add(listener); return () => { answerListeners.delete(listener); }; }
