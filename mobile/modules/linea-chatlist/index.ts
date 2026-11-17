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
};
export type NativeChatPalette = { text: number; muted: number; subtle: number; accent: number; onAccent: number; border: number; pressed: number; selected: number; badgeMuted: number };
export type NativeChatListProps = {
  rows: NativeChatRow[];
  palette: NativeChatPalette;
  /** Room above the first row and below the last one (the floating header and tab bar), dp: [top, bottom]. */
  pad?: [number, number];
  onRowPress?: (event: { nativeEvent: { id: string } }) => void;
  /** `y`: the finger's position in the window, dp (for the context menu). */
  onRowLongPress?: (event: { nativeEvent: { id: string; y: number } }) => void;
  style?: unknown;
};
