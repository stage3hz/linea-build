// A call that wakes the app is for phones (incomingPush.ts); on the PC the app runs while its window is open.
export const CALL_PUSH_TASK = 'invizent-call-push';
export async function enableCallPush() {}
export function takeIncomingCall(): { chatId: string; answer: boolean } | null { return null; }
export function setOverLock(_on: boolean) {}
export function dismissIncomingCall() {}
