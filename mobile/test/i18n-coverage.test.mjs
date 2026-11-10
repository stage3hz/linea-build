import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Every fixed Russian interface string on the key screens must have an English entry: en.json is keyed by
// the exact Russian text (src/i18n), so a new literal without an entry stays Russian in the English UI.
// The scan reads the TypeScript AST, so formatting and comments don't matter. Left out on purpose:
// template literals with ${…} (built at runtime, can't be looked up by exact key), console output,
// comparisons (key codes, server message checks) and the technical gate reasons thrown with a prefix
// («MP4: …», «JPEG: …», «ICC: …»).
const require = createRequire(import.meta.url);
const ts = require('typescript');
const en = require('../src/i18n/en.json');

const SCREENS = [
  'AuthScreen.tsx', 'ChatListScreen.tsx', 'ChatScreen.tsx', 'MessageRow.tsx', 'SettingsScreen.tsx', 'SecurityScreen.tsx',
  'NewLoginNotice.tsx', 'UserProfile.tsx', 'MiniProfile.tsx', 'PeopleScreen.tsx', 'components.tsx', 'ContextMenu.tsx',
  'ChatSheets.tsx', 'notifications/NotificationsSection.tsx', 'notifications/MuteSheet.tsx', 'lock/PasscodeSettings.tsx', 'lock/LockGate.tsx',
  'scheduled/ScheduledScreen.tsx', 'scheduled/SchedulePicker.tsx', 'calls/CallHistory.tsx', 'audio/AudioSettings.tsx',
  'format/FormatToolbar.tsx', 'photo/editor/PhotoEditorScreen.tsx', 'photo/editor/EditorPanels.tsx',
  'privacy/lastSeenModel.ts', 'privacy/privacyStore.ts', 'presence.ts',
];
const CYRILLIC = /[А-Яа-яЁё]/;
const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

const known = text => en[text] !== undefined || en[text.trim()] !== undefined;
function skipped(node) {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && EQUALITY.has(parent.operatorToken.kind)) return true;
  if (ts.isCaseClause(parent)) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  for (let n = parent; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isImportDeclaration(n)) return true;
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText();
      if (/^console\./.test(callee) || /^(fail|mp4Fail|corrupt)$/.test(callee)) return true;
      if (ts.isPropertyAccessExpression(n.expression) && /^(includes|startsWith|endsWith|indexOf|test|match|split)$/.test(n.expression.name.text) && n.arguments.includes(node)) return true;
    }
  }
  return false;
}

function missingIn(file) {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const missing = [];
  (function visit(node) {
    let text = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
    else if (ts.isJsxText(node)) text = node.text.replace(/\s+/g, ' ').trim();
    if (text && CYRILLIC.test(text) && !skipped(node) && !known(text)) missing.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1} «${text}»`);
    ts.forEachChild(node, visit);
  })(tree);
  return missing;
}

test('Russian interface strings on the key screens have English translations', () => {
  const missing = SCREENS.flatMap(missingIn);
  assert.deepEqual(missing, [], `add these to src/i18n/en.json:\n${missing.join('\n')}`);
});

test('the scan sees literals, JSX text and labels, and leaves comparisons and templates alone', () => {
  const sample = 'const a = <Text accessibilityLabel="Нечто новое">Ещё строка</Text>; if (key === "Ё") {} const b = `Шаблон ${a}`; const c = "Отправить";';
  const tree = ts.createSourceFile('sample.tsx', sample, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  (function visit(node) {
    const text = ts.isStringLiteral(node) ? node.text : ts.isJsxText(node) ? node.text.trim() : null;
    if (text && CYRILLIC.test(text) && !skipped(node) && !known(text)) found.push(text);
    ts.forEachChild(node, visit);
  })(tree);
  assert.deepEqual(found, ['Нечто новое', 'Ещё строка']);
});
