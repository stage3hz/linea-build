import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function parse(name) {
  return ts.createSourceFile(name, readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function nodes(root, predicate) {
  const found = [];
  function visit(node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
  visit(root);
  return found;
}
const attr = (node, name) => node.attributes.properties.find(p => p.name?.getText() === name);

test('back and name constrain surface and content independently of pin, search and player siblings', () => {
  const surfaces = nodes(parse('ChatScreen.tsx'), n => ts.isJsxElement(n) && n.openingElement.tagName.getText() === 'GlassSurface');
  for (const label of ['Назад к чатам', 'Профиль ${']) {
    const matches = surfaces.filter(n => n.getText().includes(label));
    assert.equal(matches.length, 1, label);
    for (const name of ['style', 'contentStyle']) {
      const expression = attr(matches[0].openingElement, name)?.initializer?.expression;
      assert.ok(expression && ts.isObjectLiteralExpression(expression));
      const props = Object.fromEntries(expression.properties.map(p => [p.name.getText(), p.initializer.getText()]));
      assert.equal(props.height, '44', `${label}: ${name}`);
      assert.equal(props.maxHeight, '44');
      assert.equal(props.flexGrow, '0');
      assert.equal(props.flexShrink, '0');
    }
  }
});

test('native glass and fallback preserve outer and content native bounds', () => {
  const source = parse('glass.tsx');
  const views = nodes(source, n => (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText() === 'View');
  const content = views.filter(n => attr(n, 'style')?.getText().includes('contentStyle'));
  assert.equal(content.length, 3);
  const outer = views.filter(n => attr(n, 'style')?.getText().includes('borderRadius:radius},') && !attr(n, 'pointerEvents'));
  assert.equal(outer.length, 2);
  for (const view of [...content, ...outer]) assert.equal(attr(view, 'collapsable')?.initializer?.expression?.getText(), 'false');
  assert.equal(nodes(source, n => ts.isJsxSelfClosingElement(n) && n.tagName.getText() === 'GlassView').length, 1);
});
