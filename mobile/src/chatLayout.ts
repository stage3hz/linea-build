// Where the chat list stops at its two floating edges (Telegram: the newest message ends right above the
// composer, the oldest loaded one right under the header — nothing is read through the glass at rest).
//
// The composer is measured WITHOUT its animated bottom padding (the home-indicator inset that fades out as
// the keyboard rises): that padding is driven frame by frame on the UI thread, and onLayout of the animated
// container did not always follow it — after the keyboard went down the list kept the keyboard-time height
// and the last bubbles ended under the composer. The inset is added here from the keyboard state instead.

/** Space between the last message and the composer / the first message and the header. */
export const COMPOSER_GAP = 8;
export const HEADER_GAP = 14;

/** The chat header's edge effect: colour cover (share of the edge alpha) and iOS blur right behind the pills.
 *  The shared default (EDGE_STRENGTH .3, blur 16) left message text readable through the header glass. */
export const HEADER_EDGE_COVER = .78;
export const HEADER_EDGE_BLUR = 34;

export type ChatEdges = {
  /** Height of the composer block itself: reply/edit bar, attachments, multi-line field, emoji panel. */
  composer: number;
  /** Height of the floating header block (status bar included), as laid out. */
  header: number;
  /** Bottom safe area (home indicator / navigation bar) kept under the composer while the keyboard is down. */
  navInset: number;
  keyboardOpen: boolean;
};

/** Padding of the inverted list: `composerSide` is its visual bottom, `headerSide` its visual top. */
export function chatListPadding({ composer, header, navInset, keyboardOpen }: ChatEdges): { composerSide: number; headerSide: number } {
  const safe = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0);
  return {
    composerSide: Math.ceil(safe(composer) + (keyboardOpen ? 0 : safe(navInset)) + COMPOSER_GAP),
    headerSide: Math.ceil(safe(header) + HEADER_GAP),
  };
}
