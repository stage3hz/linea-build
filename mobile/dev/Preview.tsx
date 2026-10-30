// Dev-only visual check of message bubbles (rendered with react-native-web). Not part of the app.
import React, { useRef } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ThemeContext, palette } from '../src/theme';
import { GlassStage } from '../src/glass';
import { Api } from '../src/api';
import { MessageRow, type Row, type RowHandlers } from '../src/MessageRow';

const thumb = { mimeType: 'image/jpeg' as const, base64: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAYACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDBjh9qtRw+1Sxw+1Wo4favYnUPPw9Yhjh9qtRw+1Sxw+1Wo4fauWdQ+gw9Yoxw+1Wo4faiis5yZ8bh5Msxw+1Wo4faiiuScmfQYeTP/9k=', width: 32, height: 24 };
const at = '2026-10-30T10:46:00.000Z';
let n = 0;
const msg = (o: any): any => ({ id: ++n, chatId: 'c', senderId: o.mine ? 'me' : 'peer', clientId: 'k' + n, text: '', attachment: null, createdAt: at, cryptoState: 'decrypted', edited: false, reactions: [], ...o });
const photo = { id: 'p1', name: 'IMG_1.jpg', mimeType: 'image/jpeg', size: 99999999, media: { width: 1280, height: 960 }, preview: thumb };
const video = { id: 'v1', name: 'clip.mp4', mimeType: 'video/mp4', size: 99999999, media: { width: 720, height: 1280, durationMs: 7000 }, preview: thumb };
const doc = { id: 'd1', name: 'Рапорт на БР по ЛС.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 25000, encryption: {} };
const reply = { clientId: 'x', senderId: 'peer', preview: 'Ну у тебя логин и юзер одинаковый' };
const rows: Row[] = [
  msg({ text: 'Обычное сообщение' }),
  msg({ mine: true, text: 'А у тебя не одинаковый разве?', meta: { reply } }),
  msg({ text: 'Фото с подписью, длинной на пару строк, чтобы проверить перенос', attachment: photo, reactions: [{ emoji: '❤️', count: 1, mine: true }] }),
  msg({ mine: true, text: 'Ответ с фото', attachment: photo, meta: { reply } }),
  msg({ text: 'Видео с подписью', attachment: video, meta: { forward: { from: 'stage' } } }),
  msg({ mine: true, text: 'Документ с подписью', attachment: doc, meta: { reply } }),
  msg({ attachment: photo }),
  msg({ mine: true, text: 'Реакции в пузыре', reactions: [{ emoji: '👍', count: 2, mine: false }, { emoji: '🔥', count: 1, mine: true }] }),
].map(m => ({ key: 'm' + m.id, message: m, createdAt: m.createdAt }));

export default function Preview() {
  const handlers = useRef<RowHandlers>({ actions() {}, jumpTo() {}, open() {}, react() {}, retry() {}, reply() {}, vote() {}, toggleSelect() {} });
  const api = new Api('https://example.invalid', 'token');
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider><ThemeContext.Provider value={palette.dark}><GlassStage>
    <ScrollView contentContainerStyle={{ padding: 15, width: 390 }}>
      {rows.map((row, i) => <MessageRow key={row.key} row={row} olderCreatedAt={i ? row.createdAt : undefined} mine={row.message!.senderId === 'me'} author="x" peerLastRead={0} wide={false} fontSize={15} lineHeight={22} downloading={false} replyAuthor="Ты" replyText={reply.preview} api={api} handlers={handlers} selecting={false} selected={false} fresh={false} />)}
    </ScrollView>
  </GlassStage></ThemeContext.Provider></SafeAreaProvider></GestureHandlerRootView>;
}
