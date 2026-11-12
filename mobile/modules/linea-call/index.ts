/** Native bridge contract (src/calls/systemCall.ts loads it with requireOptionalNativeModule('LineaCall')). */
export type LineaCallEvent = { id?: string; muted?: boolean; active?: boolean };
export interface LineaCallBridge {
  supported(): boolean;
  start(id: string, name: string, video: boolean, text: string, endLabel: string, channelName: string): Promise<boolean>;
  update(id: string, text: string, connectedAt: number): Promise<void>;
  setMuted(id: string, muted: boolean): Promise<void>;
  end(id: string): Promise<void>;
  /** iPhone, 0.14.16+: the call's microphones and current route; `chosen` is the microphone the user picked. */
  audioRoute?(): { inputs: AudioPort[]; input?: AudioPort; output?: AudioPort; chosen?: string };
  /** A microphone by its id, or null for the system's choice. */
  setAudioInput?(id: string | null): Promise<boolean>;
  /** The system's list of outputs. */
  showOutputPicker?(): Promise<boolean>;
}
/** An audio input or output as iOS names it (`kind`: AVAudioSession port type, e.g. MicrophoneBuiltIn, BluetoothHFP). */
export type AudioPort = { id: string; name: string; kind: string };
