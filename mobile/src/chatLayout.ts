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

/**
 * The part of the bottom safe area kept under the composer, frame by frame: all of it with the keyboard down,
 * none with it up (`progress` 0 … 1). The composer's own bottom padding and the spacer at the list's
 * composer side both use it, so the newest message moves with the composer and never jumps when the
 * keyboard state flips (the list's static padding is taken with `keyboardOpen: true`, i.e. without it).
 */
export function navInsetShown(navInset: number, progress: number): number {
  'worklet';
  const inset = Number.isFinite(navInset) && navInset > 0 ? navInset : 0;
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  return inset * (1 - p);
}

// ── The floating tab bar ────────────────────────────────────────────────────────────────────────────────

/** Where the tab pill's lower edge sits above the screen bottom on an iPhone with a home indicator. It was
 *  21 pt: a swipe up that started on the pill's lower edge fell into the system home gesture and minimised
 *  the app, so the pill stands 9 pt higher, clear of the indicator's own strip. */
export const TAB_BAR_HOME_GAP = 30;
/** The same gap above the safe area everywhere else (Android navigation bar / gesture pill, no inset, web). */
export const TAB_BAR_GAP = 10;
/** Height of the pill itself: a 57 pt row and 3 pt of padding above and below. */
export const TAB_BAR_PILL = 63;

/** Bottom margin of the tab pill inside the safe area (negative on an iPhone: the pill reaches into the home-indicator inset). */
export function tabBarMarginBottom(ios: boolean, bottomInset: number): number {
  const inset = Number.isFinite(bottomInset) && bottomInset > 0 ? bottomInset : 0;
  return ios && inset > 0 ? Math.min(TAB_BAR_GAP, TAB_BAR_HOME_GAP - inset) : TAB_BAR_GAP;
}

/**
 * The bottom scroll-edge effect behind the floating tab bar, measured from the SCREEN bottom upwards.
 * `bar`: height of the tab block above the safe area (pill, its margins, the mini-player when shown);
 * `inset`: the bottom safe area; `lift`: the pill's lower edge above the screen bottom.
 * Below and beside the pill's lower half rows are covered by the page colour (nothing readable peeks out
 * under the pill or past its rounded ends); the cover thins across the pill, so the glass still shows the
 * list softly, and is gone `fade` pt above the block — rows at rest and a composer standing on the bar (AI, channels) are untouched.
 */
export function tabBarEdge(bar: number, inset: number, lift: number, fade = 8): { total: number; locations: [number, number, number, number, number]; alphas: [number, number, number, number, number]; blurSolid: number } {
  const safe = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0);
  const pillBottom = safe(lift), pillTop = pillBottom + TAB_BAR_PILL;
  const total = Math.max(pillTop, safe(bar) + safe(inset)) + fade;
  const at = (points: number) => Math.min(1, points / total);
  return {
    total,
    locations: [0, at(pillBottom + TAB_BAR_PILL * .2), at(pillBottom + TAB_BAR_PILL * .6), at(pillTop), 1],
    alphas: [.97, .94, .66, .3, 0],
    blurSolid: at(pillTop),
  };
}
