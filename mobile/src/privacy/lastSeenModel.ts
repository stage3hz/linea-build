// «Время захода» (Telegram's «Последняя активность»): modes, which exception list applies, the row value.
import type { LastSeenMode } from '../api';

export const LAST_SEEN_MODES: readonly { value: LastSeenMode; label: string }[] = [
  { value: 'everyone', label: 'Все' },
  // Telegram's «Мои контакты»: here contacts are friends.
  { value: 'contacts', label: 'Мои друзья' },
  { value: 'nobody', label: 'Никто' },
];

/** Which exception lists apply to a mode, as in Telegram: «Все» → only «Никогда», «Никто» → only «Всегда». */
export const listsFor = (mode: LastSeenMode) => ({ allow: mode !== 'everyone', deny: mode !== 'nobody' });

/** Telegram's row value: «Все», «Мои друзья (−1, +2)», «Никто (+3)». `translate` localizes the mode name. */
export function lastSeenSummary(mode: LastSeenMode, rules: { allow: unknown[]; deny: unknown[] } | null, translate: (text: string) => string = text => text): string {
  const label = translate(LAST_SEEN_MODES.find(item => item.value === mode)?.label || 'Все');
  const lists = listsFor(mode), parts: string[] = [];
  if (rules && lists.deny && rules.deny.length) parts.push(`−${rules.deny.length}`);
  if (rules && lists.allow && rules.allow.length) parts.push(`+${rules.allow.length}`);
  return parts.length ? `${label} (${parts.join(', ')})` : label;
}
