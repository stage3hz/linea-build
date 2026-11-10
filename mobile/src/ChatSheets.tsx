// Confirmations and choosers shared by the chat list, the person's profile and the PC chat header's ⋮ menu
// (Telegram Web's HeaderMenuContainer): «Автоудаление», «Заблокировать …?» and «Удалить чат?».
import React from 'react';
import { Text } from './typography';
import { Sheet, SheetAction } from './components';
import { useTheme } from './theme';
import { lightFeedback } from './haptics';
import { refreshFriendRequests } from './friendRequests';
import { AUTO_DELETE, autoDeleteLabel, type ChatRules } from './messageMeta';
import type { Api } from './api';
import type { Chat } from './types';

/** «Автоудаление»: the encrypted chat rule's timer. `onPick` gets a new value only (the sheet closes either way). */
export function AutoDeleteSheet({ visible, rules, onClose, onPick }: { visible: boolean; rules: ChatRules; onClose: () => void; onPick: (ttl: number) => void }) {
  const t = useTheme();
  return <Sheet visible={visible} title="Автоудаление" onClose={onClose}>
    <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19, marginBottom: 6 }}>Новые сообщения в этом чате удалятся у вас обоих через выбранное время. Собеседник увидит, что автоудаление включено.</Text>
    {AUTO_DELETE.map(ttl => <SheetAction key={ttl} icon={rules.ttl === ttl ? 'checkmark-circle' : 'ellipse-outline'} label={ttl ? autoDeleteLabel(ttl) : 'Выключено'} selected={rules.ttl === ttl} onPress={() => { onClose(); if (ttl !== rules.ttl) { lightFeedback(); onPick(ttl); } }} />)}
  </Sheet>;
}
export const autoDeleteNotice = (ttl: number) => ttl ? `Автоудаление: ${autoDeleteLabel(ttl)}` : 'Автоудаление выключено';

/** «Запретить / Разрешить пересылку и копирование»: the menu item's label and icon for the current rule, and the line shown after the switch. */
export const noCopyItem = (noCopy: boolean) => noCopy ? { icon: 'lock-closed' as const, label: 'Разрешить пересылку и копирование' } : { icon: 'lock-open-outline' as const, label: 'Запретить пересылку и копирование' };
export const noCopyNotice = (wasNoCopy: boolean) => wasNoCopy ? 'Копирование снова разрешено' : 'Копировать и пересылать сообщения этого чата теперь нельзя обоим';

/** «Заблокировать …?» before blocking; unblocking needs no confirmation. */
export function BlockSheet({ visible, name, onClose, onConfirm }: { visible: boolean; name: string; onClose: () => void; onConfirm: () => void }) {
  return <Sheet visible={visible} title={`Заблокировать ${name}?`} onClose={onClose}>
    <SheetAction icon="remove-circle-outline" label="Заблокировать" description="Он не сможет писать и звонить тебе, пока ты не разблокируешь. Список — в Безопасности." danger onPress={onConfirm} />
  </Sheet>;
}
/** Blocks or unblocks the person; blocking also drops a friend request between you. Returns the line to show. */
export async function setUserBlocked(api: Api, userId: string, block: boolean): Promise<string> {
  if (block) { await api.block(userId); void refreshFriendRequests(api); } else await api.unblock(userId);
  return block ? 'Заблокирован: он не сможет тебе писать и звонить' : 'Разблокирован';
}

/** «Удалить чат?»: for me (this device) or for both (server). */
export function RemoveChatSheet({ chats, onClose, onRemove, onRemoveForEveryone }: { chats: Chat[] | null; onClose: () => void; onRemove: (chats: Chat[]) => void; onRemoveForEveryone: (chats: Chat[]) => void }) {
  return <Sheet visible={!!chats} title={chats && chats.length > 1 ? `Удалить чаты (${chats.length})?` : 'Удалить чат?'} onClose={onClose}>
    <SheetAction icon="trash-outline" label="Удалить у меня" description="Чат и загруженные сообщения исчезнут на этом устройстве. Если собеседник напишет снова, чат вернётся." danger onPress={() => { const list = chats || []; onClose(); lightFeedback(); onRemove(list); }} />
    <SheetAction icon="people-outline" label="Удалить у меня и у собеседника" description="Чат, все сообщения и файлы будут удалены на сервере и у обоих. Отменить нельзя." danger onPress={() => { const list = chats || []; onClose(); lightFeedback(); onRemoveForEveryone(list); }} />
  </Sheet>;
}
