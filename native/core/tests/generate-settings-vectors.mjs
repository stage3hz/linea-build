// Produces tests/vectors/settings.json: the rules behind the settings pages as the reference itself answers them
// (mobile/src/theme.tsx, themes/palettes.ts, themes/custom.ts, themePreference.ts, chatPreferences.ts,
// notifications/model.ts and the size labels of SettingsScreen.tsx).
// Run from the repository root:  node native/core/tests/generate-settings-vectors.mjs
//
// One case per line (JSON.stringify's own text): {"name", "args", "want"} — `name` and `args` are what the apps
// hand to the core (`settings::view`), `want` is the reference's answer put together the way the core's doc says.
// The Rust test (tests/settings_vectors.rs) reads and writes every line back to the same text and compares the
// answers as JSON text.
//
// The reference is imported as it is (Node strips the types). A resolve hook adds the `.ts` its extensionless
// imports lack and replaces three things that only exist on a phone and are not part of any rule here: the
// phone's key-value storage, React, and the choice of the interface language (Russian here). `theme.tsx` holds no
// JSX; a load hook hands it to Node as TypeScript.
process.env.TZ = 'UTC';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { registerHooks } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const file = name => join(root, 'mobile/src', name);
const stub = source => ({ url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true });

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@react-native-async-storage/async-storage') return stub('export default { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };');
    if (specifier === 'react') return stub('export const useSyncExternalStore = () => { throw new Error("not on a phone"); }; export const createContext = value => ({ value }); export const useContext = context => context.value; export default {};');
    if (specifier === './i18n' && context.parentURL?.endsWith('/mobile/src/theme.tsx')) return stub('export const getLanguage = () => "ru";');
    if (specifier.startsWith('.') && context.parentURL?.includes('/mobile/src/') && !/\.[a-z]+$/.test(specifier)) {
      for (const ending of ['.ts', '.tsx']) {
        const url = new URL(specifier + ending, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('/mobile/src/theme.tsx')) return { format: 'module-typescript', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true };
    return next(url, context);
  },
});

const themeFile = await import(pathToFileURL(file('theme.tsx')).href);
const palettes = await import(pathToFileURL(file('themes/palettes.ts')).href);
const custom = await import(pathToFileURL(file('themes/custom.ts')).href);
const preference = await import(pathToFileURL(file('themePreference.ts')).href);
const chat = await import(pathToFileURL(file('chatPreferences.ts')).href);
const notify = await import(pathToFileURL(file('notifications/model.ts')).href);

// Words that live in files with JSX (not importable): written here, and the run stops if the reference changed them.
const pinned = (name, text) => { if (!readFileSync(file(name), 'utf8').includes(text)) throw new Error(`${name} changed: ${text}`); };
pinned('ThemeSettings.tsx', "{ system: 'Как в системе', light: 'Светлая', dark: 'Тёмная', black: 'Чёрная', graphite: 'Графит', ...Object.fromEntries(PALETTES.map(p => [p.id, p.name])) }");
const THEME_NAMES = { system: 'Как в системе', light: 'Светлая', dark: 'Тёмная', black: 'Чёрная', graphite: 'Графит', ...Object.fromEntries(palettes.PALETTES.map(p => [p.id, p.name])) };
pinned('SettingsScreen.tsx', "const storageLabel = (bytes: number) => bytes >= GB ? `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1).replace('.0', '')} ${getLanguage() === 'en' ? 'GB' : 'ГБ'}` : formatSize(bytes);");
const GB = 1024 ** 3;
const storageLabel = bytes => bytes >= GB ? `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1).replace('.0', '')} ГБ` : themeFile.formatSize(bytes);
pinned('SettingsScreen.tsx', "const NIGHT_LABELS: Record<NightMode, string> = { system: 'Системная', off: 'Выключена', schedule: 'По расписанию', auto: 'Автоматически' };");
pinned('SettingsScreen.tsx', "const NIGHT_THEMES: DarkTheme[] = ['dark', 'black', 'graphite'];");
pinned('ThemeSettings.tsx', "{ value: 'light', label: 'Светлая', color: '#EDF3FB', line: '#CEDAF0' },\n  { value: 'dark', label: 'Тёмная', color: '#080F1E', line: '#31415B' },\n  { value: 'black', label: 'Чёрная', color: '#08090A', line: '#23252A' },\n  { value: 'graphite', label: 'Графит', color: '#1C1C1E', line: '#3A3A3C' },");

