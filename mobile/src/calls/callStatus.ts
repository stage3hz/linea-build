// What a call says about itself on the call screen, the minimised call bar and the system call indicator
// (Android notification), and how a call placed without a connection ends. Pure: no React Native imports,
// covered by test/call-status.test.mjs.
import { callClock, type CallStatus } from './callModel';

/**
 * The signalling path (the messenger socket that carries the encrypted offer/answer), as Telegram's titles say it:
 * the phone reports no network → «Ожидание сети…»; network but no server yet → «Соединение…».
 * `online`: what the phone says about its network (null = unknown, e.g. no NetInfo).
 */
export type SignalNetwork = 'online' | 'waiting' | 'connecting';
export function signalNetwork(connection: 'connecting' | 'connected' | 'offline', online: boolean | null): SignalNetwork {
  if (online === false) return 'waiting';
  if (connection === 'connected') return 'online';
  return online === true || connection === 'connecting' ? 'connecting' : 'waiting';
}
const NETWORK_TEXT: Record<Exclude<SignalNetwork, 'online'>, string> = { waiting: 'Ожидание сети…', connecting: 'Соединение…' };

/** How long a call placed offline waits for the connection before it ends with «Нет соединения» (and «Повторить»). */
export const NETWORK_WAIT_MS = 20_000;
export const NO_CONNECTION_TEXT = 'Нет соединения';

export type CallStatusInput = {
  status: CallStatus; incoming: boolean; video: boolean; reconnecting?: boolean;
  startedAt: number | null; endedText: string; network: SignalNetwork; now: number;
};

/**
 * The status line under the name. Before the other phone answered, no connection is the whole story: an outgoing
 * call does not say «Вызов…» while its offer cannot leave the phone. During a call the media path decides
 * («Восстановление связи…», or «Ожидание сети…» when the phone has no network at all); the clock keeps running.
 */
export function callStatusText(input: CallStatusInput): string {
  const clock = callClock(input.now - (input.startedAt || input.now));
  switch (input.status) {
    case 'incoming': return input.video ? 'Входящий видеозвонок' : 'Входящий звонок';
    case 'ended': return input.endedText;
    case 'requesting': case 'ringing':
      if (input.network !== 'online') return NETWORK_TEXT[input.network];
      return input.status === 'requesting' ? 'Запрос…' : 'Вызов…';
    case 'connecting': return input.network === 'waiting' ? NETWORK_TEXT.waiting : 'Соединение…';
    default:
      if (!input.reconnecting) return clock;
      return input.network === 'waiting' ? NETWORK_TEXT.waiting : 'Восстановление связи…';
  }
}

/** The status line plus whether the running clock is shown next to it (a call that is reconnecting keeps its duration). */
export function callBarText(input: CallStatusInput): { status: string; clock: string | null } {
  const status = callStatusText(input);
  const clock = input.status === 'active' && input.reconnecting ? callClock(input.now - (input.startedAt || input.now)) : null;
  return { status, clock };
}

/** Telegram's bar colours: green while the call is up, orange while it reconnects or waits, blue before it connects. */
export type CallBarTone = 'active' | 'trouble' | 'pending' | 'ended';
export function callBarTone(status: CallStatus, reconnecting: boolean | undefined, network: SignalNetwork): CallBarTone {
  if (status === 'ended') return 'ended';
  if (status === 'active') return reconnecting ? 'trouble' : 'active';
  return network === 'online' ? 'pending' : 'trouble';
}

/** Height of the minimised call bar (Telegram iOS: a full-width strip under the status bar). */
export const CALL_BAR_HEIGHT = 36;

/**
 * Where the bar goes inside its container. `insetTop` is the status bar / Dynamic Island height; `containerTop`
 * is where the container starts on screen (measured). Normally the container already starts under the status
 * bar (App's SafeAreaView), and the bar sits at its top; if it starts higher (no safe-area padding), the bar
 * moves down by the difference so it never covers the clock, the island or the battery. `contentTop` is how
 * far the screen content moves down so nothing hides under the bar.
 */
export function callBarLayout(insetTop: number, containerTop: number | null, height = CALL_BAR_HEIGHT): { top: number; contentTop: number } {
  const gap = containerTop === null || !Number.isFinite(containerTop) ? 0 : Math.max(0, Math.round(insetTop - containerTop));
  return { top: gap, contentTop: gap + height };
}

/**
 * The ring timer ran out. With the connection up, nobody answered («Нет ответа»); without it the offer may never
 * have arrived, so the call ends with «Нет соединения» and offers to try again.
 */
export function ringExpiry(network: SignalNetwork): { text: string; retry: boolean } {
  return network === 'online' ? { text: 'Нет ответа', retry: false } : { text: NO_CONNECTION_TEXT, retry: true };
}

/** The text of the system call indicator (Android ongoing-call notification): «Звонок» / «Видеозвонок», or the status. */
export function systemCallText(status: CallStatus, video: boolean, reconnecting: boolean | undefined, network: SignalNetwork): string {
  if (status === 'active' && !reconnecting) return video ? 'Видеозвонок' : 'Звонок';
  if (status === 'active') return network === 'waiting' ? NETWORK_TEXT.waiting : 'Восстановление связи…';
  if (network !== 'online') return NETWORK_TEXT[network];
  return status === 'ringing' ? 'Вызов…' : 'Соединение…';
}
