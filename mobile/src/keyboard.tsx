import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Dimensions, Keyboard, LayoutAnimation, Platform, View, type KeyboardEvent, type StyleProp, type ViewStyle } from 'react-native';

/**
 * Replacement for KeyboardAvoidingView on iOS.
 *
 * RN's KeyboardAvoidingView compares the keyboard top with its own frame from
 * onLayout, which is relative to the parent, not the window. Inside a safe-area
 * container that frame is offset by the status bar / header, so the computed
 * padding can come out too small and the keyboard covers the composer — most
 * visibly after the keyboard height changes (predictive bar, emoji, language).
 *
 * Here the overlap is measured in window coordinates on every frame change.
 * Android uses windowSoftInputMode=adjustResize (softwareKeyboardLayoutMode),
 * so no extra padding is applied there.
 */
export function KeyboardSafeView({ style, children }: { style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  const ref = useRef<View>(null);
  const [inset, setInset] = useState(0);
  const lastKeyboardTop = useRef<number | null>(null);

  const apply = useCallback((keyboardTop: number | null, duration?: number) => {
    lastKeyboardTop.current = keyboardTop;
    const node = ref.current;
    if (!node) return;
    node.measureInWindow((_x, y, _width, height) => {
      // Outer frame of the flex container; our paddingBottom does not change it.
      const bottom = y + height;
      const windowHeight = Dimensions.get('window').height;
      const top = keyboardTop ?? windowHeight;
      setInset(previous => {
        const next = Math.max(0, Math.round(bottom - top));
        if (next !== previous && duration !== undefined) {
          LayoutAnimation.configureNext({ duration: Math.max(duration, 10), update: { type: LayoutAnimation.Types.keyboard } });
        }
        return next;
      });
    });
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const change = (event: KeyboardEvent) => apply(event.endCoordinates.screenY, event.duration);
    const hide = (event: KeyboardEvent) => apply(null, event.duration);
    const subscriptions = [
      Keyboard.addListener('keyboardWillChangeFrame', change),
      Keyboard.addListener('keyboardDidChangeFrame', event => apply(event.endCoordinates.screenY)),
      Keyboard.addListener('keyboardWillHide', hide),
      Keyboard.addListener('keyboardDidHide', () => apply(null)),
    ];
    return () => subscriptions.forEach(subscription => subscription.remove());
  }, [apply]);

  return <View
    ref={ref}
    style={[style, Platform.OS === 'ios' ? { paddingBottom: inset } : null]}
    onLayout={() => { if (Platform.OS === 'ios' && lastKeyboardTop.current !== null) apply(lastKeyboardTop.current); }}
  >{children}</View>;
}