// ---- a deterministic generator ----
let seed = 0x5e771965;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = n => Math.floor(rnd() * n);
const chance = p => rnd() < p;
const pick = list => list[int(list.length)];
const hexColor = () => '#' + Array.from({ length: 6 }, () => '0123456789ABCDEF'[int(16)]).join('');

const lines = [];
const count = {};
const write = (name, args, want) => {
  const line = JSON.stringify({ name, args, want: want === undefined ? null : want });
  if (JSON.stringify(JSON.parse(line)) !== line) throw new Error(`not stable JSON: ${name}`);
  lines.push(line); count[name] = (count[name] ?? 0) + 1;
};

// ---- the constants ----
write('settingsRules', [], {
  themeNames: THEME_NAMES,
  appearances: [
    { value: 'light', label: 'Светлая', color: '#EDF3FB', line: '#CEDAF0' }, { value: 'dark', label: 'Тёмная', color: '#080F1E', line: '#31415B' },
    { value: 'black', label: 'Чёрная', color: '#08090A', line: '#23252A' }, { value: 'graphite', label: 'Графит', color: '#1C1C1E', line: '#3A3A3C' },
  ],
  palettes: palettes.PALETTES.map(p => ({ id: p.id, name: p.name })),
  nightModes: preference.nightModesFor('ios'),
  nightLabels: { system: 'Системная', off: 'Выключена', schedule: 'По расписанию', auto: 'Автоматически' },
  nightThemes: ['dark', 'black', 'graphite'],
  textSizes: chat.TEXT_SIZES,
  wallpapers: chat.WALLPAPERS,
  accentChoices: custom.ACCENT_CHOICES,
  bubbleChoices: custom.BUBBLE_CHOICES,
  ringtones: notify.RINGTONES,
  muteChoices: notify.MUTE_CHOICES,
  maxCustomDays: notify.MAX_CUSTOM_DAYS,
});

// ---- themes: the built-in ones, the palettes, and the person's own colours over them ----
const THEME_IDS = Object.keys(themeFile.palette);
const themeWant = (id, accent, bubble) => {
  const base = themeFile.palette[id];
  if (!base) return null;
  const theme = custom.customTheme(base, accent, bubble);
  return { ...theme, ink: custom.ownBubbleInk(theme) };
};
const colorArg = () => {
  const r = rnd();
  if (r < 0.06) return null;
  if (r < 0.10) return pick(['', '#12345', '#GGGGGG', 'red', '123456', '#1234567', 7, true, '# 12345']);
  if (r < 0.16) return pick([' #3568e7 ', '#ff9500', '\t#Af52dE\n', '#ffffff', '#000000']);
  if (r < 0.40) return pick([...custom.ACCENT_CHOICES, ...custom.BUBBLE_CHOICES]);
  if (r < 0.50) { const v = int(256).toString(16).padStart(2, '0').toUpperCase(); return `#${v}${v}${v}`; }
  return hexColor();
};
for (const id of THEME_IDS) {
  write('settingsTheme', [id, null, null], themeWant(id, null, null));
  for (const color of [...custom.ACCENT_CHOICES, '#FFFFFF', '#000000', '#808080']) write('settingsTheme', [id, color, null], themeWant(id, color, null));
  for (const color of [...custom.BUBBLE_CHOICES, '#FFFFFF', '#000000', '#808080']) write('settingsTheme', [id, null, color], themeWant(id, null, color));
  for (let i = 0; i < 260; i++) { const accent = colorArg(), bubble = colorArg(); write('settingsTheme', [id, accent, bubble], themeWant(id, accent, bubble)); }
}
for (const id of ['system', '', 'Black', 'rose']) write('settingsTheme', [id, null, null], null);

