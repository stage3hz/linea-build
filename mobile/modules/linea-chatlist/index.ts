/** Native contract of the experimental chat list (used in src/ChatListScreen.tsx). Android (ChatListView.kt) and iOS (ios/LineChatListModule.swift).
 *  The view (requireNativeViewManager('LineaChatList')) is a scrolling list whose rows are drawn on a canvas, so a
 *  change of one chat redraws one row and nothing is laid out by React. It knows nothing about chats: JS hands it
 *  ready lines of text and colours, and gets a row id back when a row is tapped or held. */
export type NativeChatRow = {
  id: string;
  title: string;
  /** The line under the title (already «Ты: …», «печатает…», «Фото»). */
  preview: string;
  time: string;
  unread: number;
  muted: boolean;
  pinned: boolean;
  /** The preview is drawn in the accent colour (typing). */
  accentPreview: boolean;
  /** Own last message: 0 = no mark, 1 = sent, 2 = read. */
  ticks: 0 | 1 | 2;
  /** «Изм.» mode: -1 = no circle, 0 = empty circle, 1 = checked. */
  checked: -1 | 0 | 1;
  selected: boolean;
  /** Letter avatar: background colour (processColor) and the letters. */
  avatarColor: number;
  initials: string;
  /** Picture avatar: the file's address and the key it is cached under ('' = the letter avatar). */
  avatarUrl: string;
  avatarKey: string;
  /** Base64 of a small picture shown before the preview (the photo or video of the last message); '' = none. */
  thumb: string;
  thumbRound: boolean;
  /** iOS: swipe buttons as "action:Label", the outermost first. Android ignores them for now. */
  lead: string[];
  trail: string[];
  /** Avatar frame: a ring of these colours (processColor) around the photo; [] = none. */
  ring: number[];
  /** Avatar decoration: the bundled art (Image.resolveAssetSource(...).uri) and how many times the photo it is; '' = none. */
  deco: string;
  decoScale: number;
  /** Nameplate id (a key of the `plates` prop); '' = none. */
  plate: string;
};
export type NativeChatPalette = { text: number; muted: number; subtle: number; accent: number; onAccent: number; border: number; pressed: number; selected: number; badgeMuted: number; bg: number };
export type NativeChatListProps = {
  rows: NativeChatRow[];
  palette: NativeChatPalette;
  /** Room above the first row and below the last one (the floating header and tab bar), dp: [top, bottom]. */
  pad?: [number, number];
  /** The headers the app sends with a file request (its session): the native side fetches avatars with them. */
  headers?: Record<string, string>;
  /** Nameplate pictures by id (PNG as base64 or a data URL), see NameplateBake. */
  plates?: Record<string, string>;
  onRowPress?: (event: { nativeEvent: { id: string } }) => void;
  onRowAction?: (event: { nativeEvent: { id: string; action: string } }) => void;
  /** `y`: the finger's position in the window, dp (for the context menu). */
  onRowLongPress?: (event: { nativeEvent: { id: string; y: number } }) => void;
  style?: unknown;
};

/** One row of the experimental native message list (view 'LineaMsgList'); rows are given oldest first. */
export type NativeMsgRow = {
  key: string;
  /** 0 = a message bubble, 1 = a centred notice (the day, a service line). */
  kind: 0 | 1;
  mine: boolean;
  text: string;
  time: string;
  /** Own message: 1 = sent, 2 = read, 3 = being sent, 4 = failed; 0 = no mark. */
  ticks: 0 | 1 | 2 | 3 | 4;
  /** The last bubble of a run of one sender. */
  tail: boolean;
  quoteAuthor: string;
  quoteText: string;
  forward: string;
  /** The attachment in words («Фотография», «Голосовое сообщение · 0:12», a file name). */
  label: string;
  thumb: string;
  thumbRound: boolean;
  /** Width / height of the thumbnail. */
  thumbWide: number;
  checked: -1 | 0 | 1;
  /** Reactions in one line («👍 2  ❤️ 1»); '' = none. */
  reactions: string;
};
export type NativeMsgPalette = { text: number; muted: number; accent: number; onAccent: number; mine: number; theirs: number; notice: number; noticeText: number; danger: number; quote: number; mineMeta: number; mineMark: number; subtle: number };
export type NativeMsgListProps = {
  rows: NativeMsgRow[];
  palette: NativeMsgPalette;
  fontSize?: number;
  /** [under the header, above the composer], dp. */
  pad?: [number, number];
  onMsgPress?: (event: { nativeEvent: { key: string } }) => void;
  onMsgLongPress?: (event: { nativeEvent: { key: string; y: number } }) => void;
  /** The oldest loaded row is near: time to load older messages. */
  onNearTop?: (event: { nativeEvent: { key: string } }) => void;
  style?: unknown;
};
