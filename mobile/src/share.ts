import { Platform, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
/**
 * System share sheet on phones; on PC (Electron has no navigator.share) the text is copied instead.
 * Returns 'copied' when it fell back to the clipboard, so the caller can say so.
 */
export async function shareText(message: string): Promise<'shared' | 'copied'> {
  const nav = (globalThis as { navigator?: { share?: unknown } }).navigator;
  if (Platform.OS === 'web' && typeof nav?.share !== 'function') { await Clipboard.setStringAsync(message); return 'copied'; }
  try { await Share.share({ message }); return 'shared'; }
  catch { await Clipboard.setStringAsync(message); return 'copied'; }
}
