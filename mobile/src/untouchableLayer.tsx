// A native decorative layer (the snow, the pixel trail) inside a React view of its own.
//
// On Android React Native finds the JS touch target by coordinates and honours `pointerEvents="none"` only on its
// own views: a native view of another kind is taken for one that wants the touch. The snow's front layer lies over
// every screen, so every tap on a button was addressed to it and no button reacted (scrolling, text fields and the
// tab bar's gestures are dispatched by Android itself and went on working). A plain <View pointerEvents="none">
// around the layer is honoured: nothing inside it is ever a touch target. `collapsable={false}` keeps that view in
// the native tree — a view that only lays out its child may be flattened away, and the rule with it.
//
// The native views say the same themselves (modules/linea-snow, modules/linea-trail: `isEnabled() = false`); either
// of the two is enough. iPhone (the layer returns nil from hitTest) and the PC (a pointer-events:none canvas) do not
// need the wrapper and keep their tree as it was.
import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';

export function UntouchableLayer({ children }: { children: React.ReactNode }) {
  if (Platform.OS !== 'android') return <>{children}</>;
  return <View pointerEvents="none" collapsable={false} style={StyleSheet.absoluteFill}>{children}</View>;
}
