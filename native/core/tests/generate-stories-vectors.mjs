// Produces tests/vectors/stories.json: the rules of stories and profile posts as the reference itself answers them
// (mobile/src/stories/seenPosts.ts, stories/StoriesStrip.tsx, ProfilePosts.tsx, media/swipeMath.ts, theme.tsx
// `formatListTime`, SettingsScreen.tsx and the caption's limit of server/src/posts.js).
// Run from the repository root:  node native/core/tests/generate-stories-vectors.mjs
//
// One case per line (JSON.stringify's own text): {"name", "args", "want"} — `name` and `args` are what the apps
// hand to the core (`stories::view`), `want` is the reference's answer put together the way the core's doc says.
// The Rust test (tests/stories_vectors.rs) reads and writes every line back to the same text and compares the
// answers as JSON text.
//
// seenPosts.ts, swipeMath.ts and theme.tsx are imported as they are (Node strips the types; the phone's storage,
// React and the interface language are replaced, as in generate-settings-vectors.mjs). The rules that live inside
// components with JSX (the strip, the viewer, the picker) cannot be imported: their expressions are written here
// again and the run stops if the reference's own line is no longer there (`pinned`).
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

// `formatListTime` reads the clock itself: the clock it reads is set here.
const RealDate = Date;
let clock = 0;
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length === 0) super(clock); else super(...args); }
  static now() { return clock; }
};

const seen = await import(pathToFileURL(file('stories/seenPosts.ts')).href);
const swipes = await import(pathToFileURL(file('media/swipeMath.ts')).href);
const themeFile = await import(pathToFileURL(file('theme.tsx')).href);

const sources = {};
const source = name => sources[name] ??= readFileSync(name.startsWith('server/') ? join(root, name) : file(name), 'utf8');
/** The run stops if the reference no longer has this text. Gives the text back. */
const pinned = (name, text) => { if (!source(name).includes(text)) throw new Error(`${name} changed: ${text}`); return text; };
/** A word of the reference: the text between quotes there. */
const word = (name, text) => { if (!source(name).includes(`'${text}'`) && !source(name).includes(`>${text}<`) && !source(name).includes(`"${text}"`) && !source(name).includes('`' + text + '`')) throw new Error(`${name} has no «${text}»`); return text; };

