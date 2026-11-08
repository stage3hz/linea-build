import React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text } from '../typography';
import { Empty, Icon, IconButton } from '../components';
import { GlassStage } from '../glass';
import { useTheme } from '../theme';
import { canResend, countScheduled, failureText, formatDeliverAt, type ScheduledItem } from './model';

/**
 * «Отложенные сообщения» of one chat (Telegram: the clock in the chat header). Each item shows when it
 * goes out and its text as this device still holds it; «Отправить сейчас» releases it at once, the bin
 * deletes it before it is sent. A «не удалось» item (the peer's devices changed) is re-encrypted and
 * sent by the app by itself as soon as it is online — the row says so.
 */
export function ScheduledScreen({ visible, items, peerName, busy, onClose, onSendNow, onDelete }: {
  visible: boolean; items: ScheduledItem[]; peerName: string; busy: ReadonlySet<string>;
  onClose: () => void; onSendNow: (item: ScheduledItem) => void; onDelete: (item: ScheduledItem) => void;
}) {
  const t = useTheme();
  if (!visible) return null;
  return <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}><GlassStage><SafeAreaView style={{ flex: 1 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10 }}>
      <IconButton name="close" label="Закрыть" onPress={onClose} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: t.text, fontSize: 17, fontWeight: '700' }} numberOfLines={1}>Отложенные сообщения</Text>
        <Text style={{ color: t.muted, fontSize: 12 }} numberOfLines={1}>{items.length ? countScheduled(items.length) : peerName}</Text>
      </View>
    </View>
    {items.length ? <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 10 }}>
      <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17, paddingHorizontal: 4 }}>Сообщение уже зашифровано на этом устройстве и уйдёт само в выбранное время, даже если телефон будет выключен. Сервер видит только зашифрованные данные.</Text>
      {items.map(item => {
        const failed = item.status === 'failed'; const working = busy.has(item.id);
        const body = item.text?.trim() ? item.text : item.attachment ? `📎 ${item.attachment.name}` : item.cryptoState === 'decrypted' ? '' : 'Отложено с другого устройства';
        return <View key={item.id} testID="scheduled-item" style={{ borderRadius: 20, padding: 14, gap: 8, backgroundColor: t.surface2, borderWidth: 1, borderColor: failed ? t.danger : t.border }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Icon name={failed ? 'alert-circle-outline' : 'time-outline'} size={18} color={failed ? t.danger : t.accent} />
            <Text style={{ flex: 1, color: failed ? t.danger : t.accent, fontSize: 13, fontWeight: '700' }}>{formatDeliverAt(item.deliverAt)}</Text>
            {item.meta?.silent ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: t.accentSoft }}><Icon name="volume-mute-outline" size={13} color={t.accent} /><Text style={{ color: t.accent, fontSize: 11, fontWeight: '600' }}>без звука</Text></View> : null}
          </View>
          <Text raw numberOfLines={6} style={{ color: t.text, fontSize: 15, lineHeight: 21 }}>{body}</Text>
          {failed ? <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>{canResend(item) ? failureText(item.failure) : `${failureText(item.failure)} Отправить заново можно только с устройства, где сообщение написано.`}</Text> : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 }}>
            <Pressable accessibilityRole="button" disabled={working || (failed && !canResend(item))} onPress={() => onSendNow(item)} style={({ pressed }) => ({ flex: 1, height: 40, borderRadius: 14, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6, opacity: working || (failed && !canResend(item)) ? .45 : pressed ? .75 : 1 })}>
              {working ? <ActivityIndicator size="small" color={t.onAccent} /> : <Icon name="paper-plane-outline" size={17} color={t.onAccent} />}
              <Text style={{ color: t.onAccent, fontSize: 14, fontWeight: '700' }}>Отправить сейчас</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Удалить отложенное сообщение" disabled={working} onPress={() => onDelete(item)} style={({ pressed }) => ({ width: 44, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: t.accentSoft, opacity: working ? .45 : pressed ? .6 : 1 })}><Icon name="trash-outline" size={19} color={t.danger} /></Pressable>
          </View>
        </View>;
      })}
    </ScrollView> : <View style={{ flex: 1, justifyContent: 'center', padding: 24 }}><Empty icon="time-outline" title="Нет отложенных сообщений" description="Удержи кнопку отправки и выбери «Отправить позже» — сообщение уйдёт в нужное время." /></View>}
  </SafeAreaView></GlassStage></Modal>;
}
