import React, { useEffect, useState } from 'react';
import { type TextInputProps } from 'react-native';
import { TextInput } from './typography';

/**
 * Multiline composer that shrinks back after sending. A controlled multiline
 * TextInput on iOS keeps its grown height when the value is cleared, which left
 * a tall empty box after sending; here the height follows the content and
 * resets as soon as the text is empty.
 */
export function ComposerInput({ minHeight = 44, maxHeight = 136, style, value, onContentSizeChange, ...props }: TextInputProps & { minHeight?: number; maxHeight?: number }) {
  const [content, setContent] = useState(0);
  useEffect(() => { if (!value) setContent(0); }, [value]);
  // contentSize already includes the vertical padding on iOS and Android.
  const height = Math.min(maxHeight, Math.max(minHeight, content ? Math.ceil(content) : minHeight));
  return <TextInput {...props} value={value} multiline scrollEnabled={height >= maxHeight}
    onContentSizeChange={event => { setContent(value ? event.nativeEvent.contentSize.height : 0); onContentSizeChange?.(event); }}
    style={[style, { height, maxHeight }]} />;
}
