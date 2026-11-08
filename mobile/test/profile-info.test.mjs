// Profile screens (ProfileScreen, UserProfile, ProfilePosts): the fixes of B31 / B32 / B65 / B66 stay in place.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const read = name => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
function parse(name) { return ts.createSourceFile(name, read(name), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); }
function nodes(root, predicate) {
  const found = [];
  function visit(node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(root);
  return found;
}
const attr = (node, name) => node.attributes.properties.find(p => p.name?.getText() === name);
const elements = (root, tag) => nodes(root, n => (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText() === tag);

test('B31: profile videos use the same expo-video player on PC, with an authenticated in-memory copy', () => {
  const source = read('ProfilePosts.tsx');
  assert.ok(!/isVideo && Platform\.OS !== 'web'/.test(source), 'no web-only fallback to <Image> for a video');
  // One shared, bounded cache of authenticated in-memory copies (the video avatar and banner use it too).
  assert.match(source, /import \{ webVideoUrl \} from '\.\/platina\/Decor';/);
  assert.ok(!/function webVideoUrl\(/.test(source), 'no second copy of webVideoUrl');
  const decor = read('platina/Decor.tsx');
  assert.match(decor, /export function webVideoUrl\(api: Api, id: string\): Promise<string>/);
  assert.match(decor, /const key = `\$\{api\.base\}\\n\$\{id\}`;/, 'keyed by realm and file');
  assert.match(decor, /URL\.createObjectURL\(blob\)/);
  assert.match(decor, /webVideoCache\.size <= WEB_VIDEO_CACHE_MAX/);
  assert.match(decor, /URL\.revokeObjectURL\(u\)/, 'evicted object URLs are revoked');
  assert.match(source, /function webVideoThumbnail\(api: Api, id: string\)/);
  assert.match(source, /canvas\.toDataURL\('image\/jpeg'/);
  // The story timer leaves every video to its own end, on PC too.
  assert.match(source, /if \(current\.media\.isVideo\) return;/);
  const media = nodes(parse('ProfilePosts.tsx'), n => ts.isFunctionDeclaration(n) && n.name?.getText() === 'VideoMedia');
  assert.equal(media.length, 1);
  assert.match(media[0].getText(), /useVideoPlayer\(web \? \(webSrc \? \{ uri: webSrc \} : null\) :/);
  const text = media[0].getText();
  assert.match(text, /addListener\('playToEnd'/);
  // A video that fails to load never fires playToEnd: a player error or a failed PC fetch marks it failed,
  // the placeholder shows and a story moves on.
  assert.match(text, /addListener\('statusChange', \(\{ status \}\) => \{ if \(status === 'error'\) setFailed\(true\); \}\)/);
  assert.match(text, /\.catch\(\(\) => \{ if \(live\) setFailed\(true\); \}\)/);
  assert.match(text, /if \(!failed \|\| !onEnd \|\| !active\) return; const timer = setTimeout\(onEnd, VIDEO_FAILED_MS\)/);
  assert.match(text, /Видео недоступно/);
});

test('B32: the banner of another profile is as wide as the PC card', () => {
  const banners = elements(parse('UserProfile.tsx'), 'ProfileBanner');
  assert.equal(banners.length, 1);
  assert.equal(attr(banners[0], 'width')?.initializer?.expression?.getText(), 'card ? cardWidth : width');
});

test('B65: both profiles render the shared ProfileInfoCard and nothing else draws the info rows', () => {
  for (const name of ['ProfileScreen.tsx', 'UserProfile.tsx']) {
    const source = read(name);
    assert.match(source, /import \{ ProfileInfoCard \} from '\.\/ProfileInfo';/, name);
    assert.equal(elements(parse(name), 'ProfileInfoCard').length, 1, name);
    assert.ok(!source.includes('>имя пользователя<'), `${name}: the label lives in ProfileInfo.tsx only`);
    assert.ok(!/function InfoRow/.test(source), `${name}: InfoRow is shared`);
  }
  const card = parse('ProfileInfo.tsx');
  const rows = elements(card, 'InfoRow').map(n => attr(n, 'label').initializer.text);
  assert.deepEqual(rows, ['имя пользователя', 'день рождения', 'о себе']);
  // Other people's profiles: the @username is not repeated under the name when there is no presence line.
  const user = read('UserProfile.tsx');
  assert.ok(!/<Text[^>]*>@\{shown\.username\}<\/Text>/.test(user), '@username only in the card');
  assert.match(user, /\{status \? <Text[^]*?\{status\}<\/Text> : null\}/);
});

test('B66: changing the photo while editing saves only the photo; ✓ saves the draft, ✕ discards it', () => {
  const screen = parse('ProfileScreen.tsx');
  const apply = nodes(screen, n => ts.isVariableDeclaration(n) && n.name.getText() === 'applyAvatar');
  assert.equal(apply.length, 1);
  const calls = nodes(apply[0], n => ts.isCallExpression(n) && n.expression.getText() === 'api.profile');
  assert.equal(calls.length, 1);
  const fields = calls[0].arguments[0].properties.map(p => p.name.getText());
  assert.deepEqual(fields, ['avatarId']);
  const save = nodes(screen, n => ts.isVariableDeclaration(n) && n.name.getText() === 'save');
  assert.match(save[0].getText(), /displayName: name\.trim\(\), bio: bio\.trim\(\), birthday, gender, avatarColor: color, avatarId, profilePattern: pattern/);
});
