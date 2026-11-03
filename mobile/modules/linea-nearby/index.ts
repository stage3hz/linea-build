/** Types only. Importing these declarations never requires a native runtime. */
export type NearbyPermission = 'granted' | 'undetermined' | 'denied' | 'blocked';
export type NearbyRadio = 'on' | 'off' | 'unknown';
export type NearbyNativeState = {
  /** false on Android 11 and older: Bluetooth search there needs location access, which Invizent never asks for. */
  supported: boolean;
  permission: NearbyPermission;
  bluetooth: NearbyRadio;
  /** The system's own check that the current network really reaches the internet (Wi-Fi or mobile). */
  internet: boolean;
};
export type LineaNearbyBridge = {
  state(): Promise<NearbyNativeState>;
  requestPermission(): Promise<NearbyNativeState>;
  /** Android: the system «Turn on Bluetooth?» dialog. iPhone: the system alert that leads to Bluetooth settings. */
  requestEnable(): Promise<NearbyNativeState>;
  openSettings(): Promise<void>;
  addListener(event: 'change', listener: (state: NearbyNativeState) => void): { remove(): void };
};
