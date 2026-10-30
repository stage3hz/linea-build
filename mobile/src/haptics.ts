import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

// Light vibration feedback like Telegram: never throws, silent on web.
const safe = (run: () => Promise<void>) => { if (Platform.OS !== 'web') run().catch(() => {}); };
export const tapFeedback = () => safe(() => Haptics.selectionAsync());
export const impactFeedback = () => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
export const lightFeedback = () => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
