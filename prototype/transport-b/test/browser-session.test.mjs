import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertNotProductionHost, BrowserSessionError, CDPBrowser, collectSession, runBrowserSession, selectYandexCookies, writeSessionFile } from '../stand/browser-session.mjs';

const now = 1_000_000;
const CANARY = 'SESSION_CANARY_DO_NOT_PRINT';
const cookie = changes => ({ name: 'Session_id', value: CANARY, domain: '.yandex.ru', path: '/', expires: now / 1000 + 3600, secure: true, httpOnly: true, ...changes });
function directory(run) {
  const root = mkdtempSync(join(tmpdir(), 'invizent-browser-session-'));
  const result = Promise.resolve().then(() => run(root));
  return result.finally(() => rmSync(root, { recursive: true, force: true }));
}

function fakeChrome(handler = command => ({ result: command.method === 'Storage.getCookies' ? { cookies: [cookie({ expires: Date.now() / 1000 + 3600 })] } : {} })) {
  const child = new EventEmitter(), output = new PassThrough(), commands = [], signals = [];
  let buffered = Buffer.alloc(0);
  const input = new Writable({ write(chunk, _encoding, done) {
    buffered = Buffer.concat([buffered, chunk]);
    let end;
    while ((end = buffered.indexOf(0)) >= 0) {
      const command = JSON.parse(buffered.subarray(0, end).toString());
      buffered = buffered.subarray(end + 1); commands.push(command);
      const answer = handler(command);
      if (answer !== null) {
        const bytes = Buffer.from(JSON.stringify({ id: command.id, ...answer }) + '\0');
        // Real pipe reads can split JSON, UTF-8 and the NUL frame delimiter.
        queueMicrotask(() => { output.write(bytes.subarray(0, 7)); output.write(bytes.subarray(7, 19)); output.write(bytes.subarray(19)); });
      }
      if (command.method === 'Browser.close') setImmediate(() => child.emit('exit', 0));
    }
    done();
  } });
  child.stdio = [null, null, null, input, output];
  child.kill = signal => { signals.push(signal); child.emit('exit', 0); return true; };
  return { child, output, commands, signals };
}

test('cookie projection keeps only canonical Yandex domains and valid private sessions', () => {
  const projected = selectYandexCookies([
    cookie(), cookie({ name: 'csrf', value: 'csrf-value', domain: 'passport.yandex.ru' }),
    cookie({ name: 'other', domain: 'ya.ru' }),
    cookie({ domain: '.yandex.ru.evil.example' }), cookie({ domain: 'notyandex.ru' }),
    cookie({ domain: 'Yandex.ru' }), cookie({ domain: '.yandex.ru\n' }),
    cookie({ name: 'Session_id\n' }), cookie({ name: 'bad name' }),
    cookie({ name: 'expired', expires: 999 }), cookie({ name: 'badvalue', value: 'x\r\nAuthorization:secret' }),
  ], now);
  assert.deepEqual(projected, [
    { name: 'Session_id', value: CANARY }, { name: 'csrf', value: 'csrf-value' }, { name: 'other', value: CANARY },
  ]);
  assert.equal(selectYandexCookies([cookie({ expires: -1 })], now)?.[0].value, CANARY);
  for (const changes of [{ value: '' }, { expires: 0 }, { expires: now / 1000 }, { expires: NaN }, { expires: undefined }, { secure: false }, { httpOnly: false }, { domain: 'evil.example' }, { name: 'Session_id\n' }, { value: 'a;b' }])
    assert.equal(selectYandexCookies([cookie(changes)], now), null);
  assert.equal(selectYandexCookies([cookie({ name: 'other' })], now), null);
  assert.throws(() => selectYandexCookies(new Array(2001).fill(cookie()), now), BrowserSessionError);
});

