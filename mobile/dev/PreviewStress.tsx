// Dev-only layout stress test: extreme text (very long names/usernames/messages, one char, emoji),
// rendered with react-native-web. Not part of the app. ?p=1 light, ?p=0 dark.
import React, { useRef } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ThemeContext, palette } from '../src/theme';
import { GlassStage, GlassSurface } from '../src/glass';
import { Text } from '../src/typography';
import { MessageRow, type Row, type RowHandlers } from '../src/MessageRow';
import { Api } from '../src/api';

const at = '2026-10-30T10:46:00.000Z';
let n = 0;
const msg = (o: any): any => ({ id: ++n, chatId: 'c', senderId: o.mine ? 'me' : 'peer', clientId: 'k' + n, text: '', attachment: null, createdAt: at, cryptoState: 'decrypted', edited: false, reactions: [], ...o });

const longName = 'Александр-Константинопольский Вячеславович';
const longWord = 'Супердлинноесловобезпробеловкотороедолжнопереноситьсяаненарушатьвёрстку';
const bigText = 'Очень длинное сообщение на несколько строк, в конце которого должно поместиться время и не наехать на текст. ' + longWord;

const rows: Row[] = [
  msg({ text: 'А' }),
  msg({ mine: true, text: 'Б' }),
  msg({ text: '😀' }),
  msg({ mine: true, text: bigText }),
  msg({ text: longWord }),
  msg({ mine: true, text: 'Короткое с временем' }),
].map(m => ({ key: 'm' + m.id, message: m, createdAt: m.createdAt }));

function Screen({ theme }: { theme: any }) {
  const handlers = useRef<RowHandlers>({ actions() {}, jumpTo() {}, open() {}, react() {}, retry() {}, reply() {}, vote() {}, toggleSelect() {} });
  const api = new Api('https://example.invalid', 'token');
  return <ThemeContext.Provider value={theme}><GlassStage>
    <ScrollView contentContainerStyle={{ paddingVertical: 20, gap: 14 }}>
      {/* Chat header pill with a very long name — must ellipsize, not collide */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12 }}>
        <GlassSurface material="regular" radius={26} interactive contentStyle={{ height: 44, width: 44, alignItems: 'center', justifyContent: 'center' }}><Text>‹</Text></GlassSurface>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <GlassSurface material="regular" radius={22} interactive style={{ maxWidth: '100%' }} contentStyle={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 18, paddingVertical: 3 }}>
            <View style={{ alignItems: 'center', gap: 1 }}>
              <Text numberOfLines={1} style={{ color: theme.text, fontSize: 16, fontWeight: '600' }}>{longName}</Text>
              <Text numberOfLines={1} style={{ color: theme.muted, fontSize: 12 }}>в сети</Text>
            </View>
          </GlassSurface>
        </View>
        <GlassSurface material="regular" radius={22} interactive contentStyle={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><Text>📞</Text></GlassSurface>
      </View>
      {/* Message bubbles */}
      <View style={{ paddingHorizontal: 4 }}>
        {rows.map((row, i) => <MessageRow key={row.key} row={row} olderCreatedAt={i ? row.createdAt : undefined} mine={row.message!.senderId === 'me'} author="x" peerLastRead={99} wide={false} fontSize={17} lineHeight={22} downloading={false} replyAuthor="Ты" replyText="" api={api} handlers={handlers} selecting={false} selected={false} fresh={false} />)}
      </View>
      {/* A settings-style row with long value */}
      <GlassSurface radius={20} shadow={false} style={{ marginHorizontal: 12 }} contentStyle={{ padding: 16, gap: 4 }}>
        <Text style={{ color: theme.accent, fontSize: 15 }} numberOfLines={1}>@{longWord}</Text>
        <Text style={{ color: theme.muted, fontSize: 12 }}>Имя пользователя</Text>
      </GlassSurface>
    </ScrollView>
  </GlassStage></ThemeContext.Provider>;
}

export default function PreviewStress() {
  const light = typeof window !== 'undefined' && window.location.search.includes('p=1');
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider>
    <Screen theme={light ? palette.light : palette.dark} />
  </SafeAreaProvider></GestureHandlerRootView>;
}
