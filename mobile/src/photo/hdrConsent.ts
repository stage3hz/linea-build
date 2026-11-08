// HDR is never dropped silently. When a photo cannot keep its HDR on this device (old OS, a mode without
// gain maps, an HDR base that needs tone mapping), sending stops with HdrConsentError; the attachment panel
// offers «Отправить без HDR», which records the consent for that file and retries.

export const HDR_CONSENT_CODE = 'HDR_NEEDS_CONSENT';
export const HDR_CONSENT_MESSAGE = 'Это HDR-фото. На этом устройстве HDR при отправке не сохраняется. Можно отправить его без HDR — с обычной яркостью.';

export class HdrConsentError extends Error {
  readonly code = HDR_CONSENT_CODE;
  readonly uri: string;
  constructor(uri: string, message: string = HDR_CONSENT_MESSAGE) {
    super(message);
    this.name = 'HdrConsentError';
    this.uri = uri;
  }
}

const allowed = new Set<string>();
let pending: string[] = [];

/** The user chose «Отправить без HDR» for this file. */
export function allowSdr(uri: string): void { allowed.add(uri); pending = pending.filter(item => item !== uri); }
export function sdrAllowed(uri: string): boolean { return allowed.has(uri); }

export function requestHdrConsent(uri: string, message?: string): HdrConsentError {
  if (!pending.includes(uri)) pending = [...pending.slice(-31), uri];
  return new HdrConsentError(uri, message);
}

/** Files waiting for the decision (survives an error that was re-wrapped on its way to the UI). */
export function pendingHdrConsent(): string[] { return [...pending]; }

export function isHdrConsentError(error: unknown): boolean {
  if (error instanceof HdrConsentError) return true;
  const value = error as { code?: unknown; message?: unknown } | null;
  return !!value && (value.code === HDR_CONSENT_CODE || value.code === `ERR_LINEA_PHOTO_${HDR_CONSENT_CODE}` || (typeof value.message === 'string' && value.message.startsWith('Это HDR-фото.')));
}
