// Same rules as the server's names (server/src/security.js): hidden and direction-changing
// characters never reach the screen, and a forwarded-from label cannot pose as the service.
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-︎﻿ﾠ￰-￻]/g;
export const visibleText = (value: string) => value.replace(HIDDEN, '');
const FOLD: Record<string, string> = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у', i: 'и', n: 'н', v: 'в', z: 'з', '0': 'о', '3': 'з', '1': 'и', l: 'и', 'ё': 'е', 'й': 'и' };
const fold = (value: string) => value.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').replace(/./gu, char => FOLD[char] || char);
const RESERVED = ['инвиз', 'инвизент', 'поддержка', 'администрац', 'модератор', 'служба', 'support', 'admin', 'official', 'официальн', 'invizent', 'inviz', 'linea', 'линия'].map(fold);
export const posesAsService = (value: string) => { const folded = fold(value); return RESERVED.some(word => folded.includes(word)); };
/** Label after «Переслано от»: cleaned, and a name posing as the service is not shown. */
export const forwardLabel = (from: string) => { const name = visibleText(from).replace(/\s+/g, ' ').trim(); return !name || posesAsService(name) ? null : name; };
