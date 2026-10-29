export type PublicPreKey = { id: number; publicKey: string };
export type PublicSignedPreKey = PublicPreKey & { signature: string };
export type PublicBundle = {
  registrationId: number; identityKey: string;
  signedPreKey: PublicSignedPreKey; kyberPreKey: PublicSignedPreKey;
  preKeys: PublicPreKey[];
};
export type ClaimedBundle = Omit<PublicBundle, 'preKeys'> & { preKey?: PublicPreKey };
export type CryptoDevice = {
  id: string; userId: string; deviceName: string; identityKey: string;
  registrationId: number; createdAt: string; active: boolean; preKeyCount?: number;
};
export type SignalEnvelope = { userId: string; deviceId: string; type: 2 | 3; body: string };
export type EncryptedMessage = {
  scheme: 'signal-v1'; senderDeviceId: string; envelopes: SignalEnvelope[]; attachmentIds?: string[];
};
export type FileEncryption = {
  scheme: 'aes-256-gcm-siv'; key: string; nonce: string; fileKeyId: string;
};
export type SignalBridge = {
  createState(localAddressName: string, deviceId: number): Promise<{ state: string; bundle: PublicBundle }>;
  replenish(state: string, count: number): Promise<{ state: string; bundle: PublicBundle }>;
  trustIdentity(state: string, addressName: string, deviceId: number, identityKey: string): Promise<{ state: string }>;
  encrypt(state: string, addressName: string, deviceId: number, plaintext: string, bundle: ClaimedBundle | null): Promise<{ state: string; type: 2 | 3; body: string }>;
  decrypt(state: string, addressName: string, deviceId: number, type: number, body: string): Promise<{ state: string; plaintext: string }>;
  seal(plaintextBase64: string, keyBase64: string, nonceBase64: string, adBase64: string): Promise<string>;
  open(ciphertextBase64: string, keyBase64: string, nonceBase64: string, adBase64: string): Promise<string>;
};
export type PrivateVault = {
  get(key: string): Promise<string | null>;
  commit(values: Record<string, string | null>): Promise<void>;
  close(): Promise<void>;
};
export type TrustDevice = CryptoDevice & { code: string; trusted: boolean; self: boolean };
export type TrustSnapshot = { peerId: string; fingerprint: string; devices: TrustDevice[]; ownDeviceId: string };
