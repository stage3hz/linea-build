/** Native bridge contract (src/calls/systemCall.ts loads it with requireOptionalNativeModule('LineaCall')). */
export type LineaCallEvent = { id?: string; muted?: boolean; active?: boolean };
export interface LineaCallBridge {
  supported(): boolean;
  start(id: string, name: string, video: boolean, text: string, endLabel: string, channelName: string): Promise<boolean>;
  update(id: string, text: string, connectedAt: number): Promise<void>;
  setMuted(id: string, muted: boolean): Promise<void>;
  end(id: string): Promise<void>;
}
