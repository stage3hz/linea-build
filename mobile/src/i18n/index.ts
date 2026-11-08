import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import en from './en.json';

/**
 * Interface language (Telegram-like: Settings → Language). The app is written in Russian; other
 * languages are dictionaries keyed by the Russian text, applied where text is rendered (Text,
 * placeholders) and to server messages shown to the user. Text built from numbers or names
 * (plurals, «Рамка "X"») stays Russian until it gets its own entry.
 */
export type Language = 'ru' | 'en';
export const LANGUAGES: { id: Language; name: string; native: string }[] = [
  { id: 'ru', name: 'Russian', native: 'Русский' },
  { id: 'en', name: 'English', native: 'English' },
];
const DICTIONARIES: Record<Exclude<Language, 'ru'>, Record<string, string>> = { en: en as Record<string, string> };
const KEY = 'linea.language.v1';

let current: Language = 'ru'; let chosen = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

/** Reads the saved choice; without one the app stays Russian (English only when chosen in Settings). */
export async function loadLanguage(): Promise<void> {
  try {
    const saved = await AsyncStorage.getItem(KEY);
    const next: Language = saved === 'en' ? 'en' : 'ru';
    chosen = saved === 'ru' || saved === 'en';
    if (next !== current) { current = next; emit(); }
  } catch { /* keep Russian */ }
}
export function setLanguage(language: Language) {
  current = language; chosen = true; emit();
  void AsyncStorage.setItem(KEY, language).catch(() => {});
}
export const getLanguage = () => current;
export const languageChosen = () => chosen;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useLanguage = () => useSyncExternalStore(subscribe, getLanguage, getLanguage);

/** The text in the current language; unknown text is returned as is. Surrounding spaces are kept. */
export function tr(text: string, language: Language = current): string {
  if (language === 'ru' || !text) return text;
  const dictionary = DICTIONARIES[language];
  const direct = dictionary[text];
  if (direct !== undefined) return direct;
  const trimmed = text.trim();
  if (trimmed === text || !trimmed) return text;
  const found = dictionary[trimmed];
  return found === undefined ? text : text.replace(trimmed, found);
}

/** Translates string children of a Text (strings and arrays of strings; elements are left alone). */
export function trChildren(children: unknown, language: Language): unknown {
  if (language === 'ru') return children;
  if (typeof children === 'string') return tr(children, language);
  if (Array.isArray(children)) return children.map(child => typeof child === 'string' ? tr(child, language) : child);
  return children;
}

/** The spoken accessibility props in the current language (only the ones that are set, so spreading the
 * result never adds props). Like Text children, an exact interface string is replaced and anything else
 * (names, numbers, already translated text) is left as is. */
export function trA11y(props: { accessibilityLabel?: string; accessibilityHint?: string }, language: Language = current): { accessibilityLabel?: string; accessibilityHint?: string } {
  if (language === 'ru') return {};
  const out: { accessibilityLabel?: string; accessibilityHint?: string } = {};
  if (typeof props.accessibilityLabel === 'string') out.accessibilityLabel = tr(props.accessibilityLabel, language);
  if (typeof props.accessibilityHint === 'string') out.accessibilityHint = tr(props.accessibilityHint, language);
  return out;
}
