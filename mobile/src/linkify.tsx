// Clickable links inside message text (Telegram-like): http(s) URLs and bare www. addresses
// become accent-coloured, tappable parts of the same <Text>. Only http/https is ever opened.
import React from 'react';
import { Linking } from 'react-native';
import { Text } from './typography';

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"'«»]+[^\s<>"'«».,:;!?)\]])/gi;

export function linkify(text: string, color: string): React.ReactNode {
  if (!text || !/https?:\/\/|www\./i.test(text)) return text;
  const out: React.ReactNode[] = []; let last = 0, m: RegExpExecArray | null; URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const raw = m[1], href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    out.push(<Text raw key={m.index} accessibilityRole="link" suppressHighlighting onPress={() => { void Linking.openURL(href).catch(() => {}); }} style={{ color, textDecorationLine: 'underline' }}>{raw}</Text>);
    last = m.index + raw.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
