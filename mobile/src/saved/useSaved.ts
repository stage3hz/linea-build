import { useCallback, useEffect, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import type { CryptoRuntime } from '../e2ee/runtime';
import type { Attachment } from '../types';
import { signalAvailable } from '../e2ee/signal';
import { addSaved, editSaved, parseSaved, removeSaved, type SavedItem, type SavedOrigin } from './saved.ts';

/** The vault is encrypted with device keys, which a browser does not have: the message Saved shows there instead of the generic E2EE one. */
export const SAVED_UNAVAILABLE = 'Заметки в Избранном шифруются на устройстве и сохраняются в приложении для iPhone, Android или ПК.';

/** Saved messages for the signed-in account; every change is committed to the encrypted vault in order. */
export function useSaved(runtime: CryptoRuntime) {
  const [items, setItems] = useState<SavedItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const current = useRef<SavedItem[]>([]);
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    // Web: say right away why the list is empty, without touching the crypto runtime (its error talks about sending messages).
    if (!signalAvailable) { setError(SAVED_UNAVAILABLE); setLoaded(true); return; }
    let live = true;
    runtime.get().then(service => service.loadSaved()).then(raw => {
      if (!live) return;
      current.current = parseSaved(raw); setItems(current.current); setLoaded(true);
    }).catch(e => { if (live) { setError(e instanceof Error ? e.message : 'Не удалось открыть Избранное.'); setLoaded(true); } });
    return () => { live = false; };
  }, [runtime]);

  const commit = useCallback((change: (list: SavedItem[]) => SavedItem[]) => {
    const next = change(current.current);
    const previous = current.current;
    current.current = next; setItems(next); setError('');
    const write = queue.current.then(async () => { await (await runtime.get()).storeSaved(JSON.stringify(next)); });
    queue.current = write.catch(() => {});
    return write.catch(e => {
      if (current.current === next) { current.current = previous; setItems(previous); }
      const message = e instanceof Error ? e.message : 'Не удалось сохранить Избранное.';
      setError(message); throw new Error(message);
    });
  }, [runtime]);

  const save = useCallback(async (text: string, attachment: Attachment | null, origin?: SavedOrigin): Promise<boolean> => {
    if (!signalAvailable) throw new Error(SAVED_UNAVAILABLE);
    if (!loaded) throw new Error('Избранное ещё загружается. Попробуй через секунду.');
    const item: SavedItem = { id: Crypto.randomUUID(), savedAt: new Date().toISOString(), text: text.trim().slice(0, 8000), attachment, ...(origin ? { origin } : {}) };
    let added = false;
    await commit(list => { const result = addSaved(list, item); added = result.added; return result.list; });
    return added;
  }, [commit, loaded]);
  const remove = useCallback((id: string) => commit(list => removeSaved(list, id)), [commit]);
  const edit = useCallback((id: string, text: string) => commit(list => editSaved(list, id, text, new Date().toISOString())), [commit]);

  return { items, loaded, error, save, remove, edit };
}
export type SavedStore = ReturnType<typeof useSaved>;
