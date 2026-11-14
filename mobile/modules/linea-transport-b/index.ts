/** Types only. This module must never be mistaken for an app-scoped network route. */
export type TransportBNativeCapabilities = {
  protocol: 1;
  nativeSession: boolean;
  appRouting: false;
};
export type TransportBSessionState = 'idle' | 'starting' | 'sessionConnected' | 'failed';
export type TransportBSessionEvent = {
  sessionId: string;
  state: TransportBSessionState;
  // Generic codes only. No third-party error strings, room links or credentials.
  error?: 'native_error' | 'session_lost' | 'startup_timeout';
};
export type TransportBNativeModule = {
  capabilities(): TransportBNativeCapabilities;
  status(): Promise<TransportBSessionEvent>;
  /** Resolves after STARTING negotiation, not after establishing a route. */
  startSession(sessionId: string, signedLeaseJoinLink: string): Promise<void>;
  /** A stale session ID cannot stop a newer session. */
  stopSession(sessionId: string): Promise<void>;
  addListener(event: 'transportState', listener: (event: TransportBSessionEvent) => void): { remove(): void };
};
