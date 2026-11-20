/** Native contract of the phone's tab bar (src/NativeTabBar.tsx).
 *  The view (requireNativeViewManager('LineaTabBar')) draws the whole bar itself — the glass, the capsule under
 *  the chosen tab with its trail, the light, the icons and badges — and handles its own touches: a tap chooses a
 *  tab, a hold on the first tab (or a move up from it) opens the list of the sections that have no icon in the
 *  bar. JS only says what there is and which section is open, and is told what was chosen. */
export type LineaTabBarItem = {
  id: string;
  /** Read out by the screen reader and shown in the list. */
  label: string;
  /** SF Symbol name on iOS. */
  symbol: string;
  /** Unread count, 0 for none. */
  badge: number;
  /** A quiet coloured dot when there is no number ('#RRGGBB'), '' for none. */
  dot: string;
};
export type LineaTabBarProps = {
  /** Every section, in the order of the list (top to bottom). */
  items: LineaTabBarItem[];
  /** Ids of the sections that have an icon in the bar, left to right. The first one opens the list on hold. */
  bar: string[];
  /** Id of the section on screen. */
  active: string;
  dark: boolean;
  /** Three '#RRGGBB' colours of the light in the bar (centre, left, right); empty for the calm light. */
  glow: string[];
  /** Words for the screen reader's action that opens the list. */
  more: string;
  onSelect?: (event: { nativeEvent: { id: string } }) => void;
  /** The row under the finger in the list after a short stay ('' when none): the page behind may follow it. */
  onPreview?: (event: { nativeEvent: { id: string } }) => void;
  style?: object;
};
