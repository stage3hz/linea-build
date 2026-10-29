import assert from 'node:assert/strict';
import test from 'node:test';
import { addSelectionQueue } from '../src/attachments/uploadQueue.ts';

test('a partial batch failure retains only unfinished items and retry does not upload the successful file twice', async () => {
  let selected = [{ id: 'a' }, { id: 'b' }, { id: 'c' }], failed = false;
  const uploads = [], counts = [];
  const operations = {
    isCurrent: () => true,
    resolve: async item => item,
    add: async item => { uploads.push(item.id); if (item.id === 'b' && !failed) { failed = true; throw new Error('network'); } },
    added: (item, count) => { selected = selected.filter(value => value.id !== item.id); counts.push(count); },
  };
  await assert.rejects(addSelectionQueue([...selected], operations), /network/);
  assert.deepEqual(selected.map(item => item.id), ['b', 'c']);
  await addSelectionQueue([...selected], operations);
  assert.deepEqual(uploads, ['a', 'b', 'b', 'c']);
  assert.deepEqual(counts, [1, 1, 2]);
  assert.deepEqual(selected, []);
});

test('a resolved original from a closed or different chat never starts an upload', async () => {
  let live = true, uploaded = false, removed = false;
  await addSelectionQueue([{ id: 'a' }], {
    isCurrent: () => live,
    resolve: async item => { live = false; return item; },
    add: async () => { uploaded = true; }, added: () => { removed = true; },
  });
  assert.equal(uploaded, false); assert.equal(removed, false);
});

test('closing during an upload does not continue the rest of the queue or update a new selection', async () => {
  let live = true;
  const resolved = [], uploaded = [], removed = [];
  await addSelectionQueue([{ id: 'a' }, { id: 'b' }], {
    isCurrent: () => live,
    resolve: async item => { resolved.push(item.id); return item; },
    add: async item => { uploaded.push(item.id); live = false; },
    added: item => { removed.push(item.id); },
  });
  assert.deepEqual(resolved, ['a']); assert.deepEqual(uploaded, ['a']); assert.deepEqual(removed, []);
});

test('an owned original copy is disposed when its resolution finishes after the panel closes', async () => {
  let live = true;
  const disposed = [];
  await addSelectionQueue([{ id: 'video' }], {
    isCurrent: () => live,
    resolve: async item => { live = false; return { ...item, uri: 'cache:original-copy' }; },
    add: async () => assert.fail('closed panel must not upload'), added: () => assert.fail('closed panel must not update selection'),
    dispose: async item => { disposed.push(item.uri); },
  });
  assert.deepEqual(disposed, ['cache:original-copy']);
});

test('an owned original copy is disposed on upload failure while the selected item remains for retry', async () => {
  const disposed = [], added = [];
  await assert.rejects(addSelectionQueue([{ id: 'video' }], {
    isCurrent: () => true,
    resolve: async item => ({ ...item, uri: 'cache:original-copy' }),
    add: async () => { throw new Error('upload failed'); }, added: item => { added.push(item.id); },
    dispose: async item => { disposed.push(item.uri); },
  }), /upload failed/);
  assert.deepEqual(disposed, ['cache:original-copy']); assert.deepEqual(added, []);
});
