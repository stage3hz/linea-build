// Deferred on-screen preview of the expensive effects (object removal, background, document). Geometry and pen
// lines are drawn live on top; this hook only renders the effects, without crop or rotation, at screen size.
// Results are cached by effect options, so rotating or cropping after «Без фона» never re-runs the model, and
// undo/redo between cached states is instant. Out-of-date renders are dropped by revision.
import { useEffect, useRef, useState } from 'react';
import type { LocalFile } from '../../types';
import { effectKey, hasEffects, previewOptions, type EditState } from '../editorHistory.ts';
import { renderPreview, type PhotoPreview } from '../pipeline';

export const PREVIEW_DELAY_MS = 400;
const CACHE_SIZE = 4;

export type EffectPreview = { preview: PhotoPreview | null; busy: boolean; error: string };

export function useEffectPreview(file: LocalFile, state: EditState | null, maxPixels: number, enabled: boolean): EffectPreview {
  const cache = useRef(new Map<string, PhotoPreview>());
  const revision = useRef(0);
  const [result, setResult] = useState<EffectPreview>({ preview: null, busy: false, error: '' });

  useEffect(() => () => {
    revision.current += 1;
    for (const preview of cache.current.values()) void preview.dispose().catch(() => {});
    cache.current.clear();
  }, [file.uri]);

  const key = state && enabled && hasEffects(state) ? effectKey(state) : null;
  useEffect(() => {
    const current = ++revision.current;
    if (!key || !state) { setResult({ preview: null, busy: false, error: '' }); return; }
    const cached = cache.current.get(key);
    if (cached) {
      cache.current.delete(key); cache.current.set(key, cached); // most recently used
      setResult({ preview: cached, busy: false, error: '' });
      return;
    }
    setResult(previous => ({ ...previous, busy: true, error: '' }));
    const options = previewOptions(state, maxPixels);
    const timer = setTimeout(() => {
      renderPreview(file, options).then(preview => {
        if (current !== revision.current) { void preview.dispose().catch(() => {}); return; }
        cache.current.set(key, preview);
        while (cache.current.size > CACHE_SIZE) {
          const [oldest, value] = cache.current.entries().next().value as [string, PhotoPreview];
          cache.current.delete(oldest); void value.dispose().catch(() => {});
        }
        setResult({ preview, busy: false, error: '' });
      }, failure => {
        if (current !== revision.current) return;
        setResult(previous => ({ preview: previous.preview, busy: false, error: failure instanceof Error ? failure.message : 'Не удалось показать эффект.' }));
      });
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
    // state is read only through its effect key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, file.uri, maxPixels]);

  return result;
}