// ---- «Свой цвет»: the three sliders ----
for (let i = 0; i < 700; i++) {
  const h = chance(0.15) ? pick([0, 60, 120, 180, 240, 300, 359.9, 360, 420, -30]) : chance(0.5) ? int(360) : rnd() * 360;
  const s = chance(0.15) ? pick([0, 1, 0.5]) : rnd(), v = chance(0.15) ? pick([0, 1, 0.12, 0.5]) : rnd();
  write('settingsHsvColor', [h, s, v], custom.hsvColor(h, s, v));
}
for (let i = 0; i < 700; i++) {
  const color = i < 24 ? [...custom.ACCENT_CHOICES, ...custom.BUBBLE_CHOICES][i] : chance(0.12) ? pick(['#000000', '#FFFFFF', '#808080', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF']) : hexColor();
  write('settingsColorHsv', [color], custom.colorHsv(color));
}
for (const bad of ['', '#12345', 'red', '#ff0000', '#GGGGGG']) write('settingsColorHsv', [bad], null);

// ---- what is kept on the device ----
for (const [mode, dark] of [[null, null], ['light', 'dark'], ['dark', 'black'], ['black', 'graphite'], ['graphite', 'light'], ['system', 'system'], ['neon', 'amethyst'], ['amethyst', 'neon'], ['', ''], ['Black', 'DARK'], [5, true], ['coffee', 'olive'], ['dusk', 'lagoon'], ['indigo', 'indigo']])
  write('settingsStoredTheme', [mode, dark], { mode: preference.storedThemeMode(mode), darkTheme: preference.storedDarkTheme(dark) });
for (const value of ['light', 'dark', 'black', 'graphite', 'system', ...palettes.PALETTE_IDS]) for (const platina of [false, true])
  write('settingsWithPlatina', [value, platina], preference.withPlatina(value, platina));

const shownPreferences = raw => { const { nativeList, nativeChat, ...rest } = chat.parsePreferences(raw); return rest; };
const oddValue = () => pick([null, 0, 1, -1, 0.5, 'x', '', true, false, [], {}, 8, 14, 20, 0.25, 0.999, 1.5, '22:00', '24:00', '7:00', '07:60', '23:59', '00:00', 'small', 'xlarge', 'aurora', 'violet', 'on', 'off', 'auto', 'system', 'schedule', '#ff9500', ' #FF9500 ', '#FF950', 0.126, 0.004, 0.995]);
const goodPreferences = () => ({
  textSize: pick(chat.TEXT_SIZES).id, sendTyping: chance(0.5), animations: pick(['auto', 'on', 'off']), lowBattery: pick([0, 0.05, 0.25, 0.333, 0.5, 0.95, 1, 0.126]), bubbleRadius: pick([8, 14, 20]),
  wallpaper: pick(chat.WALLPAPERS).id, nightMode: pick([null, 'system', 'off', 'schedule', 'auto']), nightFrom: pick(['22:00', '00:00', '23:59', '19:30']), nightTo: pick(['07:00', '06:15', '12:00']),
  nightBrightness: pick([0.1, 0.25, 0.4, 0.6]), nightForced: pick([null, true, false]), nightForcedAt: pick([null, true, false]), autoplayVideo: chance(0.5), autoplayGif: chance(0.5),
  animatedStickers: chance(0.5), animatedEmoji: chance(0.5), pixelTrail: chance(0.5), snow: chance(0.5), ice: chance(0.5), nativeList: chance(0.5), nativeChat: chance(0.5),
  accentColor: pick([null, '#3568E7', '#ff9500', 'red']), bubbleColor: pick([null, '#2B5BD7', ' #8640b8 ', 5]),
});
for (const raw of [null, '', 'null', '5', '"x"', '[]', '{}', '{', 'не JSON', '{"textSize":"large"}', '[1,2,3]', 'true']) write('settingsPreferences', [raw], shownPreferences(raw));
for (let i = 0; i < 900; i++) {
  const value = goodPreferences();
  for (const key of Object.keys(value)) { if (chance(0.12)) value[key] = oddValue(); else if (chance(0.05)) delete value[key]; }
  if (chance(0.1)) value.extra = oddValue();
  const raw = JSON.stringify(value);
  write('settingsPreferences', [raw], shownPreferences(raw));
}

const notificationWant = raw => { const prefs = notify.parseNotificationPrefs(raw); return { ...prefs, changed: notify.notificationPrefsChanged(prefs) }; };
for (const raw of [null, '', 'null', '5', '"x"', '[]', '{}', '{', 'не JSON', JSON.stringify(notify.DEFAULT_NOTIFICATION_PREFS), '{"chats":5,"calls":"x","badge":[],"communities":null}', '{"chats":{"show":false}}', '{"calls":{"ringtone":"pulse"}}'])
  write('settingsNotificationPrefs', [raw], notificationWant(raw));
for (let i = 0; i < 700; i++) {
  const flag = () => chance(0.12) ? oddValue() : chance(0.6);
  const value = { chats: { show: flag(), sound: flag(), vibration: flag(), preview: flag() }, communities: { show: flag(), sound: flag(), vibration: flag() },
    calls: { ringtone: chance(0.15) ? oddValue() : pick(notify.RINGTONES).id, vibration: flag() }, badge: { enabled: flag(), countMuted: flag() } };
  for (const key of Object.keys(value)) { if (chance(0.06)) value[key] = oddValue(); else if (chance(0.05)) delete value[key]; else for (const inner of Object.keys(value[key])) if (chance(0.05)) delete value[key][inner]; }
  const raw = JSON.stringify(value);
  write('settingsNotificationPrefs', [raw], notificationWant(raw));
}

// ---- the night theme ----
const MODES = ['system', 'light', 'dark', 'black', 'graphite', 'amethyst', 'neon'];
const DARKS = ['dark', 'black', 'graphite', 'coffee', 'neon'];
const clock = () => chance(0.3) ? pick(['22:00', '07:00', '00:00', '23:59', '12:00']) : `${String(int(24)).padStart(2, '0')}:${String(int(60)).padStart(2, '0')}`;
const nightWant = (settings, mode, darkTheme, system, minute, brightness) => {
  const rule = { mode: settings.mode, from: settings.from, to: settings.to, brightness: settings.brightness };
  const now = new Date(2026, 5, 15, Math.floor(minute / 60), minute % 60, 30);
  const kind = preference.effectiveNightMode(rule, mode, 'ios');
  const auto = preference.autoNight(rule, mode, system, now, brightness, 'ios');
  const known = kind !== 'auto' || brightness !== null;
  const expired = preference.manualNightExpired(settings.forced, settings.forcedAt, known ? auto : null);
  // The reference clears an expired manual switch in an effect and then shows the rule's own answer.
  const night = expired ? auto : settings.forced ?? auto;
  return { kind, auto, known, expired, night, shown: preference.themeFor(mode, darkTheme, night), day: preference.themeFor(mode, darkTheme, false) };
};
for (let i = 0; i < 6000; i++) {
  const from = clock(), to = chance(0.08) ? from : clock();
  const settings = { mode: pick([null, null, 'system', 'off', 'schedule', 'schedule', 'auto', 'auto']), from, to, brightness: pick([0.1, 0.25, 0.4, 0.6]), forced: pick([null, null, true, false]), forcedAt: pick([null, true, false]) };
  const mode = pick(MODES), darkTheme = pick(DARKS), system = pick(['light', 'dark', 'unspecified', null]);
  const edge = chance(0.4) ? pick([from, to]).split(':').map(Number).reduce((h, m) => h * 60 + m) + pick([-1, 0, 1]) : int(1440);
  const minute = ((edge % 1440) + 1440) % 1440;
  const brightness = chance(0.2) ? null : chance(0.4) ? pick([0, 0.1, 0.25, 0.4, 0.6, 1, 0.2500001, 0.2499999]) : rnd();
  write('settingsNight', [settings, mode, darkTheme, system, minute, brightness], nightWant(settings, mode, darkTheme, system, minute, brightness));
}
for (const value of [...MODES, ...palettes.PALETTE_IDS]) for (const night of [false, true]) write('settingsThemeTap', [value, night], preference.themeTapPlan(value, night));

// ---- the sound of a chat ----
const NOW = Date.UTC(2026, 10, 21, 7, 0, 0);
const moment = () => NOW + pick([0, 1, -1, 59_999, 86_399_000, -86_400_000 * 300, 86_400_000 * 40, 86_400_000 * 364]) + int(86_400_000) + int(1000);
for (const choice of notify.MUTE_CHOICES.map(item => item.id)) for (let i = 0; i < 40; i++) { const now = moment(); write('settingsMuteUntil', [choice, now], notify.muteUntil(choice, now)); }
for (const choice of ['', '3h', 'Forever']) write('settingsMuteUntil', [choice, NOW], notify.muteUntil(choice, NOW));
for (let i = 0; i < 900; i++) {
  const part = list => chance(0.08) ? pick([-1, 0.4, 0.5, 1.5, 2.5, -0.5, 400, 366, 365, 11, 12, 21, 111]) : pick(list);
  const duration = { days: part([0, 1, 2, 3, 5, 7, 14, 30, 364, 365]), hours: part([0, 1, 2, 3, 4, 6, 8, 12, 18, 21, 22, 25]), minutes: part([0, 15, 30, 45, 1, 2, 5, 11, 21, 59]) };
  const now = moment();
  write('settingsCustomMute', [duration, now], { until: notify.customMuteUntil(duration, now), label: notify.durationLabel(duration) });
}
// The labels read the local clock: the offsets of the two moments from UTC (minutes) are handed over, and the
// reference, run in UTC, is given both moments moved by them — the same wall clock it would read on the phone.
const muteWant = (settings, now, offsetNow, offsetEnd) => {
  const muted = notify.isMuted(settings, now);
  const until = settings?.mutedUntil || null;
  const at = until ? Date.parse(until) : NaN;
  const moved = Number.isFinite(at) ? new Date(at + offsetEnd * 60_000).toISOString() : until;
  const movedNow = now + offsetNow * 60_000;
  const end = moved ? notify.muteEndLabel(moved, movedNow) : '';
  const want = { muted, end, until: notify.muteUntilLabel(moved, movedNow), status: !muted ? '' : until ? `Звук выключен ${notify.muteUntilLabel(moved, movedNow)}` : 'Звук выключен' };
  if (offsetNow === 0 && offsetEnd === 0 && want.status !== notify.mutedStatusText(settings, now)) throw new Error('the status line is not the reference\'s');
  return want;
};
for (let i = 0; i < 4000; i++) {
  const now = moment();
  const span = pick([0, 1, -1, 60_000, 3600_000, 8 * 3600_000, 86_400_000, 2 * 86_400_000, 30 * 86_400_000, 200 * 86_400_000, 365 * 86_400_000, -3600_000, -86_400_000]) + (chance(0.5) ? int(86_400_000) : 0);
  const iso = new Date(now + span).toISOString();
  const until = chance(0.12) ? pick([null, '', 'не дата', 'abc', undefined]) : chance(0.1) ? iso.replace('Z', '+03:00') : chance(0.1) ? iso.slice(0, 19) + 'Z' : iso;
  const settings = chance(0.04) ? null : { muted: chance(0.1) ? pick([false, 0, null, 1, 'да', '']) : chance(0.85), mutedUntil: until };
  if (settings && settings.mutedUntil === undefined) delete settings.mutedUntil;
  if (settings && chance(0.05)) delete settings.muted;
  const zone = chance(0.5) ? 0 : pick([180, -480, 330, 60, 120, -300, 765, -720]);
  const offsetEnd = chance(0.9) ? zone : zone + pick([60, -60]);
  write('settingsMuteState', [settings, now, zone, offsetEnd], muteWant(settings, now, zone, offsetEnd));
}

// ---- sizes ----
const sizes = [0, 1, 512, 1023, 1024, 1025, 1535, 1536, 1537, 1024 * 1024 - 1, 1024 * 1024, 1310720, 1835008, 1024 * 1024 * 1.05, GB - 1, GB, GB + 1, 1.25 * GB, 1.05 * GB, 1.95 * GB, 9.95 * GB, 10 * GB - 1, 10 * GB, 10.5 * GB, 11.5 * GB, 20 * GB, 40 * GB, 39.96 * GB, 999.5, 0.5];
for (let i = 0; i < 1500; i++) sizes.push(Math.floor(Math.pow(2, rnd() * 37)), Math.floor(rnd() * 45 * GB), (1 + int(40)) * GB / 4 + pick([0, -1, 1]), int(4096) * 512 + pick([0, 1, -1].filter(d => d >= 0)));
for (const bytes of sizes) write('settingsSize', [bytes], { size: themeFile.formatSize(bytes), storage: storageLabel(bytes) });

for (const name of Object.keys(count).sort()) console.log(String(count[name]).padStart(7), name);
writeFileSync(join(here, 'vectors', 'settings.json'), lines.join('\n') + '\n');
console.log('settings.json', lines.length, 'cases,', Math.round(lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0) / 1024), 'KiB');
