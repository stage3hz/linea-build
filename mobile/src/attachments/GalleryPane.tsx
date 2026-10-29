import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Linking, Platform, Pressable, View } from 'react-native';
import { Text } from '../typography';
import { Image } from 'expo-image';
import { Button, Icon, Notice } from '../components';
import { useTheme } from '../theme';
import { createVideoThumbnails } from './gallery';
import { durationLabel, type GalleryItem } from './selection';
import type { ThumbnailSession } from './ThumbnailSession';
import { useGallery } from './useGallery';

function GalleryCell({ item, number, disabled, thumbnails, onToggle, onEdit }: {
  item: GalleryItem; number: number; disabled: boolean; thumbnails: ThumbnailSession | null;
  onToggle: (item: GalleryItem) => void; onEdit: (item: GalleryItem) => void;
}) {
  const t = useTheme();
  const direct = item.kind === 'photo' || Platform.OS === 'ios';
  const [uri, setUri] = useState<string | null>(direct ? item.file.uri : null), [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setFailed(false); setUri(direct ? item.file.uri : null);
    if (!direct && thumbnails) void thumbnails.get(item.id, item.file.uri).then(value => { if (live) setUri(value); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [item.id, item.file.uri, direct, thumbnails]);
  return <View style={{ width: '33.333333%', aspectRatio: 1, padding: 2 }}>
    <Pressable disabled={disabled} accessibilityRole="button" accessibilityLabel={item.kind === 'photo' ? `Редактировать ${item.file.name}` : `Выбрать видео ${item.file.name}`} onPress={() => item.kind === 'photo' ? onEdit(item) : onToggle(item)}
      style={{ flex: 1, overflow: 'hidden', borderRadius: 13, backgroundColor: t.surface2, borderWidth: number ? 2 : 0, borderColor: t.accent, opacity: disabled ? .65 : 1 }}>
      {uri && !failed ? <Image source={{ uri }} contentFit="cover" recyclingKey={item.id} cachePolicy="memory" transition={100} style={{ flex: 1 }} onError={() => setFailed(true)} /> : <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 5 }}>
        {failed ? <><Icon name={item.kind === 'video' ? 'videocam-outline' : 'image-outline'} color={t.muted} size={27} /><Text style={{ color: t.muted, fontSize: 9 }}>Нет миниатюры</Text></> : <ActivityIndicator color={t.muted} size="small" />}
      </View>}
      {item.kind === 'video' ? <View pointerEvents="none" style={{ position: 'absolute', left: 6, bottom: 6, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(0,0,0,.55)', paddingHorizontal: 6, paddingVertical: 3, borderRadius: 7 }}><Icon name="videocam" size={11} color="#FFF" /><Text style={{ color: '#FFF', fontSize: 10, fontWeight: '600' }}>{durationLabel(item.duration)}</Text></View> : null}
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: !!number, disabled }} accessibilityLabel={`${number ? 'Убрать из выбора' : 'Выбрать'} ${item.file.name}${number ? `, номер ${number}` : ''}`} disabled={disabled}
        onPress={event => { event.stopPropagation(); onToggle(item); }} style={{ position: 'absolute', right: 0, top: 0, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: 25, height: 25, borderRadius: 13, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#FFF', backgroundColor: number ? t.accent : 'rgba(0,0,0,.28)' }}>
          {number ? <Text style={{ color: t.onAccent, fontSize: 12, fontWeight: '800' }}>{number}</Text> : null}
        </View>
      </Pressable>
    </Pressable>
  </View>;
}

export function GalleryPane({ active, selectedIds, disabled, onToggle, onEdit, onFallback }: {
  active: boolean; selectedIds: string[]; disabled: boolean; onToggle: (item: GalleryItem) => void; onEdit: (item: GalleryItem) => void; onFallback: () => void;
}) {
  const t = useTheme(), gallery = useGallery(active);
  const [thumbnails, setThumbnails] = useState<ThumbnailSession | null>(null);
  const numbers = useMemo(() => new Map(selectedIds.map((id, index) => [id, index + 1])), [selectedIds]);
  useEffect(() => {
    if (!active) { setThumbnails(null); return; }
    const session = createVideoThumbnails(); setThumbnails(session);
    return () => session.close();
  }, [active]);
  const help = { color: t.muted, fontSize: 12, lineHeight: 17 };
  if (Platform.OS === 'web') return <View style={{ padding: 18, gap: 14 }}><Icon name="phone-portrait-outline" color={t.accent} size={32} /><Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>Галерея устройства — в мобильной версии</Text><Text style={help}>Веб-версия не читает медиатеку телефона. Можно открыть системный выбор файлов; обработка и отправка со сквозным шифрованием требуют приложения Android или iPhone.</Text><Button secondary label="Выбрать файл" icon="folder-open-outline" onPress={onFallback} disabled={disabled} /></View>;
  const allowed = gallery.permission?.granted || gallery.permission?.accessPrivileges === 'limited';
  const permissionDenied = !!gallery.permission && !allowed;
  return <View style={{ flex: 1, gap: 8 }}>
    {gallery.permission?.accessPrivileges === 'limited' ? <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', paddingHorizontal: 7 }}><Text style={[help, { flex: 1, fontSize: 11 }]}>Показаны только разрешённые фото и видео.</Text><Pressable accessibilityRole="button" disabled={disabled} onPress={() => void gallery.addAccess()} style={{ padding: 10 }}><Text style={{ color: t.accent, fontWeight: '600', fontSize: 12 }}>Добавить доступ</Text></Pressable></View> : null}
    {gallery.error ? <View style={{ paddingHorizontal: 5, gap: 8 }}><Notice text={gallery.error} error onRetry={() => void gallery.refresh()} /><Button secondary label="Системный выбор фото и видео" onPress={onFallback} disabled={disabled} /></View> : null}
    {permissionDenied ? <View style={{ padding: 18, gap: 14 }}><Icon name="images-outline" color={t.accent} size={34} /><Text style={{ color: t.text, fontSize: 16, fontWeight: '700' }}>Открой доступ к галерее</Text><Text style={help}>Можно разрешить только выбранные фото и видео. Остальные файлы останутся недоступны приложению.</Text><Button label={gallery.permission?.canAskAgain ? 'Разрешить доступ' : 'Открыть настройки'} onPress={() => { if (gallery.permission?.canAskAgain) void gallery.refresh('request'); else void Linking.openSettings(); }} disabled={disabled} /><Button secondary label="Выбрать через системное окно" onPress={onFallback} disabled={disabled} /></View> : <>
      <FlatList data={gallery.items} numColumns={3} keyExtractor={item => item.id} extraData={numbers} initialNumToRender={12} maxToRenderPerBatch={9} windowSize={3} showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 8, flexGrow: gallery.items.length ? 0 : 1 }} onEndReachedThreshold={.5} onEndReached={() => { if (gallery.hasMore) void gallery.more(); }}
        ListEmptyComponent={<View style={{ flex: 1, minHeight: 145, alignItems: 'center', justifyContent: 'center', gap: 12 }}>{gallery.loading ? <ActivityIndicator color={t.accent} /> : <><Icon name="images-outline" color={t.subtle} size={35} /><Text style={help}>{gallery.error ? 'Галерея пока недоступна' : 'В разрешённой галерее пока нет фото или видео'}</Text></>}</View>}
        ListFooterComponent={gallery.loading && gallery.items.length ? <ActivityIndicator color={t.accent} style={{ padding: 14 }} /> : gallery.hasMore && gallery.error ? <Button secondary label="Повторить загрузку" onPress={() => void gallery.more()} /> : null}
        renderItem={({ item }) => <GalleryCell item={item} number={numbers.get(item.id) || 0} disabled={disabled} thumbnails={thumbnails} onToggle={onToggle} onEdit={onEdit} />} />
      <Text style={[help, { textAlign: 'center', fontSize: 10 }]}>Угол — выбрать · центр фото — редактор</Text>
    </>}
  </View>;
}
