// Discord-style actions on a server member (click / right click on a person in a voice channel or
// in the member list): server mute, server deafen, kick, ban. Each shows only with the right
// permission; the server checks permissions and role hierarchy again.
import React from 'react';
import type { Api } from '../api';
import { MenuItem } from '../ContextMenu';
import { PERM, can, type Community } from './types';

export type MemberTarget = { userId: string; name: string; serverMuted?: boolean; serverDeafened?: boolean; inVoice?: boolean };

export function MemberMenuItems({ api, community, me, target, onDone, onError, onProfile }: {
  api: Api; community: Community; me: string; target: MemberTarget; onDone: () => void; onError: (message: string) => void; onProfile?: () => void;
}) {
  const self = target.userId === me, owner = target.userId === community.ownerId;
  const run = (job: () => Promise<unknown>) => { onDone(); job().catch(e => onError(e instanceof Error ? e.message : 'Не получилось.')); };
  return <>
    {onProfile ? <MenuItem icon="person-circle-outline" label="Профиль" onPress={() => { onDone(); onProfile(); }} /> : null}
    {!owner && can(community, PERM.MUTE_MEMBERS) ? <MenuItem icon={target.serverMuted ? 'mic-outline' : 'mic-off-outline'} label={target.serverMuted ? 'Включить микрофон' : 'Отключить микрофон'} onPress={() => run(() => api.setMemberVoice(community.id, target.userId, { muted: !target.serverMuted }))} /> : null}
    {!owner && can(community, PERM.DEAFEN_MEMBERS) ? <MenuItem icon={target.serverDeafened ? 'headset-outline' : 'volume-mute-outline'} label={target.serverDeafened ? 'Включить звук' : 'Отключить звук'} onPress={() => run(() => api.setMemberVoice(community.id, target.userId, { deafened: !target.serverDeafened }))} /> : null}
    {!self && !owner && can(community, PERM.KICK) ? <MenuItem icon="person-remove-outline" label="Исключить" danger separated onPress={() => run(() => api.kickMember(community.id, target.userId))} /> : null}
    {!self && !owner && can(community, PERM.BAN) ? <MenuItem icon="ban-outline" label="Заблокировать" danger onPress={() => run(() => api.banMember(community.id, target.userId))} /> : null}
  </>;
}

export const hasMemberActions = (community: Community, me: string, userId: string) =>
  userId !== community.ownerId && (can(community, PERM.MUTE_MEMBERS) || can(community, PERM.DEAFEN_MEMBERS) || (userId !== me && (can(community, PERM.KICK) || can(community, PERM.BAN))));
