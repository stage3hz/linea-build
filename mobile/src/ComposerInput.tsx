import React, { useEffect, useRef, useState } from 'react';
import { Platform, type TextInput as RNTextInput, type TextInputProps } from 'react-native';
// Web/PC: a browser <textarea> is two rows tall by default; numberOfLines → rows=1 keeps the empty field one line.
import { TextInput } from './typography';

/**
 * Multiline composer that grows with the text and shrinks back after sending.
 *
 * The input sizes itself (no explicit height): growing from `onContentSizeChange` was unreliable
 * on iPhone, so the field stayed one line tall and the rest of the text scrolled out of sight
 * under the keyboard. Past `maxHeight` it scrolls. A controlled multiline input on iOS keeps
 * its grown height when the value is cleared, so the field is shrunk once the text empties (below).
 */
export function ComposerInput({ minHeight = 44, maxHeight = 136, style, value, focusKey, ...props }: TextInputProps & { minHeight?: number; maxHeight?: number; focusKey?: string | null }) {
  const [generation, setGeneration] = useState(0);
  const input = useRef<RNTextInput>(null);
  // «Ответить» / «Изменить»: the cursor goes straight into the field, so typing just works.
  useEffect(() => { if (focusKey) { const id = setTimeout(() => input.current?.focus(), 60); return () => clearTimeout(id); } }, [focusKey]);
  const had = useRef(!!value), focused = useRef(false), grown = useRef(false);
  // When the text empties, a grown field has to shrink. Remounting it used to blur the field: the
  // keyboard dropped and came back (the composer "closed and reopened by itself") on every
  // emptying, even by backspace. Now: a one-line field is left alone; a grown field that has focus
  // is shrunk by pinning its height for one frame; only an unfocused grown field is remounted.
  const [pin, setPin] = useState(false);
  useEffect(() => {
    if (had.current && !value && grown.current) {
      grown.current = false;
      if (focused.current) { setPin(true); had.current = false; return; }
      setGeneration(n => n + 1);
    }
    had.current = !!value;
  }, [value]);
  useEffect(() => { if (!pin) return; const id = requestAnimationFrame(() => setPin(false)); return () => cancelAnimationFrame(id); }, [pin]);
  // A remount after sending keeps the keyboard up: the new field takes focus again.
  return <TextInput ref={input} key={generation} {...props} value={value} multiline scrollEnabled numberOfLines={Platform.OS === 'web' ? 1 : undefined} autoFocus={generation > 0 && focused.current}
    onFocus={event => { focused.current = true; props.onFocus?.(event); }}
    onContentSizeChange={event => { if (event.nativeEvent.contentSize.height > minHeight + 4) grown.current = true; props.onContentSizeChange?.(event); }} onBlur={event => { focused.current = false; props.onBlur?.(event); }}
    style={[style, { minHeight, maxHeight }, pin ? { height: minHeight } : null]} />;
}