test('cookie file publication is private, exclusive and never follows an existing symlink', () => directory(root => {
  const output = join(root, 'cookies-yandex.json'), secret = [{ name: 'Session_id', value: CANARY }];
  writeSessionFile(output, secret);
  assert.equal(lstatSync(output).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(output)), secret);
  assert.throws(() => writeSessionFile(output, [{ name: 'Session_id', value: 'replacement' }]), error => error.message === 'private_session_write_failed');
  assert.deepEqual(JSON.parse(readFileSync(output)), secret);
  const unrelated = join(root, 'unrelated'); writeFileSync(unrelated, 'preserve');
  const link = join(root, 'linked-cookies'); symlinkSync(unrelated, link);
  assert.throws(() => writeSessionFile(link, secret), BrowserSessionError);
  assert.equal(readFileSync(unrelated, 'utf8'), 'preserve');
  assert.equal(readdirSync(root).some(name => name.startsWith('.session-')), false);
}));

test('cookie export refuses repository directories and broad directory permissions', () => directory(root => {
  const repo = join(root, 'repo'); mkdirSync(repo, { mode: 0o700 }); mkdirSync(join(repo, '.git'));
  assert.throws(() => writeSessionFile(join(repo, 'cookies-yandex.json'), []), error => error.code === 'private_path_required');
  const shared = join(root, 'shared'); mkdirSync(shared, { mode: 0o755 }); chmodSync(shared, 0o755);
  assert.throws(() => writeSessionFile(join(shared, 'cookies-yandex.json'), []), BrowserSessionError);
  assert.equal(readdirSync(shared).length, 0);
}));

test('private file boundary refuses unprojected data, absent sessions and cookie-header injection', () => directory(root => {
  const output = join(root, 'cookies-yandex.json');
  for (const projection of [[], [{ name: 'other', value: 'other' }], [{ name: 'Session_id\n', value: CANARY }],
    [{ name: 'Session_id', value: CANARY, rawDiagnostic: CANARY }], [{ name: 'Session_id', value: 'a\r\nb' }]]) {
    assert.throws(() => writeSessionFile(output, projection), error => error.code === 'private_session_write_failed');
    assert.equal(existsSync(output), false);
  }
  assert.deepEqual(readdirSync(root), []);
}));

test('CDP private pipe transport correlates split replies and sanitizes browser errors', async () => {
  const fixture = fakeChrome(command => command.method === 'Storage.getCookies' ? { result: { cookies: [cookie()] } } : { error: { message: CANARY } });
  const cdp = new CDPBrowser(fixture.child);
  assert.deepEqual(await cdp.request('Storage.getCookies'), { cookies: [cookie()] });
  await assert.rejects(cdp.request('Target.createTarget'), error => error.message === 'browser_command_failed' && !error.message.includes(CANARY));
  await cdp.stop();
  assert.equal(fixture.commands.some(command => command.method === 'Browser.close'), true);
  assert.deepEqual(fixture.signals, [], 'graceful Chrome shutdown gets time to exit without an immediate TERM');
  assert.equal(fixture.child.stdio[3].destroyed, true);
  assert.equal(fixture.child.stdio[4].destroyed, true);
});

test('shutdown releases private pipes even when Chrome exited before stop', async () => {
  const fixture = fakeChrome(), cdp = new CDPBrowser(fixture.child);
  fixture.child.emit('exit', 0);
  await cdp.stop();
  assert.equal(fixture.child.stdio[3].destroyed, true);
  assert.equal(fixture.child.stdio[4].destroyed, true);
  assert.deepEqual(fixture.signals, []);
});

test('CDP queue, incoming frame and command deadlines are bounded', async () => {
  const fixture = fakeChrome(() => null), cdp = new CDPBrowser(fixture.child);
  const pending = Array.from({ length: 16 }, () => cdp.request('Storage.getCookies'));
  await assert.rejects(cdp.request('Storage.getCookies'), BrowserSessionError);
  fixture.output.write(Buffer.alloc(1_048_577, 65));
  assert.equal((await Promise.allSettled(pending)).every(result => result.status === 'rejected'), true);
  await cdp.stop(); assert.deepEqual(fixture.signals, ['SIGTERM']);
  const stalled = fakeChrome(() => null), bounded = new CDPBrowser(stalled.child);
  await assert.rejects(bounded.request('Storage.getCookies', {}, { timeoutMs: 5 }), error => error.code === 'browser_command_timeout');
  await bounded.stop();
});

