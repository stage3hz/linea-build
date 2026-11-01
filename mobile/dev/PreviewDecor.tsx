// Dev-only: avatar decorations in a profile head and in chat rows. ?p=1 light, else dark.
import React from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeContext, palette } from '../src/theme';
import { Text } from '../src/typography';
import { DecoratedAvatar } from '../src/platina/Decor';
import { DECORATIONS } from '../src/platina/Decorations';
import type { User } from '../src/types';
import type { Api } from '../src/api';

const api = {} as Api;
const user = (frame: string, i: number): User => ({ id: 'u' + i, displayName: ['Stage', 'Аня', 'Max', 'Лиза'][i % 4], avatarColor: ['#4B73BB', '#7A4BBB', '#BB4B6A', '#2E8C7A'][i % 4], avatarFrame: frame, seal: 'platina' } as unknown as User);

export default function PreviewDecor() {
  const light = typeof window !== 'undefined' && window.location.search.includes('p=1');
  const t = light ? palette.light : palette.dark;
  return <SafeAreaProvider><ThemeContext.Provider value={t}>
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: 18, gap: 18 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 30, columnGap: 8, justifyContent: 'space-between' }}>
        {DECORATIONS.map((d, i) => <View key={d.id} style={{ width: 108, alignItems: 'center', gap: 22, paddingTop: 16 }}>
          <DecoratedAvatar user={user(d.id, i)} api={api} size={72} animated />
          <Text style={{ color: t.muted, fontSize: 12, fontWeight: '600' }}>{d.label}</Text>
        </View>)}
      </View>
      <View style={{ borderRadius: 22, backgroundColor: t.surface, overflow: 'hidden' }}>
        {DECORATIONS.slice(0, 5).map((d, i) => <View key={d.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10 }}>
          <DecoratedAvatar user={user(d.id, i)} api={api} size={54} />
          <View style={{ flex: 1 }}><Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>{user(d.id, i).displayName}</Text><Text style={{ color: t.muted, fontSize: 14 }}>Привет, глянь это</Text></View>
        </View>)}
      </View>
    </ScrollView>
  </ThemeContext.Provider></SafeAreaProvider>;
}
