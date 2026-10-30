import type { User } from '../types';

export const PERM = { ADMIN: 1, MANAGE_COMMUNITY: 2, MANAGE_CHANNELS: 4, MANAGE_ROLES: 8, INVITE: 16, SEND: 32, VOICE: 64, POST: 128, KICK: 256, MANAGE_MESSAGES: 512 } as const;
export const PERM_LABELS: { bit: number; label: string; blog?: boolean; server?: boolean }[] = [
  { bit: PERM.SEND, label: 'Писать в каналах', server: true },
  { bit: PERM.VOICE, label: 'Голосовые каналы', server: true },
  { bit: PERM.POST, label: 'Публиковать посты', blog: true },
  { bit: PERM.INVITE, label: 'Приглашать по ссылке' },
  { bit: PERM.MANAGE_MESSAGES, label: 'Удалять чужие сообщения' },
  { bit: PERM.KICK, label: 'Исключать участников' },
  { bit: PERM.MANAGE_CHANNELS, label: 'Управлять каналами', server: true },
  { bit: PERM.MANAGE_ROLES, label: 'Управлять ролями' },
  { bit: PERM.MANAGE_COMMUNITY, label: 'Менять название и фото' },
  { bit: PERM.ADMIN, label: 'Администратор (все права)' },
];
export type CommunityKind = 'server' | 'blog';
export type CommunityMessage = { id: number; channelId: string; senderId: string; text: string; attachment: { id: string; name: string; mimeType: string; size: number } | null; replyTo: number | null; createdAt: string; editedAt: string | null };
export type CommunitySummary = { id: string; kind: CommunityKind; name: string; description: string; avatarId: string | null; ownerId: string; createdAt: string; memberCount: number; isMember: boolean; perms: number; lastMessage: CommunityMessage | null; muted: boolean };
export type CommunityRole = { id: string; name: string; color: string; position: number; perms: number; isDefault: boolean };
export type VoiceMember = { userId: string; muted: boolean };
export type CommunityChannel = { id: string; kind: 'text' | 'voice'; name: string; topic: string; category: string; position: number; roleIds: string[]; voice?: VoiceMember[]; lastMessageId: number };
export type Community = CommunitySummary & { roles: CommunityRole[]; myRoleIds: string[]; channels: CommunityChannel[] };
export type CommunityMember = { user: User; roleIds: string[]; owner: boolean; joinedAt: string };
export type InvitePreview = { code: string; community: { id: string; kind: CommunityKind; name: string; description: string; avatarId: string | null; memberCount: number }; isMember: boolean };
export const can = (community: Pick<CommunitySummary, 'perms'>, bit: number) => (community.perms & bit) !== 0;

/** Invite code from an in-app or web invite link (linea://invite/CODE or https://host/i/CODE). */
export function inviteCodeFrom(text: string): string | null {
  const match = text.match(/(?:linea:\/\/invite\/|https?:\/\/[^\s/]+\/i\/)([A-Za-z0-9]{6,16})(?![A-Za-z0-9])/);
  return match ? match[1] : null;
}