test('collector waits for a session, writes only projected cookies and can cancel a stalled browser', () => directory(async root => {
  const fixture = fakeChrome(command => command.method === 'Storage.getCookies' ? { result: { cookies: fixture.commands.filter(row => row.method === command.method).length > 1 ? [cookie()] : [] } } : { result: {} });
  const cdp = new CDPBrowser(fixture.child), output = join(root, 'cookies-yandex.json');
  try {
    await collectSession(cdp, { output, now: () => now, pollMs: 1 });
    assert.deepEqual(JSON.parse(readFileSync(output)), [{ name: 'Session_id', value: CANARY }]);
    assert.equal(fixture.commands.some(command => command.method === 'Target.createTarget'), false, 'collector itself never opens an external site');
  } finally { await cdp.stop(); }
  const abort = new AbortController(), never = new Promise(() => {}), absent = join(root, 'absent');
  const collection = collectSession({ request: () => never }, { output: absent, signal: abort.signal });
  abort.abort(); await assert.rejects(collection, BrowserSessionError);
  assert.equal(existsSync(absent), false);
}));

test('host guard refuses known/current production addresses and fails closed when DNS is unavailable', async () => {
  for (const address of ['194.87.254.249', '141.133.194.51', '::ffff:194.87.254.249', '::FFFF:c257:fef9', '0:0:0:0:0:ffff:c257:fef9']) {
    let lookedUp = false;
    await assert.rejects(assertNotProductionHost({ interfaces: () => ({ eth0: [{ address }] }), resolveAPI: async () => { lookedUp = true; return []; } }), error => error.code === 'production_host_refused');
    assert.equal(lookedUp, false);
  }
  const interfaces = () => ({ eth0: [{ address: '203.0.113.1' }] });
  await assert.rejects(assertNotProductionHost({ interfaces, resolveAPI: async () => [{ address: '203.0.113.1' }] }), error => error.code === 'production_host_refused');
  for (const resolveAPI of [async () => { throw Error(CANARY); }, async () => [], async () => [{ address: null }]])
    await assert.rejects(assertNotProductionHost({ interfaces, resolveAPI }), error => error.code === 'host_check_failed' && !error.message.includes(CANARY));
  await assertNotProductionHost({ interfaces, resolveAPI: async () => [{ address: '198.51.100.1' }] });
  await assert.rejects(assertNotProductionHost({ interfaces: () => ({ eth0: [{ address: '2001:db8::1' }] }),
    resolveAPI: async () => [{ address: '2001:0DB8:0000:0000:0000:0000:0000:0001' }] }), error => error.code === 'production_host_refused');
  await assert.rejects(assertNotProductionHost({ interfaces: () => ({ eth0: [{ address: '198.51.100.1' }] }),
    resolveAPI: async () => [{ address: '::ffff:c633:6401' }] }), error => error.code === 'production_host_refused');
});

test('host guard refuses empty, loopback-only and malformed address inventories before DNS', async () => {
  for (const inventory of [null, [], {}, { eth0: [] }, { eth0: undefined },
    { lo: [{ address: '127.0.0.1' }, { address: '::1' }] },
    { lo: [{ address: '0:0:0:0:0:0:0:1' }] }, { lo: [{ address: '::ffff:127.0.0.1' }] },
    { lo: [{ address: '203.0.113.1', internal: true }] },
    { eth0: [{ address: '0.0.0.0' }, { address: '::' }] },
    { eth0: [{ address: 'not-an-IP' }] }, { eth0: [{ address: '203.0.113.1' }, {}] },
  ]) {
    let lookedUp = false;
    await assert.rejects(assertNotProductionHost({ interfaces: () => inventory,
      resolveAPI: async () => { lookedUp = true; return [{ address: '198.51.100.1' }]; } }), error => error.code === 'host_check_failed');
    assert.equal(lookedUp, false);
  }
  await assert.rejects(assertNotProductionHost({ interfaces: () => { throw Error(CANARY); } }),
    error => error.code === 'host_check_failed' && !error.message.includes(CANARY));
});

