// Message text with Telegram-style formatting: bold, italic, underline, strikethrough, monospace
// (inline and block), spoiler (hidden until tap), quote (accent bar) and links. Entities arrive
// decrypted with the text; a message without them renders exactly as before (one <Text>).
import React, { useMemo, useState } from 'react';
import { Alert, Linking, Platform, StyleSheet, View, type StyleProp, type TextStyle } from 'react-native';
import { MONO, Text } from '../typography';
import { useTheme } from '../theme';
import { tr } from '../i18n';
import { linkify } from '../linkify';
import { linkTextMatchesUrl, type Entity } from './entities';
import { toBlocks, type Block, type Span } from './render';

type Props = {
  text: string; entities?: readonly Entity[];
  color: string; linkColor: string; fontSize: number; lineHeight: number;
  selectable?: boolean; style?: StyleProp<TextStyle>;
  /** Appended to the last text line (the invisible spacer that reserves room for the time). */
  trailing?: React.ReactNode;
};

const safeUrl = (url: string) => /^https?:\/\//i.test(url) ? url : null;
/** A link whose text hides its address («подробнее» → https://…) is confirmed first, with the full URL shown (Telegram does the same). */
function openLink(url: string, shown: string) {
  const open = () => { void Linking.openURL(url).catch(() => {}); };
  if (linkTextMatchesUrl(shown, url)) return open();
  if (Platform.OS === 'web') { if (typeof window !== 'undefined' && window.confirm(`${tr('Открыть ссылку?')}\n\n${url}`)) open(); return; }
  Alert.alert(tr('Открыть ссылку?'), url, [{ text: tr('Отмена'), style: 'cancel' }, { text: tr('Открыть'), onPress: open }]);
}

function SpanText({ span, color, linkColor, hidden, onReveal, t }: { span: Span; color: string; linkColor: string; hidden: boolean; onReveal: () => void; t: ReturnType<typeof useTheme> }) {
  const style: TextStyle = {};
  if (span.bold) style.fontWeight = '700';
  if (span.italic) style.fontStyle = 'italic';
  if (span.underline && span.strike) style.textDecorationLine = 'underline line-through';
  else if (span.underline) style.textDecorationLine = 'underline';
  else if (span.strike) style.textDecorationLine = 'line-through';
  if (span.code) { style.fontFamily = MONO; style.backgroundColor = t.dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)'; }
  if (span.url) { style.color = linkColor; style.textDecorationLine = style.textDecorationLine ? 'underline line-through' : 'underline'; }
  if (span.spoiler && hidden) {
    // Telegram: a grainy block in place of the text; a tap shows every spoiler of the message.
    return <Text raw selectable={false} accessibilityRole="button" accessibilityLabel={tr('Спойлер, нажми, чтобы показать')} suppressHighlighting onPress={onReveal} style={[style, { color: 'transparent', backgroundColor: t.dark ? 'rgba(255,255,255,0.28)' : 'rgba(20,36,61,0.22)', borderRadius: 4 }]}>{span.text}</Text>;
  }
  if (span.spoiler) style.backgroundColor = t.dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.04)';
  const url = span.url ? safeUrl(span.url) : null;
  if (url) return <Text raw accessibilityRole="link" accessibilityHint={url} suppressHighlighting onPress={() => openLink(url, span.text)} style={style}>{span.text}</Text>;
  if (!Object.keys(style).length) return <>{linkify(span.text, linkColor)}</>;
  return <Text raw style={style}>{span.code ? span.text : linkify(span.text, linkColor)}</Text>;
}

/** Memoised per message: `revealed` flips when a spoiler is tapped. */
export function FormattedText({ text, entities, color, linkColor, fontSize, lineHeight, selectable = false, style, trailing }: Props) {
  const t = useTheme();
  const [revealed, setRevealed] = useState(false);
  const blocks = useMemo(() => toBlocks(text, entities), [text, entities]);
  const plain = blocks.length === 1 && blocks[0].kind === 'text' && blocks[0].spans.length === 1 && Object.keys(blocks[0].spans[0]).length === 1;
  const base: TextStyle = { color, fontSize, lineHeight };
  if (plain || !blocks.length) return <Text raw selectable={selectable} style={[base, style]}>{linkify(text, linkColor)}{trailing}</Text>;
  const reveal = () => setRevealed(true);
  // A caption under a photo is inset; the quote and code blocks follow the same inset.
  const flat = StyleSheet.flatten(style) as TextStyle | undefined; const inset = flat?.paddingHorizontal ?? 0; const rest = flat ? { ...flat, paddingHorizontal: undefined } : undefined;
  const spans = (block: Block, key: string) => block.spans.map((span, index) => <SpanText key={`${key}${index}`} span={span} color={color} linkColor={linkColor} hidden={!revealed} onReveal={reveal} t={t} />);
  return <View style={{ gap: 4, paddingHorizontal: inset }}>
    {blocks.map((block, index) => {
      const last = index === blocks.length - 1;
      if (block.kind === 'pre') {
        return <View key={index} style={{ borderRadius: 10, backgroundColor: t.dark ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.05)', paddingHorizontal: 10, paddingVertical: 7, marginVertical: 2 }}>
          {block.language ? <Text raw style={{ color: linkColor, fontSize: Math.max(10, fontSize - 5), fontWeight: '600', marginBottom: 2 }}>{block.language}</Text> : null}
          <Text raw selectable={selectable} accessibilityLabel={`${tr('Код')}: ${block.spans[0]?.text ?? ''}`} style={{ color, fontSize: fontSize - 1, lineHeight: lineHeight - 1, fontFamily: MONO }}>{block.spans[0]?.text}</Text>
        </View>;
      }
      if (block.kind === 'quote') {
        return <View key={index} style={{ flexDirection: 'row', gap: 8, borderRadius: 8, backgroundColor: t.accentSoft, paddingVertical: 5, paddingRight: 8, paddingLeft: 7, marginVertical: 2 }}>
          <View style={{ width: 3, borderRadius: 2, backgroundColor: linkColor }} />
          <Text raw selectable={selectable} accessibilityLabel={`${tr('Цитата')}: ${block.spans.map(span => span.text).join('')}`} style={[base, { flexShrink: 1, fontSize: fontSize - 1, lineHeight: lineHeight - 1 }]}>{spans(block, `q${index}`)}</Text>
        </View>;
      }
      return <Text key={index} raw selectable={selectable} style={[base, rest]}>{spans(block, `t${index}`)}{last ? trailing : null}</Text>;
    })}
  </View>;
}
