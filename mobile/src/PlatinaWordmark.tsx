import React from 'react';
import { Image } from 'expo-image';
import { useTheme } from './theme';

// Keep the asset's proportions while the profile row gives space to its status.
// SVG gradients are part of the artwork; do not apply a theme tint.
export function PlatinaWordmark() {
  const t = useTheme();
  return <Image
    source={t.dark
      ? require('../assets/branding/platina-chrome.svg')
      : require('../assets/branding/platina-chrome-light.svg')}
    accessible
    accessibilityLabel="Platina"
    accessibilityRole="image"
    contentFit="contain"
    contentPosition="left center"
    transition={0}
    style={{ width: '100%', maxWidth: 220, minWidth: 0, aspectRatio: 1600 / 520, alignSelf: 'flex-start' }}
  />;
}
