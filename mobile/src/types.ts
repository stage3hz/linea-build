export type User = {
  id: string; username: string; displayName: string; bio: string;
  avatarColor: string; avatarId: string | null; createdAt: string; statusEmoji?:string|null;statusEmojiExpiresAt?:string|null;statusEmojiPermanent?:boolean;
  /** Platina decoration, present only while the owner's Platina is active. */
  avatarVideoId?:string|null;avatarFrame?:string|null;bannerId?:string|null;bannerKind?:'image'|'video'|null;bannerPreset?:string|null;
  /** 'platina' while the owner's Platina is active: platinum name and seal, seen by everyone. */
  seal?:'platina'|null;
  /** Platina: particles over the profile when someone opens it; a backdrop behind the name in lists. */
  profileEffect?:string|null;nameplate?:string|null;
};
export type UsernameStatus={accountId:string;loginName:string;username:string;freeChangeAvailable:boolean;canChangeUsername:boolean;platina:{active:boolean;expiresAt:string|null;permanent?:boolean};canSetStatusEmoji:boolean;statusEmoji:string|null;statusEmojiChoices:string[]};
export type AttachmentMedia = {width?:number;height?:number;durationMs?:number;hdr?:'sdr'|'pq'|'hlg'};
export type AttachmentPreview = {mimeType:'image/jpeg';base64:string;width:number;height:number};
export type Attachment = { id: string; name: string; mimeType: string; size: number; encryption?: import('./e2ee/types').FileEncryption; media?:AttachmentMedia; preview?:AttachmentPreview };
export type Message = {
  id: number; chatId: string; senderId: string; clientId: string; text: string;
  attachment: Attachment | null; createdAt: string;
  encrypted?: import('./e2ee/types').EncryptedMessage;
  legacy?: boolean;
  cryptoState?: 'decrypted' | 'unverified' | 'no-key' | 'legacy' | 'invalid';
  meta?: import('./messageMeta').MessageMeta;
};
export type Chat = {
  id: string; peer: User; lastMessage: Message | null; unreadCount: number;
  lastReadMessageId: number; peerLastReadMessageId: number; createdAt: string; updatedAt: string;
  settings?: ChatSettings;
};
export type ChatSettings = { pinnedAt: string | null; archived: boolean; muted: boolean };
export type UserProfile = { user: User; isContact: boolean; chatId: string | null; blocked?: boolean };
export type ReportReason = 'spam' | 'abuse' | 'violence' | 'sexual' | 'illegal' | 'scam' | 'other';
export type Session = { token: string; user: User; securitySetupRequired?: boolean };
export type RecoveryStatus = { requestId: string; readyAt: string; expiresAt: string; serverTime: string; status: 'waiting' | 'ready' };
export type RecoveryChallenge = Omit<RecoveryStatus, 'status'> & { resetToken: string };
export type RecoveryRequest = { id: string; createdAt: string; readyAt: string; expiresAt: string; deviceName: string };
export type SecurityStatus = { recoveryConfigured: boolean; confirmationConfigured: boolean };
export type DeviceSession = {
  id: string; deviceName: string; createdAt: string; lastActiveAt: string;
  expiresAt: string; isCurrent: boolean;
};
export type LocalFile = { uri: string; name: string; mimeType: string; size?: number; file?: File };
export type PendingMessage = {
  clientId: string; chatId: string; text: string; attachment: Attachment | null;
  state: 'sending' | 'failed'; error?: string; createdAt: string;
  meta?: import('./messageMeta').MessageMeta;
};
export type ThemeMode = 'system' | 'light' | 'dark' | 'black';
export type DarkTheme = 'dark' | 'black';
export type Presence = { userId: string; online: boolean; lastSeenAt: string | null; hidden: boolean };
