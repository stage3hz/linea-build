// Platina profile decoration: animated avatar, animated frame and banner.
// Values are validated here and only ever shown while Platina is active, so an
// expired subscription hides the decoration without deleting the user's choice.

export const AVATAR_FRAMES = Object.freeze(['aurora', 'frost', 'ember', 'emerald', 'prism', 'orbit']);
export const BANNER_PRESETS = Object.freeze(['deep', 'glacier', 'aurora', 'ocean', 'mint', 'night']);
export const MAX_PROFILE_VIDEO_BYTES = 8 * 1024 * 1024;

const FRAMES = new Set(AVATAR_FRAMES);
const PRESETS = new Set(BANNER_PRESETS);
export const isAvatarFrame = value => typeof value === 'string' && FRAMES.has(value);
export const isBannerPreset = value => typeof value === 'string' && PRESETS.has(value);

/** ISO-BMFF video (MP4 / MOV) by its `ftyp` box; returns a MIME type or null. */
export function videoMime(header) {
  if (header.length < 12 || header.subarray(4, 8).toString('latin1') !== 'ftyp') return null;
  const brand = header.subarray(8, 12).toString('latin1');
  if (brand === 'qt  ') return 'video/quicktime';
  if (/^(isom|iso[2-9]|mp41|mp42|avc1|M4V |M4VP|dash|MSNV|3gp[4-6])$/.test(brand)) return 'video/mp4';
  return null;
}

/**
 * The decoration fields of a serialized user. `showMedia` is false when the owner hid the
 * profile photo from this viewer: uploaded video and banner hide with it, presets stay.
 */
export function visibleCosmetics(row, platina, showMedia = true) {
  if (!platina.active) return { avatarVideoId: null, avatarFrame: null, bannerId: null, bannerKind: null, bannerPreset: null };
  const banner = showMedia && row.banner_id && (row.banner_kind === 'image' || row.banner_kind === 'video');
  return {
    avatarVideoId: showMedia && row.avatar_video_id ? row.avatar_video_id : null,
    avatarFrame: isAvatarFrame(row.avatar_frame) ? row.avatar_frame : null,
    bannerId: banner ? row.banner_id : null,
    bannerKind: banner ? row.banner_kind : null,
    bannerPreset: isBannerPreset(row.banner_preset) ? row.banner_preset : null,
  };
}