test('root is refused before private paths, network checks or browser launch', () => directory(async root => {
  let touched = false;
  await assert.rejects(runBrowserSession({ chrome: '/bin/true', profile: join(root, 'new-profile'), output: join(root, 'new-output', 'cookies-yandex.json') }, {
    getuid: () => 0, hostCheck: async () => { touched = true; }, spawnProcess: () => { touched = true; },
  }), error => error.code === 'unprivileged_user_required');
  assert.equal(touched, false); assert.deepEqual(readdirSync(root), []);
}));

test('rootless runner uses authenticated local display, fixed URL, sandbox and anonymous pipes', { skip: process.getuid?.() === 0 ? 'Root cannot run the intentionally unprivileged runner' : false }, () => directory(async root => {
  const xauth = join(root, 'Xauthority'); writeFileSync(xauth, 'fixture', { mode: 0o600 });
  const profile = join(root, 'profile'), output = join(root, 'export', 'cookies-yandex.json');
  let invocation;
  const fixture = fakeChrome();
  const result = await runBrowserSession({ chrome: '/bin/true', profile, output }, {
    environment: { DISPLAY: ':99', XAUTHORITY: xauth, HOME: root, PATH: process.env.PATH, LINEA_TOKEN: CANARY, HTTPS_PROXY: CANARY },
    hostCheck: async () => {}, spawnProcess(binary, args, options) { invocation = { binary, args, options }; return fixture.child; },
  });
  assert.deepEqual(result, { saved: true });
  assert.equal(lstatSync(profile).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(root, 'export')).mode & 0o777, 0o700);
  assert.equal(lstatSync(output).mode & 0o777, 0o600);
  assert.deepEqual(invocation.options.stdio, ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.args.includes('--remote-debugging-pipe'), true);
  assert.equal(invocation.args.some(arg => /no-sandbox|remote-debugging-port|headless|ignore-certificate|proxy-server/.test(arg)), false);
  assert.equal(JSON.stringify(invocation.options.env).includes(CANARY), false);
  assert.deepEqual(fixture.commands[0].params, { url: 'https://telemost.yandex.ru/' });
  assert.deepEqual(fixture.commands.map(command => command.method), ['Target.createTarget', 'Storage.getCookies', 'Browser.close']);
}));

test('runner rejects remote or newline displays, shared Xauthority and existing paths before Chrome', { skip: process.getuid?.() === 0 ? 'Root cannot run the intentionally unprivileged runner' : false }, () => directory(async root => {
  const xauth = join(root, 'Xauthority'); writeFileSync(xauth, 'fixture', { mode: 0o600 });
  let launched = false;
  const options = { chrome: '/bin/true', profile: join(root, 'profile'), output: join(root, 'export', 'cookies-yandex.json') };
  const deps = environment => ({ environment, hostCheck: async () => {}, spawnProcess: () => { launched = true; } });
  for (const DISPLAY of [undefined, '', 'remote.example:0', ':99\n'])
    await assert.rejects(runBrowserSession(options, deps({ DISPLAY, XAUTHORITY: xauth })), error => error.code === 'authenticated_local_display_required');
  chmodSync(xauth, 0o644);
  await assert.rejects(runBrowserSession(options, deps({ DISPLAY: ':99', XAUTHORITY: xauth })), BrowserSessionError);
  chmodSync(xauth, 0o600); mkdirSync(options.profile, { mode: 0o700 });
  await assert.rejects(runBrowserSession(options, deps({ DISPLAY: ':99', XAUTHORITY: xauth })), BrowserSessionError);
  assert.equal(launched, false); assert.equal(existsSync(dirname(options.output)), false);
}));

test('CLI exposes no arbitrary URL or unsafe flags and never prints argument secrets', () => {
  const script = fileURLToPath(new URL('../stand/browser-session.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--url', CANARY, '--no-sandbox'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal((result.stdout + result.stderr).includes(CANARY), false);
  assert.equal(result.stderr.includes('Private browser session unavailable.'), true);
});
