import React, { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import type { Api } from '../api';
import { Button, Notice, Sheet } from '../components';
import { Text } from '../typography';
import { useTheme } from '../theme';
import { CommunityAvatar, KindBadge, members, subscribers } from './parts';
import type { InvitePreview } from './types';

/** «Принять приглашение»: preview of the server or blog behind an invite, then join. */
export function InviteSheet({ api, code, onClose, onJoined }: { api: Api; code: string | null; onClose: () => void; onJoined: (communityId: string) => void }) {
  const t = useTheme(); const [info, setInfo] = useState<InvitePreview | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {
    setInfo(null); setError(''); if (!code) return;
    let alive = true;
    api.invite(code).then(value => { if (!alive) return; if (value.isMember) onJoined(value.community.id); else setInfo(value); }).catch(failure => { if (alive) setError(failure instanceof Error ? failure.message : 'Приглашение недействительно.'); });
    return () => { alive = false; };
  }, [api, code]);
  const accept = async () => {
    if (!code) return; setBusy(true); setError('');
    try { const { community } = await api.acceptInvite(code); onJoined(community.id); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось вступить.'); } finally { setBusy(false); }
  };
  const community = info?.community;
  return <Sheet visible={!!code} title="Приглашение" onClose={onClose}>
    {error ? <Notice text={error} error /> : !community ? <ActivityIndicator color={t.accent} style={{ padding: 24 }} /> : <View style={{ alignItems: 'center', gap: 12 }}>
      <CommunityAvatar api={api} community={community} size={84} />
      <Text style={{ color: t.text, fontSize: 22, fontWeight: '700', textAlign: 'center' }}>{community.name}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><KindBadge kind={community.kind} category={community.category} /><Text style={{ color: t.muted, fontSize: 13 }}>{community.kind === 'blog' ? subscribers(community.memberCount) : members(community.memberCount)}</Text></View>
      {community.description ? <Text style={{ color: t.muted, fontSize: 14, lineHeight: 20, textAlign: 'center' }}>{community.description}</Text> : null}
      <View style={{ alignSelf: 'stretch', marginTop: 6 }}><Button label={community.kind === 'blog' ? 'Подписаться' : 'Принять приглашение'} loading={busy} onPress={() => void accept()} /></View>
    </View>}
  </Sheet>;
}
