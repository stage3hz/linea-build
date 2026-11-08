// System notifications and the tray counter for main.cjs — the parts that need no Electron window
// and are tested directly (desktop/test/notify.test.mjs). Electron objects (nativeImage, the tray)
// come in as arguments, so the same code runs under a fake in Node.

/** Bounded copy of what the page asked to show, or null when it is not a notification at all. */
function notificationPayload(value) {
  if (!value || typeof value !== 'object') return null;
  const text = (field, limit) => (typeof value[field] === 'string' ? value[field].replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '');
  const tag = text('tag', 128), title = text('title', 80), body = text('body', 200);
  if (!tag || !title) return null;
  const chatId = value.chatId === null || value.chatId === undefined ? null : typeof value.chatId === 'string' && value.chatId.length <= 128 ? value.chatId : null;
  return { tag, title, body, silent: value.silent === true, kind: value.kind === 'call' ? 'call' : 'message', chatId, answer: value.answer === true && value.kind === 'call' };
}

/** Tray tooltip: the count is the only badge a Linux tray has. */
const trayTooltip = count => (count > 0 ? `Инвиз — непрочитанных: ${count}` : 'Инвиз');

/** Tray icons are 16 px (scale 1) and 32 px (scale 2, high-DPI screens); the counter covers this share of the icon's side. */
const TRAY_SIZE = 16, MARK_SHARE = 0.6875, SCALES = [1, 2];

/**
 * Source-over of one BGRA bitmap (`mark`, markSize²) onto another (`base`, size²) at (x, y); straight
 * alpha, clamped. Returns a new buffer; a buffer of the wrong length comes back as a copy of the base.
 */
function composeBitmap(base, size, mark, markSize, x, y) {
  const out = Buffer.from(base);
  if (out.length !== size * size * 4 || mark.length !== markSize * markSize * 4) return out;
  for (let row = 0; row < markSize; row++) for (let col = 0; col < markSize; col++) {
    const tx = x + col, ty = y + row; if (tx < 0 || ty < 0 || tx >= size || ty >= size) continue;
    const s = (row * markSize + col) * 4, d = (ty * size + tx) * 4;
    const sa = mark[s + 3] / 255; if (!sa) continue;
    const da = out[d + 3] / 255, oa = sa + da * (1 - sa);
    for (let channel = 0; channel < 3; channel++) out[d + channel] = oa ? Math.min(255, Math.round((mark[s + channel] * sa + out[d + channel] * da * (1 - sa)) / oa)) : 0;
    out[d + 3] = Math.round(oa * 255);
  }
  return out;
}

/**
 * The app icon with the counter picture (drawn by the page, see mobile/src/appBadge.ts) in its
 * bottom-right corner, as Telegram Desktop's tray counter: one image with 16 px (scale 1) and
 * 32 px (scale 2) representations. Without a usable app icon the counter alone is returned.
 */
function trayBadgeImage(nativeImage, icon, badge) {
  if (!badge || badge.isEmpty()) return icon;
  if (!icon || icon.isEmpty()) return badge;
  const out = nativeImage.createEmpty();
  for (const scale of SCALES) {
    const size = TRAY_SIZE * scale, markSize = Math.round(size * MARK_SHARE);
    const base = icon.resize({ width: size, height: size, quality: 'best' }).toBitmap();
    const mark = badge.resize({ width: markSize, height: markSize, quality: 'best' }).toBitmap();
    out.addRepresentation({ scaleFactor: scale, width: size, height: size, buffer: composeBitmap(base, size, mark, markSize, size - markSize, size - markSize) });
  }
  return out;
}

/** Puts the current unread state on the tray: the tooltip always, the icon with the counter while something is unread. */
function applyTrayBadge({ tray, icon, badge, nativeImage }) {
  if (!tray) return;
  try {
    tray.setToolTip(trayTooltip(badge.count));
    if (icon) tray.setImage(badge.count > 0 && badge.image ? trayBadgeImage(nativeImage, icon, badge.image) : icon);
  } catch { /* the tray may be gone (a crashed shell) */ }
}

module.exports = { notificationPayload, trayTooltip, composeBitmap, trayBadgeImage, applyTrayBadge, TRAY_SIZE };
