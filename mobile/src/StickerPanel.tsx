import { motionEnabled } from './motion';
// Emoji stickers below the composer: a tap sends one large emoji, which the
// chat shows without a bubble, like Telegram's big emoji. No images are
// downloaded from third-party sticker services.
import React, { useEffect, useRef, useState } from 'react';
import { Animated, FlatList, Pressable, View, useWindowDimensions } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Text } from './typography';
import { Icon } from './components';
import { useTheme } from './theme';
import { menuSurface } from './ContextMenu';

const SETS: { id: string; icon: string; items: string[] }[] = [
  { id: 'faces', icon: '😀', items: ['😀','😃','😄','😁','😆','🥹','😅','😂','🤣','🥲','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🥸','🤩','🥳','😏','😒','😞','😔','😟','😕','🙁','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🤗','🤔','🫣','🤭','🫢','🫡','🤫','🫠','🤥','😶','🫥','😐','🫤','😑','😬','🙄','😯','😦','😧','😮','😲','🥱','😴','🤤','😪','😵','🤐','🥴','🤢','🤮','🤧','😷','🤒','🤕','🤑','🤠','😈','👿','👻','💀','☠️','👽','🤖','🎃','😺','😸','😹','😻','😼','😽','🙀','😿','😾'] },
  { id: 'hands', icon: '👍', items: ['👍','👎','👌','🤌','🤏','✌️','🤞','🫰','🤟','🤘','🤙','👈','👉','👆','👇','☝️','✋','🤚','🖐️','🖖','👋','🫶','👏','🙌','👐','🤲','🤝','🙏','✍️','💪','🦾','🫵','👀','🧠','🫀','👄','💋'] },
  { id: 'hearts', icon: '❤️', items: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❤️‍🔥','❤️‍🩹','💕','💞','💓','💗','💖','💘','💝','💟','✨','🔥','💯','💥','💫','⭐','🌟','⚡','🎉','🎊','🎁','🏆','🥇','👑','💎','🎈'] },
  { id: 'animals', icon: '🐶', items: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐻‍❄️','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐔','🐧','🐦','🐤','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🦋','🐌','🐞','🐢','🐍','🦖','🐙','🦑','🦀','🐡','🐠','🐬','🐳','🦈','🐊','🐘','🦒','🦔','🐾'] },
  { id: 'food', icon: '🍕', items: ['🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🥑','🍆','🥦','🌶️','🌽','🥕','🥐','🍞','🧀','🍳','🥞','🥓','🍔','🍟','🍕','🌭','🥪','🌮','🌯','🍝','🍜','🍣','🍱','🍩','🍪','🎂','🍰','🧁','🍫','🍬','🍭','🍿','☕','🍵','🧃','🥤','🧋','🍺','🍷','🥂','🍾'] },
  { id: 'activity', icon: '⚽', items: ['⚽','🏀','🏈','⚾','🎾','🏐','🏉','🎱','🏓','🏸','🥊','🥋','⛳','⛸️','🎿','🛹','🏂','🏋️','🚴','🏊','🎮','🕹️','🎲','🧩','🎯','🎳','🎸','🎹','🥁','🎤','🎧','🎬','🎨','📸','🚗','🏎️','✈️','🚀','🛸','🏖️','🏝️','🌋','🌈','☀️','🌙','❄️','☔','🌊'] },
];
const RECENT_KEY = 'linea.stickers.recent.v1';

export function StickerPanel({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const t = useTheme(); const { width } = useWindowDimensions();
  const [set, setSet] = useState('recent'); const [recent, setRecent] = useState<string[]>([]);
  const lift = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!motionEnabled()) lift.setValue(1); else Animated.spring(lift, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 4 }).start();
    AsyncStorage.getItem(RECENT_KEY).then(raw => { try { const list = JSON.parse(raw || '[]'); if (Array.isArray(list)) { const clean = list.filter((x: unknown) => typeof x === 'string').slice(0, 32); setRecent(clean); if (!clean.length) setSet('faces'); } } catch { setSet('faces'); } }).catch(() => setSet('faces'));
  }, []);
  const pick = (emoji: string) => {
    onPick(emoji);
    setRecent(current => { const next = [emoji, ...current.filter(x => x !== emoji)].slice(0, 32); void AsyncStorage.setItem(RECENT_KEY, JSON.stringify(next)).catch(() => {}); return next; });
  };
  const items = set === 'recent' ? recent : SETS.find(item => item.id === set)?.items || [];
  // On a wide window (PC) the panel is a compact 382×420 popover at the right edge of the composer, the size Telegram Web uses.
  const wide = width >= 700; const panelWidth = wide ? 382 : width - 24; const cell = wide ? 44 : 54;
  const columns = Math.max(6, Math.floor((panelWidth - 16) / cell));
  return <Animated.View style={{ height: wide ? 420 : 290, width: panelWidth, alignSelf: wide ? 'flex-end' : 'center', ...(wide ? { position: 'absolute' as const, right: 0, bottom: 66, zIndex: 50 } : null), marginHorizontal: 12, marginBottom: 10, borderRadius: wide ? 18 : 26, overflow: 'hidden', backgroundColor: wide ? menuSurface(t).replace(/[\d.]+\)$/, '1)') : menuSurface(t), shadowColor: '#000', shadowOpacity: wide ? 0.28 : 0, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, borderWidth: 1, borderColor: t.border, opacity: lift, transform: [{ translateY: lift.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }) }] }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingTop: 6, gap: 2 }}>
      {[{ id: 'recent', icon: '' }, ...SETS].map(item => <Pressable key={item.id} onPress={() => setSet(item.id)} accessibilityRole="tab" accessibilityState={{ selected: set === item.id }} style={{ width: 40, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: set === item.id ? t.accentSoft : 'transparent' }}>{item.id === 'recent' ? <Icon name="time-outline" size={19} color={set === item.id ? t.accent : t.muted} /> : <Text style={{ fontSize: 20 }}>{item.icon}</Text>}</Pressable>)}
      <View style={{ flex: 1 }} />
      <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Скрыть стикеры" style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center' }}><Icon name="chevron-down" size={20} color={t.muted} /></Pressable>
    </View>
    {items.length ? <FlatList key={`${set}-${columns}`} data={items} numColumns={columns} keyExtractor={(item, index) => `${item}-${index}`} contentContainerStyle={{ padding: 8 }} keyboardShouldPersistTaps="handled"
      renderItem={({ item }) => <Pressable onPress={() => pick(item)} accessibilityRole="button" accessibilityLabel={`Отправить ${item}`} style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({ flex: 1 / columns, aspectRatio: 1, borderRadius: 10, backgroundColor: hovered ? t.accentSoft : 'transparent', alignItems: 'center', justifyContent: 'center', transform: [{ scale: pressed ? 1.25 : 1 }] })}><Text style={{ fontSize: wide ? 27 : 34 }}>{item}</Text></Pressable>} />
      : <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: t.muted, fontSize: 13 }}>Здесь появятся недавние</Text></View>}
  </Animated.View>;
}
