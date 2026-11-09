import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, type TextInput as RNTextInput, type TextInputProps } from 'react-native';
// Web/PC: a browser <textarea> is two rows tall by default; numberOfLines → rows=1 keeps the empty field one line.
import { TextInput } from './typography';
import { retryFocus, type FocusRetry } from './focusRetry';

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
  // On iPhone the message menu is a Modal still closing when «Изменить» is tapped: focus is asked again
  // until the field has it, and never again after that or once the keyboard was put away (focusRetry.ts).
  const retry = useRef<FocusRetry | null>(null);
  useEffect(() => {
    if (!focusKey) return;
    const current = retryFocus({ isFocused: () => !!input.current?.isFocused?.(), focus: () => input.current?.focus() });
    retry.current = current;
    const hide = Platform.OS === 'web' ? null : Keyboard.addListener('keyboardDidHide', current.keyboardHidden);
    return () => { current.stop(); hide?.remove(); if (retry.current === current) retry.current = null; };
  }, [focusKey]);
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
  // Leaving the chat with the field focused: let go of the keyboard. A focused field that is simply
  // unmounted can keep the keyboard up on iOS over the chat list (the stack also dismisses it on back).
  useEffect(() => () => { if (focused.current && Platform.OS !== 'web') Keyboard.dismiss(); }, []);
  // A remount after sending keeps the keyboard up: the new field takes focus again.
  return <TextInput ref={input} key={generation} {...props} value={value} multiline scrollEnabled numberOfLines={Platform.OS === 'web' ? 1 : undefined} autoFocus={generation > 0 && focused.current}
    onFocus={event => { focused.current = true; retry.current?.focused(); props.onFocus?.(event); }}
    onContentSizeChange={event => { if (event.nativeEvent.contentSize.height > minHeight + 4) grown.current = true; props.onContentSizeChange?.(event); }} onBlur={event => { focused.current = false; props.onBlur?.(event); }}
    style={[style, { minHeight, maxHeight }, pin ? { height: minHeight } : null]} />;
}
