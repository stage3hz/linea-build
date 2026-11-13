// Clickable links inside message text (Telegram-like): http(s) URLs, bare www. addresses and @mentions
// become accent-coloured, tappable parts of the same <Text>. Only http/https is ever opened; a mention opens
// the chat with that person. The cutting itself is format/markdown.ts `linkTokens`.
import React from 'react';
import { Linking } from 'react-native';
import { Text } from './typography';
import { linkTokens } from './format/markdown';
import { navigate } from './navigation';

// (Kept identical to format/markdown.ts by a test; the cutting uses that copy.)
const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"'«»]+[^\s<>"'«».,:;!?)\]])/gi;

export function linkify(text: string, color: string): React.ReactNode {
  // Nothing to link in most messages: the text goes out as it is.
  if (!text || !(/https?:\/\/|www\./i.test(text) || text.includes('@'))) return text;
  const tokens = linkTokens(text);
  if (tokens.every(token => token.kind === 'text')) return text;
  let at = 0;
  return tokens.map(token => {
    const key = at; at += token.text.length;
    if (token.kind === 'url') { const href = token.href; return <Text raw key={key} accessibilityRole="link" suppressHighlighting onPress={() => { void Linking.openURL(href).catch(() => {}); }} style={{ color, textDecorationLine: 'underline' }}>{token.text}</Text>; }
    // Telegram: @name in a message is a link to that person; a tap opens the chat with them (App.tsx «mention»).
    if (token.kind === 'mention') { const username = token.username; return <Text raw key={key} accessibilityRole="link" accessibilityLabel={token.text} suppressHighlighting onPress={() => navigate({ to: 'mention', username })} style={{ color }}>{token.text}</Text>; }
    return token.text;
  });
}
