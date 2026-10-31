import React, { useEffect, useRef, useState } from 'react';
import { type TextInputProps } from 'react-native';
import { TextInput } from './typography';

/**
 * Multiline composer that grows with the text and shrinks back after sending.
 *
 * The input sizes itself (no explicit height): growing from `onContentSizeChange` was unreliable
 * on iPhone, so the field stayed one line tall and the rest of the text scrolled out of sight
 * under the keyboard. Past `maxHeight` it scrolls. A controlled multiline input on iOS keeps
 * its grown height when the value is cleared, so the field is remounted once the text empties.
 */
export function ComposerInput({ minHeight = 44, maxHeight = 136, style, value, ...props }: TextInputProps & { minHeight?: number; maxHeight?: number }) {
  const [generation, setGeneration] = useState(0);
  const had = useRef(!!value), focused = useRef(false);
  useEffect(() => {
    if (had.current && !value) setGeneration(n => n + 1);
    had.current = !!value;
  }, [value]);
  // A remount after sending keeps the keyboard up: the new field takes focus again.
  return <TextInput key={generation} {...props} value={value} multiline scrollEnabled autoFocus={generation > 0 && focused.current}
    onFocus={event => { focused.current = true; props.onFocus?.(event); }} onBlur={event => { focused.current = false; props.onBlur?.(event); }}
    style={[style, { minHeight, maxHeight }]} />;
}
