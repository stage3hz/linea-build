/** Types for the opt-in session and bounded app-owned networking ABI. */
export type TransportBNativeCapabilities = {
  protocol: 1;
  nativeSession: boolean;
  networkProtocol?: 1;
  sessionNetworking?: boolean;
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

export type TransportBSocketEvent = {
  sessionId: string; socketId: string; kind: 'open' | 'message' | 'close' | 'error'; text?: string; code?: number;
};
export type TransportBNetworkModule = Omit<TransportBNativeModule, 'addListener'> & {
  addListener(event: 'transportState', listener: (event: TransportBSessionEvent) => void): { remove(): void };
  addListener(event: 'transportSocket', listener: (event: TransportBSocketEvent) => void): { remove(): void };
  request(sessionId: string, requestId: string, url: string, method: string, headers: Record<string, string>, body: string | null, timeout: number): Promise<{status: number; headers: Record<string,string>; body: string}>;
  cancelRequest(sessionId: string, requestId: string): Promise<void>;
  socketOpen(sessionId: string, socketId: string, url: string): Promise<void>;
  socketSend(sessionId: string, socketId: string, text: string): Promise<void>;
  socketClose(sessionId: string, socketId: string): Promise<void>;
};
