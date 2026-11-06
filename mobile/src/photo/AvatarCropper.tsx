// Telegram-style avatar picker: the chosen photo fills the screen, a round window shows exactly what
// the avatar will be (the rest is dimmed), one finger moves the photo, two fingers zoom (up to 5×).
// «Готово» returns the square of the source image under the circle (see avatarCrop.ts).
import React from 'react';
import { Image, Modal, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { Text } from '../typography';
import { MAX_AVATAR_ZOOM, avatarCrop, coverScale, type CropRect } from './avatarCrop';

export function AvatarCropper({ uri, width, height, onCancel, onDone }: { uri: string; width: number; height: number; onCancel: () => void; onDone: (crop: CropRect) => void }) {
  const win = useWindowDimensions(); const insets = useSafeAreaInsets();
  const viewport = Math.min(win.width - 32, 380);
  const cx = win.width / 2, cy = win.height / 2;
  const base = coverScale(width, height, viewport);
  const zoom = useSharedValue(1), tx = useSharedValue(0), ty = useSharedValue(0);
  const startZoom = useSharedValue(1), startX = useSharedValue(0), startY = useSharedValue(0);

  const clamp = (value: number, limit: number) => { 'worklet'; return Math.max(-limit, Math.min(limit, value)); };
  const limits = (z: number) => { 'worklet'; const s = base * z; return { x: Math.max(0, (width * s - viewport) / 2), y: Math.max(0, (height * s - viewport) / 2) }; };

  const pan = Gesture.Pan().averageTouches(true)
    .onStart(() => { startX.value = tx.value; startY.value = ty.value; })
    .onUpdate(e => { const m = limits(zoom.value); tx.value = clamp(startX.value + e.translationX, m.x); ty.value = clamp(startY.value + e.translationY, m.y); });
  const pinch = Gesture.Pinch()
    .onStart(() => { startZoom.value = zoom.value; })
    .onUpdate(e => {
      zoom.value = Math.max(1, Math.min(MAX_AVATAR_ZOOM, startZoom.value * e.scale));
      const m = limits(zoom.value); tx.value = clamp(tx.value, m.x); ty.value = clamp(ty.value, m.y);
    });
  const doubleTap = Gesture.Tap().numberOfTaps(2).onEnd(() => {
    const next = zoom.value > 1.5 ? 1 : 2.5; zoom.value = withTiming(next);
    const m = limits(next); tx.value = withTiming(clamp(tx.value, m.x)); ty.value = withTiming(clamp(ty.value, m.y));
  });
  const gesture = Gesture.Simultaneous(pan, pinch, doubleTap);

  const photo = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: zoom.value }] }));
  const r = viewport / 2;
  // Dim everything except the circle (even-odd: the circle is a hole in the full-screen rectangle).
  const mask = `M0 0H${win.width}V${win.height}H0Z M${cx - r} ${cy} a${r} ${r} 0 1 0 ${viewport} 0 a${r} ${r} 0 1 0 ${-viewport} 0Z`;

  const done = () => onDone(avatarCrop({ width, height, viewport, zoom: zoom.value, tx: tx.value, ty: ty.value }));
  return <Modal visible animationType="fade" onRequestClose={onCancel} statusBarTranslucent supportedOrientations={['portrait']}>
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#000' }}>
      <GestureDetector gesture={gesture}>
        <View style={StyleSheet.absoluteFill}>
          <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: cx - (width * base) / 2, top: cy - (height * base) / 2, width: width * base, height: height * base }, photo]}>
            <Image source={{ uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
          </Animated.View>
          <Svg pointerEvents="none" width={win.width} height={win.height} style={StyleSheet.absoluteFill}>
            <Path d={mask} fill="rgba(0,0,0,0.62)" fillRule="evenodd" />
            <Path d={`M${cx - r} ${cy} a${r} ${r} 0 1 0 ${viewport} 0 a${r} ${r} 0 1 0 ${-viewport} 0Z`} fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth={1.5} />
          </Svg>
        </View>
      </GestureDetector>
      <View pointerEvents="none" style={{ position: 'absolute', top: insets.top + 18, left: 0, right: 0, alignItems: 'center' }}>
        <Text style={{ color: '#FFF', fontSize: 17, fontWeight: '700' }}>Фото профиля</Text>
        <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, marginTop: 4 }}>Двигай и приближай фото пальцами</Text>
      </View>
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + 20, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 24 }}>
        <Pressable accessibilityRole="button" onPress={onCancel} hitSlop={10} style={({ pressed }) => ({ paddingVertical: 12, paddingHorizontal: 8, opacity: pressed ? .6 : 1 })}><Text style={{ color: '#FFF', fontSize: 17 }}>Отмена</Text></Pressable>
        <Pressable accessibilityRole="button" onPress={done} hitSlop={10} style={({ pressed }) => ({ paddingVertical: 12, paddingHorizontal: 8, opacity: pressed ? .6 : 1 })}><Text style={{ color: '#FFF', fontSize: 17, fontWeight: '700' }}>Готово</Text></Pressable>
      </View>
    </GestureHandlerRootView>
  </Modal>;
}
