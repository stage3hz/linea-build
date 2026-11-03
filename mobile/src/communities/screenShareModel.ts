export type ScreenQuality = '720p60' | '1080p60';
export const SCREEN_QUALITIES = {
  '720p60': { width: 1280, height: 720, frameRate: 60, maxBitrate: 4_000_000 },
  '1080p60': { width: 1920, height: 1080, frameRate: 60, maxBitrate: 8_000_000 },
} as const;
export function screenQuality(value: unknown): ScreenQuality {
  if (value !== '720p60' && value !== '1080p60') throw new Error('Неизвестное качество демонстрации.');
  return value;
}
export function screenControl(raw: unknown): { active: boolean; quality: ScreenQuality } | null {
  if (typeof raw !== 'string' || raw.length > 256) return null;
  try { const v = JSON.parse(raw); return v.type === 'screen' && typeof v.active === 'boolean' ? { active: v.active, quality: screenQuality(v.quality) } : null; } catch { return null; }
}

/**
 * Stereo for the shared PC sound. Opus sends stereo only when the other side's SDP says
 * stereo=1 (RFC 7587 §6.1); we mark only the second audio section — the reserved slot for the
 * PC's sound (video slot, then microphone, then this one, in both offer and answer). The
 * microphone stays mono voice.
 */
export function stereoScreenAudio(sdp: string, bitrate = 128_000): string {
  if (!sdp) return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(eol);
  const starts = lines.map((l, i) => (l.startsWith('m=') ? i : -1)).filter(i => i >= 0);
  const audio = starts.filter(i => lines[i].startsWith('m=audio'));
  if (audio.length < 2) return sdp;
  const start = audio[1], end = starts.find(i => i > start) ?? lines.length;
  const section = lines.slice(start, end);
  const pt = section.map(l => /^a=rtpmap:(\d+) opus\/48000\/2/i.exec(l)?.[1]).find(Boolean);
  if (!pt) return sdp;
  const wanted: Record<string, string> = { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: String(bitrate) };
  const at = section.findIndex(l => l.startsWith(`a=fmtp:${pt} `));
  const merge = (existing: string) => {
    const params = new Map(existing.split(';').map(p => p.trim()).filter(Boolean).map(p => { const i = p.indexOf('='); return [i < 0 ? p : p.slice(0, i), i < 0 ? '' : p.slice(i + 1)] as [string, string]; }));
    for (const [k, v] of Object.entries(wanted)) params.set(k, v);
    return [...params].map(([k, v]) => (v ? `${k}=${v}` : k)).join(';');
  };
  if (at >= 0) section[at] = `a=fmtp:${pt} ${merge(section[at].slice(`a=fmtp:${pt} `.length))}`;
  else section.splice(section.findIndex(l => l.startsWith(`a=rtpmap:${pt} `)) + 1, 0, `a=fmtp:${pt} ${merge('')}`);
  return [...lines.slice(0, start), ...section, ...lines.slice(end)].join(eol);
}