// ---- a deterministic generator ----
let seed = 0x570e1e5;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = n => Math.floor(rnd() * n);
const chance = p => rnd() < p;
const pick = list => list[int(list.length)];
const uuid = () => { const hex = n => Array.from({ length: n }, () => '0123456789abcdef'[int(16)]).join(''); return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`; };

const lines = [];
const count = {};
const write = (name, args, want) => {
  const line = JSON.stringify({ name, args, want: want === undefined ? null : want });
  if (JSON.stringify(JSON.parse(line)) !== line) throw new Error(`not stable JSON: ${name}`);
  lines.push(line); count[name] = (count[name] ?? 0) + 1;
};

const NOW = RealDate.UTC(2026, 10, 21, 12, 0, 0);

// ---- the constants and the words ----
pinned('ProfilePosts.tsx', 'const STORY_PHOTO_MS = 5000;');
pinned('ProfilePosts.tsx', 'const VIDEO_FAILED_MS = 1500;');
pinned('ProfilePosts.tsx', 'const left = Math.max(60, (1 - progress.value) * STORY_PHOTO_MS);');
pinned('ProfilePosts.tsx', 'delayLongPress={220} onLongPress={() => setHold(\'press\')}');
pinned('ProfilePosts.tsx', 'placeholder="Ответить…" placeholderTextColor="rgba(255,255,255,0.6)" maxLength={4000} accessibilityLabel="Ответ на историю"');
pinned('ProfilePosts.tsx', "if ((asset.duration || 0) > 60_500) throw new Error('Видео — не длиннее минуты.');");
pinned('ProfilePosts.tsx', 'videoMaxDuration: 60,');
pinned('ProfilePosts.tsx', "const small = await ImageManipulator.manipulateAsync(asset.uri, (asset.width || 0) > 1600 ? [{ resize: { width: 1600 } }] : [], { format: ImageManipulator.SaveFormat.JPEG, compress: 0.85 });");
pinned('ProfilePosts.tsx', "return (await api.upload({ uri: small.uri, name: 'post.jpg', mimeType: 'image/jpeg' }, { purpose: 'post' })).id;");
pinned('ProfilePosts.tsx', "return (await api.upload({ uri: asset.uri, name: 'post.mp4', mimeType: asset.mimeType || 'video/mp4', size: asset.fileSize }, { purpose: 'post' })).id;");
pinned('ProfilePosts.tsx', 'const gap = 2; const columns = 3; const size = Math.floor((width - gap * (columns - 1)) / columns);');
pinned('stories/StoriesStrip.tsx', 'const AVATAR = 56;');
pinned('stories/StoriesStrip.tsx', 'const REFRESH_MS = 5 * 60_000;');
pinned('stories/seenPosts.ts', 'const key = (userId: string) => `linea.seen-posts.v1:${userId}`;');
pinned('media/plainUploadCore.ts', 'export const SMALL_UPLOAD = 20 * 1024 * 1024;');
pinned('api.ts', "if(size>plain.SMALL_UPLOAD&&!isPhotoCandidate(file))return large();");
pinned('server/src/posts.js', 'const MAX_CAPTION = 300;');
pinned('server/src/posts.js', "if (typeof caption !== 'string' || caption.length > MAX_CAPTION) fail(400, `Подпись — до ${MAX_CAPTION} символов.`);");
pinned('server/src/posts.js', ".run(id, me, upload.id, kind, caption.trim(), timestamp(), kind === 'story' ? time + STORY_TTL_MS : null);");
pinned('SettingsScreen.tsx', "{ value: 'friends', label: 'Друзья', hint: 'Истории и записи видят только твои друзья.' },\n  { value: 'everyone', label: 'Все', hint: 'Истории и записи видит любой, кого ты не заблокировал.' },");
pinned('SettingsScreen.tsx', 'const current = POSTS_AUDIENCES.find(item => item.value === mode) || POSTS_AUDIENCES[0];');
pinned('SettingsScreen.tsx', "<PostsAudienceRow mode={privacy.posts || 'friends'}");
const AUDIENCES = [
  { value: 'friends', label: 'Друзья', hint: 'Истории и записи видят только твои друзья.' },
  { value: 'everyone', label: 'Все', hint: 'Истории и записи видит любой, кого ты не заблокировал.' },
];
const P = 'ProfilePosts.tsx', S = 'stories/StoriesStrip.tsx';
write('storiesRules', [], {
  photoMs: 5000, minStepMs: 60, videoFailedMs: 1500, refreshMs: 5 * 60_000, holdMs: 220,
  captionMax: 300, replyMax: 4000, videoMaxMs: 60_500, videoPickSeconds: 60,
  photoMaxWidth: 1600, photoQuality: 0.85, smallUpload: 20 * 1024 * 1024,
  seenLimit: seen.SEEN_POSTS_LIMIT, seenKey: 'linea.seen-posts.v1:', avatar: 56, columns: 3, gap: 2,
  audienceGroup: pinned('SettingsScreen.tsx', '<Group label="Истории и записи">') && 'Истории и записи',
  audienceTitle: word('SettingsScreen.tsx', 'Кто видит мои истории и записи'),
  audiences: AUDIENCES,
  words: {
    mine: word(S, 'Моя история'), addStory: word(S, 'Добавить историю'), addPost: word(P, 'Добавить публикацию'), post: word(S, 'запись'), pending: word(S, 'заявка'),
    addStoryFailed: word(S, 'Не удалось добавить историю.'), addPostFailed: word(P, 'Не удалось добавить публикацию.'), removeFailed: word(P, 'Не удалось удалить.'),
    videoTooLong: word(P, 'Видео — не длиннее минуты.'), mediaOnly: word('media/plainUploadCore.ts', 'Публикация — фото или видео MP4/MOV.'),
    hidden: word(P, 'Публикации и истории видны только друзьям'), tabPosts: word(P, 'Публикации'), tabStories: word(P, 'Истории'),
    removePost: word(P, 'Публикация'), removeStory: word(P, 'История'), remove: word(P, 'Удалить'), removeAbout: word(P, 'Исчезнет из профиля у всех.'),
    videoGone: word(P, 'Видео недоступно'), previous: word(P, 'Предыдущее'), next: word(P, 'Следующее'), close: word(P, 'Закрыть'),
    views: word(P, 'Просмотры'), nobodyWatched: word(P, 'Пока никто не смотрел'), reply: word(P, 'Ответить…'), replyLabel: word(P, 'Ответ на историю'), sendReply: word(P, 'Отправить ответ'),
    replySent: word(P, 'Ответ отправлен в чат'), replyFailed: word(P, 'Не удалось отправить ответ.'), noChat: word(S, 'Не удалось открыть чат с автором.'),
    photo: word(P, 'Фото'), video: word(P, 'Видео'), stories: word('UserProfile.tsx', 'Истории'), profileMedia: word('UserProfile.tsx', 'Фото и видео профиля'),
    quote: word('ChatScreen.tsx', 'История'), openStory: word('MessageRow.tsx', 'Открыть историю'), storyGone: word('ChatScreen.tsx', 'История недоступна'),
  },
});

// ---- posts opened on this device ----
const someIds = Array.from({ length: 40 }, uuid);
const longList = Array.from({ length: 520 }, (_, i) => `p${i}`);
const raws = [null, '', ' ', 'не JSON', '{}', '[]', 'null', '7', '"a"', '[1,2,"a",null,"a","b",{"id":"c"},["d"],""]', JSON.stringify(longList), JSON.stringify([...longList, ...longList.slice(0, 50)]),
  JSON.stringify(['x'.repeat(200), 'y'.repeat(201), 'я'.repeat(200), '😀'.repeat(100), '😀'.repeat(101)]), ' ["a" , "b"] ', '["a","b"', '["\\ud83d"]', '[true,false]', '{"0":"a","length":1}'];
for (const raw of raws) write('storiesSeenParse', [raw], seen.parseSeenPosts(raw));
for (let i = 0; i < 300; i++) {
  const list = Array.from({ length: int(12) }, () => chance(0.1) ? pick([1, null, '', {}, 'x'.repeat(201)]) : pick(someIds));
  const raw = chance(0.05) ? JSON.stringify(list).slice(0, -1) : JSON.stringify(chance(0.05) ? { list } : list);
  write('storiesSeenParse', [raw], seen.parseSeenPosts(raw));
}
for (let i = 0; i < 400; i++) {
  const list = chance(0.03) ? longList.slice(0, pick([498, 499, 500])) : [...new Set(Array.from({ length: int(10) }, () => pick(someIds)))];
  const ids = Array.from({ length: int(6) }, () => chance(0.08) ? '' : chance(0.5) ? pick(someIds) : pick(list.length ? list : someIds));
  write('storiesSeenAdd', [list, ids], seen.withSeenPosts(list, ids));
}

// ---- the strip and the viewer ----
pinned(S, 'if (!feed || (!feed.items.length && !feed.mine.length)) return');
pinned(S, 'const mineSeen = feed.mine.length > 0;');
pinned(S, 'const own = viewing === user.id;');
pinned(S, 'const people = stripOrder(feed.items, seenPosts);');
pinned(S, 'const shown = viewing === null || own ? null : people.find(item => item.user.id === viewing) ?? null;');
pinned(S, 'const postsShown = !!shown && !shown.stories.length;');
pinned(S, 'const current = viewing === null ? null : own ? { user, stories: feed.mine } : shown ? { user: shown.user, stories: postsShown ? shown.posts ?? [] : shown.stories } : null;');
pinned(S, 'const order = [...(feed.mine.length ? [user.id] : []), ...people.map(item => item.user.id)];');
pinned(S, 'const at = viewing === null ? -1 : order.indexOf(viewing);');
pinned(S, 'const before = at > 0 ? order[at - 1] : null, after = at >= 0 && at + 1 < order.length ? order[at + 1] : null;');
pinned(S, 'const start = !current ? 0 : entered < 0 ? current.stories.length - 1 : own || postsShown ? 0 : Math.max(0, current.stories.findIndex(story => !story.seen));');
pinned(S, "accessibilityLabel={mineSeen ? 'Моя история' : 'Добавить историю'}");
pinned(S, "const post = !item.stories.length; const fresh = hasUnseen(item, seenPosts);");
pinned(S, "const state = post ? ', запись' : item.unseen ? `, новых историй: ${item.unseen}` : ', истории просмотрены';");
pinned(S, "accessibilityLabel={`${item.user.displayName}${state}${item.pending ? ', заявка' : ''}`}");
pinned(S, "{label(item.user.displayName.trim().split(/\\s+/)[0] || item.user.displayName)}");
pinned(S, "{post || item.pending ? <Text numberOfLines={1} style={{ color: t.muted, fontSize: 11, maxWidth: AVATAR + 16, textAlign: 'center' }}>{post ? 'запись' : 'заявка'}</Text> : null}");
pinned(S, '{current && current.stories.length ? <PostViewer');
pinned(S, 'if (post.seen) return;');
pinned(S, 'setFeed(current => current ? { ...current, items: current.items.map(entry => entry.user.id !== item.user.id ? entry : { ...entry, unseen: Math.max(0, entry.unseen - 1), stories: entry.stories.map(story => story.id === post.id ? { ...story, seen: true } : story) }) } : current);');

// The core compares the times by their code units; the reference by `localeCompare`. For the server's times the
// two agree — checked here for every pair the reference's own comparison is asked about.
const unitOrder = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const checkTimes = items => { for (const a of items) for (const b of items) if (a.latest && b.latest && Math.sign(b.latest.localeCompare(a.latest)) !== unitOrder(b.latest, a.latest)) throw new Error(`localeCompare is not the order of code units: ${a.latest} ${b.latest}`); };

const stripWant = (feed, seenIds, me) => {
  const seenPosts = new Set(seenIds);
  const people = seen.stripOrder(feed.items, seenPosts);
  const mineSeen = feed.mine.length > 0;
  return {
    show: !(!feed.items.length && !feed.mine.length),
    mine: { has: mineSeen, label: 'Моя история', spoken: mineSeen ? 'Моя история' : 'Добавить историю' },
    people: people.map(item => {
      const post = !item.stories.length; const fresh = seen.hasUnseen(item, seenPosts);
      const state = post ? ', запись' : item.unseen ? `, новых историй: ${item.unseen}` : ', истории просмотрены';
      return { id: item.user.id, name: item.user.displayName.trim().split(/\s+/)[0] || item.user.displayName, spoken: `${item.user.displayName}${state}${item.pending ? ', заявка' : ''}`,
        post, pending: !!item.pending, fresh, sub: post || item.pending ? (post ? 'запись' : 'заявка') : '' };
    }),
    order: [...(feed.mine.length ? [me] : []), ...people.map(item => item.user.id)],
  };
};
const viewerWant = (feed, seenIds, me, viewing, entered) => {
  const seenPosts = new Set(seenIds);
  const own = viewing === me;
  const people = seen.stripOrder(feed.items, seenPosts);
  const shown = viewing === null || own ? null : people.find(item => item.user.id === viewing) ?? null;
  const postsShown = !!shown && !shown.stories.length;
  const current = viewing === null ? null : own ? { stories: feed.mine } : shown ? { user: shown.user, stories: postsShown ? shown.posts ?? [] : shown.stories } : null;
  const order = [...(feed.mine.length ? [me] : []), ...people.map(item => item.user.id)];
  const at = viewing === null ? -1 : order.indexOf(viewing);
  const before = at > 0 ? order[at - 1] : null, after = at >= 0 && at + 1 < order.length ? order[at + 1] : null;
  const start = !current ? 0 : entered < 0 ? current.stories.length - 1 : own || postsShown ? 0 : Math.max(0, current.stories.findIndex(story => !story.seen));
  return { open: !!(current && current.stories.length), own, posts: postsShown, items: current ? current.stories.map(story => story.id) : [], start, before, after };
};
const viewedWant = (current, userId, storyId) => {
  const item = current.items.find(entry => entry.user.id === userId);
  const post = item?.stories.find(story => story.id === storyId);
  if (!item || !post || post.seen) return null;
  return { ...current, items: current.items.map(entry => entry.user.id !== item.user.id ? entry : { ...entry, unseen: Math.max(0, entry.unseen - 1), stories: entry.stories.map(story => story.id === post.id ? { ...story, seen: true } : story) }) };
};

const NAMES = ['Алиса Воронцова', 'Дмитрий Орлов', 'Лев', ' Марина  Ким ', 'Саша', 'Анна-Мария де ла Крус', ' Иван Петров', 'Zoë\tQuinn', '   ', '', '😀 Смайл', 'Вера\nСоколова', '﻿Игорь', 'Ян　Ли', '\ud83d одиночный', 'O\'Neil'];
const stamp = () => new RealDate(NOW - int(48 * 3600_000)).toISOString();
const media = () => ({ id: uuid(), mimeType: pick(['image/jpeg', 'image/png', 'video/mp4']), isImage: true, isVideo: false, size: 1000 + int(4_000_000) });
// Most stories carry only what the rules read (the file stays small); some are whole, as the server sends them.
const story = (owner, withSeen) => {
  const createdAt = stamp();
  const made = chance(0.1) ? { id: uuid(), kind: 'story', caption: chance(0.3) ? 'Подпись' : '', createdAt, expiresAt: new RealDate(RealDate.parse(createdAt) + 86_400_000).toISOString(), media: media() } : { id: uuid(), createdAt };
  if (owner) made.views = int(30);
  else if (withSeen) made.seen = chance(0.5);
  return made;
};
const post = () => chance(0.1) ? { id: uuid(), kind: 'post', caption: '', createdAt: stamp(), expiresAt: null, media: media() } : { id: uuid(), createdAt: stamp() };
const person = () => ({ id: uuid(), displayName: pick(NAMES) });
const makeFeed = () => {
  const noTimes = chance(0.08); // an older server: no `latest` for anyone
  const items = Array.from({ length: pick([0, 1, 2, 3, 4, 6, 9]) }, () => {
    const posts = chance(0.3);
    const stories = posts ? [] : Array.from({ length: 1 + int(4) }, () => story(false, chance(0.9))).sort((a, b) => unitOrder(a.createdAt, b.createdAt));
    const item = { user: person(), stories, unseen: chance(0.05) ? pick([0, stories.length + 1]) : stories.filter(entry => !entry.seen).length };
    const recent = posts ? Array.from({ length: 1 + int(4) }, post).sort((a, b) => unitOrder(b.createdAt, a.createdAt)) : [];
    if (recent.length) item.posts = recent;
    if (chance(0.15)) item.pending = true;
    if (!noTimes) item.latest = stories.length ? stories[stories.length - 1].createdAt : recent[0].createdAt;
    // The same moment for two people now and then: their order is then the feed's own.
    if (!noTimes && chance(0.1)) item.latest = new RealDate(NOW - 3600_000).toISOString();
    return item;
  });
  return { items, mine: Array.from({ length: chance(0.5) ? 0 : 1 + int(4) }, () => story(true, false)) };
};
const seenFor = feed => {
  const ids = feed.items.flatMap(item => (item.posts ?? []).map(entry => entry.id));
  return [...ids.filter(() => chance(0.5)), ...(chance(0.3) ? [uuid()] : [])];
};
for (let i = 0; i < 260; i++) {
  const feed = makeFeed(), me = uuid(), seenIds = seenFor(feed);
  checkTimes(feed.items);
  write('storiesStrip', [feed, seenIds, me], stripWant(feed, seenIds, me));
  const ids = [me, uuid(), ...feed.items.map(item => item.user.id)];
  for (let k = 0; k < 3; k++) {
    const viewing = pick(ids), entered = pick([1, -1]);
    write('storiesViewer', [feed, seenIds, me, viewing, entered], viewerWant(feed, seenIds, me, viewing, entered));
  }
  const someone = feed.items.length ? pick(feed.items) : null;
  const userId = someone && chance(0.9) ? someone.user.id : uuid();
  const storyId = someone && someone.stories.length && chance(0.9) ? pick(someone.stories).id : uuid();
  write('storiesViewed', [feed, userId, storyId], viewedWant(feed, userId, storyId));
}
// Nothing at all, and only my own.
write('storiesStrip', [{ items: [], mine: [] }, [], 'me'], stripWant({ items: [], mine: [] }, [], 'me'));
write('storiesViewer', [{ items: [], mine: [] }, [], 'me', 'me', 1], viewerWant({ items: [], mine: [] }, [], 'me', 'me', 1));

// ---- the viewer's line under the name ----
pinned(P, 'const when = new Date(current.createdAt); const ago = Math.max(0, Math.round((Date.now() - when.getTime()) / 3_600_000));');
pinned(P, "{story ? (ago < 1 ? 'только что' : `${ago} ч назад`) : `${index + 1} из ${items.length}`}");
const headlineWant = (createdAt, now, isStory, index, total) => {
  const when = new RealDate(createdAt); const ago = Math.max(0, Math.round((now - when.getTime()) / 3_600_000));
  return isStory ? (ago < 1 ? 'только что' : `${ago} ч назад`) : `${index + 1} из ${total}`;
};
for (let i = 0; i < 1200; i++) {
  const span = pick([0, 1, -1, 1_799_999, 1_800_000, 1_800_001, 3_600_000, 5_399_999, 5_400_000, 23 * 3_600_000, 86_400_000, -3_600_000, -1_800_000, -1_800_001, 40 * 3_600_000]) + (chance(0.5) ? int(7_200_000) : 0);
  const iso = new RealDate(NOW - span).toISOString();
  const createdAt = chance(0.05) ? pick(['', 'не дата', 'abc']) : chance(0.1) ? iso.slice(0, 19) + 'Z' : chance(0.1) ? iso.replace('Z', '+00:00') : iso;
  const isStory = chance(0.7), total = 1 + int(12), index = int(total);
  write('storiesHeadline', [createdAt, NOW, isStory, index, total], headlineWant(createdAt, NOW, isStory, index, total));
}

// ---- swipes ----
pinned(P, ".onStart(event => { axis.value = storyAxis(event.translationX, event.translationY) === 'x' ? 1 : 2; runOnJS(setHold)('drag'); })");
pinned(P, 'if (axis.value === 1) x.value = rubberBand(event.translationX, event.translationX < 0 ? hasNext : hasPrevious);');
pinned(P, 'else if (axis.value === 2) y.value = event.translationY > 0 ? event.translationY : event.translationY / 4;');
pinned(P, "const action = storySwipe({ axis: axis.value === 1 ? 'x' : 'y', tx: event.translationX, ty: event.translationY, vx: event.velocityX, vy: event.velocityY, width });");
pinned(P, "interpolate(dismissProgress(Math.max(0, y.value), height), [0, 1], [1, 0.86], 'clamp')");
pinned(P, "interpolate(dismissProgress(Math.max(0, y.value), height), [0, 1], [1, 0.15], 'clamp')");
const length = () => pick([0, 1, -1, 10, -10, 12, -12, 59, 60, 61, -59, -60, -61, 97, 98, 99, -97.5, -98, 119, 120, 121, -120, -121, 200, -200, 390, -390]) + (chance(0.4) ? Math.round((rnd() - 0.5) * 80 * 10) / 10 : 0);
const speed = () => pick([0, 1, -1, 299, 300, 301, -300, -301, 449, 450, 451, -450, -451, 599, 600, 601, -600, -601, 899, 900, 901, -900, -901, 2000, -2000]) + (chance(0.3) ? Math.round((rnd() - 0.5) * 400) : 0);
for (let i = 0; i < 3000; i++) {
  const axis = pick(['x', 'y']), tx = length(), ty = length(), vx = speed(), vy = speed(), width = pick([320, 375, 390, 393, 430, 0]);
  write('storiesSwipe', [axis, tx, ty, vx, vy, width], swipes.storySwipe({ axis, tx, ty, vx, vy, width }));
}
for (let i = 0; i < 600; i++) { const dx = length(), dy = chance(0.2) ? pick([dx, -dx]) : length(); write('storiesAxis', [dx, dy], swipes.storyAxis(dx, dy)); }
for (let i = 0; i < 1500; i++) {
  const axis = pick(['x', 'y']), tx = length(), ty = length(), hasNext = chance(0.6), hasPrevious = chance(0.6), height = pick([568, 667, 844, 852, 932, 0, -1]);
  let x = 0, y = 0;
  if (axis === 'x') x = swipes.rubberBand(tx, tx < 0 ? hasNext : hasPrevious);
  else y = ty > 0 ? ty : ty / 4;
  write('storiesDrag', [axis, tx, ty, hasNext, hasPrevious, height], { x, y, progress: swipes.dismissProgress(Math.max(0, y), height) });
}

// ---- views ----
pinned(P, 'accessibilityLabel={`Просмотры: ${views ?? 0}`}');
pinned(P, '{`Просмотров: ${viewers.count}`}');
pinned(P, '{formatListTime(entry.viewedAt)}');
for (const views of [null, 0, 1, 2, 5, 11, 21, 100, 1000, 12345]) write('storiesViews', [views], { count: views ?? 0, spoken: `Просмотры: ${views ?? 0}`, heading: `Просмотров: ${views ?? 0}` });
// The list's time reads the local clock: the offsets of the two moments from UTC (minutes) are handed over, and
// the reference, run in UTC, is given both moments moved by them — the wall clock it would read on the phone.
for (let i = 0; i < 1800; i++) {
  const now = NOW + int(86_400_000 * 400) - 86_400_000 * 200;
  const span = pick([0, 60_000, 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 86_400_000 - 1, 86_400_000, 30 * 3_600_000, 2 * 86_400_000, 5 * 86_400_000, 40 * 86_400_000, 200 * 86_400_000]) + int(3_600_000);
  const iso = new RealDate(now - span).toISOString();
  const at = chance(0.03) ? pick(['', 'не дата']) : chance(0.1) ? iso.slice(0, 19) + 'Z' : iso;
  const zone = chance(0.4) ? 0 : pick([180, -480, 330, 60, 120, -300, 765, -720]);
  const zoneAt = chance(0.9) ? zone : zone + pick([60, -60]);
  const parsed = RealDate.parse(at);
  clock = now + zone * 60_000;
  const want = Number.isFinite(parsed) ? themeFile.formatListTime(new RealDate(parsed + zoneAt * 60_000).toISOString()) : themeFile.formatListTime(at);
  write('storiesViewedAt', [at, now, zoneAt, zone], want);
}

// ---- publishing ----
const captionWant = text => ({ caption: text.trim(), error: text.length > 300 ? `Подпись — до ${300} символов.` : '', left: 300 - text.length });
const texts = ['', ' ', 'Привет', '  Привет, мир  ', '\n\tс переносом ', 'я'.repeat(299), 'я'.repeat(300), 'я'.repeat(301), ' '.repeat(301), ' ' + 'a'.repeat(299), ' ' + 'a'.repeat(300), '😀'.repeat(150), '😀'.repeat(151), '﻿BOM ', '​нулевой', 'конец　', '\ud83d'];
for (const text of texts) write('storiesCaption', [text], captionWant(text));
for (let i = 0; i < 500; i++) {
  const edge = () => Array.from({ length: int(3) }, () => pick([' ', '\n', '\t', ' ', ' ', '﻿', '​', ' ', '\u0085'])).join('');
  const text = edge() + Array.from({ length: pick([0, 1, 5, 40, 290, 296, 300, 305]) }, () => pick(['а', 'b', ' ', '😀', 'ё', '\n'])).join('') + edge();
  write('storiesCaption', [text], captionWant(text));
}
const uploadWant = asset => {
  if (asset.video) {
    if ((asset.durationMs || 0) > 60_500) return { error: 'Видео — не длиннее минуты.' };
    return { error: '', name: 'post.mp4', mimeType: asset.mimeType || 'video/mp4', resizeWidth: null, quality: null, purpose: 'post', chunked: (asset.size || 0) > 20 * 1024 * 1024 };
  }
  return { error: '', name: 'post.jpg', mimeType: 'image/jpeg', resizeWidth: (asset.width || 0) > 1600 ? 1600 : null, quality: 0.85, purpose: 'post', chunked: false };
};
for (let i = 0; i < 800; i++) {
  const asset = { video: chance(0.5) };
  if (chance(0.9)) asset.width = pick([0, 1, 640, 1599, 1600, 1601, 4032, 8064]);
  if (chance(0.9)) asset.durationMs = pick([0, 1, 5000, 59_999, 60_000, 60_499, 60_500, 60_501, 61_000, 600_000, null]);
  if (chance(0.8)) asset.mimeType = pick(['video/mp4', 'video/quicktime', '', null, 'image/heic']);
  if (chance(0.9)) asset.size = pick([0, 1, 1_000_000, 20 * 1024 * 1024 - 1, 20 * 1024 * 1024, 20 * 1024 * 1024 + 1, 300_000_000, null]);
  write('storiesUpload', [asset], uploadWant(asset));
}

// ---- a profile ----
pinned(P, '{count ? `${label} ${count}` : label}');
pinned(P, "{tabButton('post', 'Публикации', data?.posts.length ?? 0)}{tabButton('story', 'Истории', data?.stories.length ?? 0)}");
pinned(P, "<Text style={{ fontSize: 54 }}>{tab === 'post' ? '🖼️' : '✨'}</Text>");
pinned(P, "{tab === 'post' ? 'Публикаций пока нет…' : 'Историй пока нет…'}");
pinned(P, "{own ? (tab === 'post' ? 'Публикуй фото и видео в своём профиле — их увидят друзья.' : 'История видна друзьям 24 часа, потом исчезает.') : (tab === 'post' ? 'Здесь появятся фото и видео.' : 'Сейчас историй нет.')}");
pinned(P, "{own ? <View style={{ alignSelf: 'stretch', marginTop: 8, paddingHorizontal: 30 }}><Button label={tab === 'post' ? 'Добавить публикацию' : 'Добавить историю'}");
const tabLabel = (label, total) => total ? `${label} ${total}` : label;
for (const posts of [0, 1, 2, 9, 10, 300]) for (const stories of [0, 1, 3, 50]) write('storiesTabs', [posts, stories], [tabLabel('Публикации', posts), tabLabel('Истории', stories)]);
for (const tab of ['post', 'story']) for (const own of [true, false]) {
  write('storiesEmpty', [tab, own], {
    emoji: tab === 'post' ? '🖼️' : '✨', heading: tab === 'post' ? 'Публикаций пока нет…' : 'Историй пока нет…',
    hint: own ? (tab === 'post' ? 'Публикуй фото и видео в своём профиле — их увидят друзья.' : 'История видна друзьям 24 часа, потом исчезает.') : (tab === 'post' ? 'Здесь появятся фото и видео.' : 'Сейчас историй нет.'),
    button: own ? (tab === 'post' ? 'Добавить публикацию' : 'Добавить историю') : null,
  });
}
write('storiesEmpty', ['gift', true], null);
for (const mode of ['friends', 'everyone', undefined, null, '', 'nobody', 'Everyone']) {
  const value = mode || 'friends';
  write('storiesAudience', [mode === undefined ? null : mode], AUDIENCES.find(item => item.value === value) || AUDIENCES[0]);
}

for (const name of Object.keys(count).sort()) console.log(String(count[name]).padStart(7), name);
writeFileSync(join(here, 'vectors', 'stories.json'), lines.join('\n') + '\n');
console.log('stories.json', lines.length, 'cases,', Math.round(lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0) / 1024), 'KiB');
