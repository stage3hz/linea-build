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

function systemLanguage(): Language {
  try { const locale = Intl.DateTimeFormat().resolvedOptions().locale || ''; return /^ru|^uk|^be|^kk/i.test(locale) || !locale ? 'ru' : 'en'; } catch { return 'ru'; }
}

let current: Language = 'ru'; let chosen = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

/** Reads the saved choice; without one the device language decides (Russian-speaking → Russian, else English). */
export async function loadLanguage(): Promise<void> {
  try {
    const saved = await AsyncStorage.getItem(KEY);
    const next = saved === 'ru' || saved === 'en' ? saved : systemLanguage();
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
