import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import type { PermissionResponse } from 'expo-media-library';
import { galleryPermission, getGalleryLibrary, readGalleryPage } from './gallery';
import { mergeGalleryPage, type GalleryItem } from './selection';

const failureText = (error: unknown) => error instanceof Error ? error.message : 'Не удалось открыть галерею.';

export function useGallery(active: boolean) {
  const [items, setItems] = useState<GalleryItem[]>([]), [permission, setPermission] = useState<PermissionResponse | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [hasMore, setHasMore] = useState(false);
  const generation = useRef(0), loadingRef = useRef(false), offset = useRef<number | null>(null), activeRef = useRef(active);
  activeRef.current = active;

  const refresh = useCallback(async (mode: 'auto' | 'request' | 'check' = 'check') => {
    if (!activeRef.current || Platform.OS === 'web') return;
    const ticket = ++generation.current;
    const current = () => activeRef.current && ticket === generation.current;
    loadingRef.current = true;
    setLoading(true); setError('');
    try {
      let allowed = await galleryPermission(mode === 'request');
      if (mode === 'auto' && allowed.status === 'undetermined') allowed = await galleryPermission(true);
      if (!current()) return;
      setPermission(allowed);
      if (!allowed.granted && allowed.accessPrivileges !== 'limited') {
        setItems([]); offset.current = null; setHasMore(false); return;
      }
      const page = await readGalleryPage(0);
      if (!current()) return;
      setItems(page.items); offset.current = page.nextOffset; setHasMore(page.nextOffset !== null);
    } catch (failure) { if (current()) setError(failureText(failure)); }
    finally { if (current()) { loadingRef.current = false; setLoading(false); } }
  }, []);

  const more = useCallback(async () => {
    if (!activeRef.current || loadingRef.current || offset.current === null) return;
    const ticket = generation.current, nextOffset = offset.current;
    const current = () => activeRef.current && ticket === generation.current;
    loadingRef.current = true; setLoading(true);
    try {
      const page = await readGalleryPage(nextOffset);
      if (!current()) return;
      setItems(previous => mergeGalleryPage(previous, page.items));
      offset.current = page.nextOffset; setHasMore(page.nextOffset !== null); setError('');
    } catch (failure) { if (current()) setError(failureText(failure)); }
    finally { if (current()) { loadingRef.current = false; setLoading(false); } }
  }, []);

  const addAccess = useCallback(async () => {
    try { const api = await getGalleryLibrary(); await api.presentPermissionsPicker(['photo', 'video']); await refresh(); }
    catch (failure) { if (activeRef.current) setError(failureText(failure)); }
  }, [refresh]);

  useEffect(() => {
    if (!active || Platform.OS === 'web') return;
    let disposed = false, librarySubscription: { remove: () => void } | undefined;
    setItems([]); setPermission(null);
    void refresh('auto');
    void getGalleryLibrary().then(api => {
      if (!disposed) librarySubscription = api.addListener(() => { void refresh(); });
    }).catch(() => {});
    let lastState = AppState.currentState;
    const appSubscription = AppState.addEventListener('change', state => {
      const wasBackground = lastState === 'background';
      lastState = state;
      if (state === 'active' && wasBackground) void refresh();
    });
    return () => { disposed = true; generation.current += 1; loadingRef.current = false; librarySubscription?.remove(); appSubscription.remove(); };
  }, [active, refresh]);

  return { items, permission, loading, error, hasMore, refresh, more, addAccess };
}
