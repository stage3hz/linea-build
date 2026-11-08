// Communities: access rules that the general integration test does not cover one by one —
// the «last message» leak of role-restricted channels, the voice-moderation probe, the role
// hierarchy, and what a closed community really restricts.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { PERM } from '../src/communities.js';

const PASSWORD = 'correct-horse-42';

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'linea-communities-test-'));
  const app = await buildApp({ dataDir, logger: false, authRateLimit: 1000 });
  await app.ready();
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return app;
}
const request = (app, method, url, account, payload) => app.inject({ method, url, headers: account ? { authorization: `Bearer ${account.token}` } : {}, ...(payload === undefined ? {} : { payload }) });
async function register(app, username) {
  const response = await request(app, 'POST', '/auth/register', null, { username, displayName: username, password: PASSWORD, recoveryWord: 'SilverHarborLantern', confirmationWord: 'AmberGardenPrism' });
  assert.equal(response.statusCode, 201, response.body);
  return response.json();
}
async function socketFor(t, app, account) {
  if (!app.server.listening) await app.listen({ host: '127.0.0.1', port: 0 });
  const socket = new WebSocket(`ws://127.0.0.1:${app.server.address().port}/ws`);
  const packets = [], listeners = new Set();
  socket.on('message', raw => { const packet = JSON.parse(raw.toString()); packets.push(packet); for (const listener of [...listeners]) listener(packet); });
  socket.on('error', () => {});
  t.after(() => { socket.terminate(); });
  const next = (predicate, { from = 0, timeout = 3000 } = {}) => {
    const existing = packets.slice(from).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(listener); reject(new Error(`Timed out waiting for WebSocket packet; received ${JSON.stringify(packets)}`)); }, timeout);
      const listener = packet => { if (!predicate(packet)) return; clearTimeout(timer); listeners.delete(listener); resolve(packet); };
      listeners.add(listener);
    });
  };
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'auth', token: account.token }));
  assert.equal((await next(packet => packet.type === 'ready')).userId, account.user.id);
  return { socket, packets, next };
}
/** A server with the owner and the given members (joined by the owner's link). */
async function serverWith(app, owner, members, options = {}) {
  const created = await request(app, 'POST', '/communities', owner, { kind: 'server', name: 'Клан', ...options });
  assert.equal(created.statusCode, 200, created.body);
  const server = created.json().community;
  const code = (await request(app, 'POST', `/communities/${server.id}/invites`, owner, {})).json().invite.code;
  for (const who of members) assert.equal((await request(app, 'POST', `/invites/${code}/accept`, who)).statusCode, 200);
  return { server, code };
}
const summaryOf = async (app, id, who) => (await request(app, 'GET', '/communities', who)).json().communities.find(item => item.id === id);
const detailOf = async (app, id, who) => (await request(app, 'GET', `/communities/${id}`, who)).json().community;

test('B11: the last message of a role-restricted channel never reaches members outside the role (list, detail, pushed event)', async t => {
  const app = await fixture(t);
  const owner = await register(app, 'b11_owner'), vet = await register(app, 'b11_vet'), bob = await register(app, 'b11_bob');
  const { server } = await serverWith(app, owner, [vet, bob]);
  const general = server.channels.find(c => c.kind === 'text');
  const role = (await request(app, 'POST', `/communities/${server.id}/roles`, owner, { name: 'Ветераны', color: '#ff0000', perms: PERM.SEND | PERM.VOICE })).json().role;
  assert.equal((await request(app, 'PUT', `/communities/${server.id}/members/${vet.user.id}/roles`, owner, { roleIds: [role.id] })).statusCode, 200);
  const hq = (await request(app, 'POST', `/communities/${server.id}/channels`, owner, { kind: 'text', name: 'штаб', roleIds: [role.id] })).json().channel;
  assert.equal((await request(app, 'POST', `/communities/${server.id}/channels/${general.id}/messages`, bob, { text: 'всем привет' })).statusCode, 200);
  const bobSocket = await socketFor(t, app, bob), vetSocket = await socketFor(t, app, vet);
  const seen = bobSocket.packets.length, seenVet = vetSocket.packets.length;
  assert.equal((await request(app, 'POST', `/communities/${server.id}/channels/${hq.id}/messages`, owner, { text: 'СЕКРЕТ: рейд в пятницу' })).statusCode, 200);

  // Bob, outside the role: the public channel's text everywhere, never the secret.
  assert.equal((await summaryOf(app, server.id, bob)).lastMessage.text, 'всем привет');
  assert.equal((await detailOf(app, server.id, bob)).lastMessage.text, 'всем привет');
  // Those with access, and the owner, do see it.
  assert.equal((await summaryOf(app, server.id, vet)).lastMessage.text, 'СЕКРЕТ: рейд в пятницу');
  assert.equal((await detailOf(app, server.id, owner)).lastMessage.text, 'СЕКРЕТ: рейд в пятницу');
  // The pushed «community» refresh (here: after a settings change) is built per viewer too.
  assert.equal((await request(app, 'PATCH', `/communities/${server.id}`, owner, { description: 'обновлено' })).statusCode, 200);
  const pushedToBob = await bobSocket.next(p => p.type === 'community' && p.community.id === server.id, { from: seen });
  assert.equal(pushedToBob.community.lastMessage.text, 'всем привет');
  const pushedToVet = await vetSocket.next(p => p.type === 'community' && p.community.id === server.id, { from: seenVet });
  assert.equal(pushedToVet.community.lastMessage.text, 'СЕКРЕТ: рейд в пятницу');
  assert.ok(!JSON.stringify(bobSocket.packets).includes('СЕКРЕТ'), 'nothing pushed to Bob carries the secret text');
  // Only secret messages so far in a fresh server: a member without the role sees no last message at all.
  const other = (await request(app, 'POST', '/communities', owner, { kind: 'server', name: 'Тихий' })).json().community;
  const hqOnly = (await request(app, 'POST', `/communities/${other.id}/channels`, owner, { kind: 'text', name: 'штаб', roleIds: [other.roles.find(r => !r.isDefault).id] })).json().channel;
  const otherCode = (await request(app, 'POST', `/communities/${other.id}/invites`, owner, {})).json().invite.code;
  assert.equal((await request(app, 'POST', `/invites/${otherCode}/accept`, bob)).statusCode, 200);
  assert.equal((await request(app, 'POST', `/communities/${other.id}/channels/${hqOnly.id}/messages`, owner, { text: 'тайна' })).statusCode, 200);
  assert.equal((await summaryOf(app, other.id, bob)).lastMessage, null);
  assert.equal((await summaryOf(app, other.id, owner)).lastMessage.text, 'тайна');
});

test('B33: voice moderation needs membership and a right; an empty body is a 400, not a membership probe', async t => {
  const app = await fixture(t);
  const owner = await register(app, 'b33_owner'), bob = await register(app, 'b33_bob'), carl = await register(app, 'b33_carl');
  const { server } = await serverWith(app, owner, [bob], { });
  assert.equal((await request(app, 'PATCH', `/communities/${server.id}`, owner, { closed: true })).statusCode, 200);
  const voice = (who, target, body) => request(app, 'PUT', `/communities/${server.id}/members/${target}/voice`, who, body);
  // An outsider gets the same 404 for a member, a non-member and the owner, with any body.
  for (const target of [bob.user.id, carl.user.id, owner.user.id]) {
    assert.equal((await voice(carl, target, {})).statusCode, 404);
    assert.equal((await voice(carl, target, { muted: true })).statusCode, 404);
  }
  // A member without the right: an empty body is refused first, a real one lacks the right.
  assert.equal((await voice(bob, owner.user.id, {})).statusCode, 400);
  assert.equal((await voice(bob, bob.user.id, { muted: true })).statusCode, 403);
  // The owner, properly: still no empty bodies, and the real moderation works.
  assert.equal((await voice(owner, bob.user.id, {})).statusCode, 400);
  const muted = await voice(owner, bob.user.id, { muted: true });
  assert.equal(muted.statusCode, 200, muted.body);
  assert.deepEqual(muted.json(), { ok: true, serverMuted: true, serverDeafened: false });
  assert.equal((await voice(owner, carl.user.id, { muted: true })).statusCode, 404);
});

test('B40: «manage roles» cannot grant rights one does not hold, touch roles above one\'s own, or change one\'s own roles', async t => {
  const app = await fixture(t);
  const owner = await register(app, 'b40_owner'), bob = await register(app, 'b40_bob'), carl = await register(app, 'b40_carl');
  const { server } = await serverWith(app, owner, [bob, carl]);
  const moderator = server.roles.find(r => r.name === 'Модератор');
  const path = `/communities/${server.id}`;
  // Bob: a role with MANAGE_ROLES | SEND | VOICE only, positioned under the moderator.
  const manager = (await request(app, 'POST', `${path}/roles`, owner, { name: 'Кадровик', color: '#00ff00', perms: PERM.MANAGE_ROLES | PERM.SEND | PERM.VOICE })).json().role;
  assert.equal((await request(app, 'PUT', `${path}/members/${bob.user.id}/roles`, owner, { roleIds: [manager.id] })).statusCode, 200);
  assert.ok(manager.position > moderator.position, 'the owner\'s new role goes on top');
  const senior = (await request(app, 'POST', `${path}/roles`, owner, { name: 'Старший', color: '#0000ff', perms: PERM.SEND })).json().role;
  assert.ok(senior.position > manager.position);
  // A role with more rights than Bob holds: refused. Only his own rights: allowed.
  const ALL_BUT_ADMIN = Object.values(PERM).reduce((sum, bit) => sum | bit, 0) & ~PERM.ADMIN;
  const greedy = await request(app, 'POST', `${path}/roles`, bob, { name: 'Всё', perms: ALL_BUT_ADMIN });
  assert.equal(greedy.statusCode, 403, greedy.body);
  assert.equal((await request(app, 'POST', `${path}/roles`, bob, { name: 'Админ', perms: PERM.ADMIN })).statusCode, 403);
  assert.equal((await request(app, 'POST', `${path}/roles`, bob, { name: 'Кикер', perms: PERM.KICK })).statusCode, 403);
  const helper = await request(app, 'POST', `${path}/roles`, bob, { name: 'Помощник', perms: PERM.SEND | PERM.VOICE });
  assert.equal(helper.statusCode, 200, helper.body);
  assert.ok(helper.json().role.position < manager.position, 'a non-owner\'s new role sits below their own');
  // Bob may not change his own roles, nor escalate the role he created afterwards.
  assert.equal((await request(app, 'PUT', `${path}/members/${bob.user.id}/roles`, bob, { roleIds: [manager.id, helper.json().role.id] })).statusCode, 403);
  assert.equal((await request(app, 'PATCH', `${path}/roles/${helper.json().role.id}`, bob, { perms: PERM.SEND | PERM.VOICE | PERM.KICK })).statusCode, 403);
  assert.equal((await request(app, 'PATCH', `${path}/roles/${helper.json().role.id}`, bob, { name: 'Друг', perms: PERM.SEND })).statusCode, 200);
  // Roles at or above his own are out of reach to edit, delete or hand out; a role below is fine —
  // but even there only a rename, never a right he does not hold (the moderator's KICK stays).
  assert.equal((await request(app, 'PATCH', `${path}/roles/${senior.id}`, bob, { name: 'x' })).statusCode, 403);
  assert.equal((await request(app, 'PATCH', `${path}/roles/${manager.id}`, bob, { name: 'x' })).statusCode, 403);
  assert.equal((await request(app, 'DELETE', `${path}/roles/${senior.id}`, bob)).statusCode, 403);
  assert.equal((await request(app, 'PATCH', `${path}/roles/${moderator.id}`, bob, { perms: moderator.perms & ~PERM.KICK })).statusCode, 403);
  assert.equal((await request(app, 'PATCH', `${path}/roles/${moderator.id}`, bob, { name: 'Модер' })).statusCode, 200);
  assert.equal((await request(app, 'PUT', `${path}/members/${carl.user.id}/roles`, bob, { roleIds: [senior.id] })).statusCode, 403);
  assert.equal((await request(app, 'PUT', `${path}/members/${carl.user.id}/roles`, bob, { roleIds: [manager.id] })).statusCode, 403);
  assert.deepEqual((await request(app, 'PUT', `${path}/members/${carl.user.id}/roles`, bob, { roleIds: [helper.json().role.id] })).json().roleIds, [helper.json().role.id]);
  // A target ranked the same or higher: untouchable. Still no kick/rename for Bob: his rights did not grow.
  assert.equal((await request(app, 'PUT', `${path}/members/${carl.user.id}/roles`, owner, { roleIds: [senior.id] })).statusCode, 200);
  assert.equal((await request(app, 'PUT', `${path}/members/${carl.user.id}/roles`, bob, { roleIds: [] })).statusCode, 403);
  assert.equal((await request(app, 'DELETE', `${path}/members/${carl.user.id}`, bob)).statusCode, 403);
  assert.equal((await request(app, 'PATCH', path, bob, { name: 'Захвачено' })).statusCode, 403);
  assert.equal((await detailOf(app, server.id, bob)).perms, PERM.MANAGE_ROLES | PERM.SEND | PERM.VOICE | PERM.INVITE);
  // The owner stays free: any rights, any role, and even the administrator role.
  assert.equal((await request(app, 'POST', `${path}/roles`, owner, { name: 'Админ', perms: PERM.ADMIN })).statusCode, 200);
  assert.equal((await request(app, 'DELETE', `${path}/roles/${helper.json().role.id}`, owner)).statusCode, 200);
});

test('B42: a closed community: only the owner and community managers invite, other links die, and reopening revives them', async t => {
  const app = await fixture(t);
  const owner = await register(app, 'b42_owner'), dave = await register(app, 'b42_dave'), manager = await register(app, 'b42_mgr'), erin = await register(app, 'b42_erin'), fay = await register(app, 'b42_fay');
  const { server } = await serverWith(app, owner, [dave, manager]);
  const path = `/communities/${server.id}`;
  const role = (await request(app, 'POST', `${path}/roles`, owner, { name: 'Управляющий', perms: PERM.MANAGE_COMMUNITY | PERM.SEND })).json().role;
  assert.equal((await request(app, 'PUT', `${path}/members/${manager.user.id}/roles`, owner, { roleIds: [role.id] })).statusCode, 200);
  // Open: a plain member may invite (the default role carries INVITE).
  const daveLink = await request(app, 'POST', `${path}/invites`, dave, {});
  assert.equal(daveLink.statusCode, 200, daveLink.body);
  assert.ok((await summaryOf(app, server.id, dave)).perms & PERM.INVITE);
  // Closed: the right disappears from his perms, new links are refused, and his old link is dead
  // for the preview, the landing page and the accept.
  assert.equal((await request(app, 'PATCH', path, owner, { closed: true })).statusCode, 200);
  assert.equal((await summaryOf(app, server.id, dave)).perms & PERM.INVITE, 0);
  assert.equal((await request(app, 'POST', `${path}/invites`, dave, {})).statusCode, 403);
  assert.equal((await request(app, 'GET', `/invites/${daveLink.json().invite.code}`, erin)).statusCode, 404);
  assert.match((await app.inject({ method: 'GET', url: `/i/${daveLink.json().invite.code}` })).body, /недействительно/);
  assert.equal((await request(app, 'POST', `/invites/${daveLink.json().invite.code}/accept`, erin)).statusCode, 404);
  assert.equal((await request(app, 'GET', path, erin)).statusCode, 404);
  // The owner and whoever manages the community still invite, and those links work.
  const ownerLink = (await request(app, 'POST', `${path}/invites`, owner, {})).json().invite.code;
  const managerLink = await request(app, 'POST', `${path}/invites`, manager, {});
  assert.equal(managerLink.statusCode, 200, managerLink.body);
  assert.ok((await summaryOf(app, server.id, manager)).perms & PERM.INVITE);
  assert.equal((await request(app, 'GET', `/invites/${ownerLink}`, erin)).json().community.closed, true);
  assert.equal((await request(app, 'POST', `/invites/${ownerLink}/accept`, erin)).statusCode, 200);
  assert.equal((await request(app, 'POST', `/invites/${managerLink.json().invite.code}/accept`, fay)).statusCode, 200);
  assert.equal((await detailOf(app, server.id, erin)).isMember, true);
  // The manager loses the role: the link they made stops working too.
  assert.equal((await request(app, 'PUT', `${path}/members/${manager.user.id}/roles`, owner, { roleIds: [] })).statusCode, 200);
  const late = await register(app, 'b42_late');
  assert.equal((await request(app, 'POST', `/invites/${managerLink.json().invite.code}/accept`, late)).statusCode, 404);
  // Reopened: Dave's link is valid again.
  assert.equal((await request(app, 'PATCH', path, owner, { closed: false })).statusCode, 200);
  assert.equal((await request(app, 'POST', `/invites/${daveLink.json().invite.code}/accept`, late)).statusCode, 200);
});

test('B41: a channel send with the same clientKey twice stores one row and answers with the same message', async t => {
  const app = await fixture(t);
  const owner = await register(app, 'b41_owner'), bob = await register(app, 'b41_bob');
  const { server } = await serverWith(app, owner, [bob]);
  const general = server.channels.find(c => c.kind === 'text');
  const url = `/communities/${server.id}/channels/${general.id}/messages`;
  const first = await request(app, 'POST', url, bob, { text: 'привет', clientKey: 'k1' });
  assert.equal(first.statusCode, 200, first.body);
  const again = await request(app, 'POST', url, bob, { text: 'привет', clientKey: 'k1' });
  assert.equal(again.statusCode, 200, again.body);
  assert.deepEqual(again.json().message, first.json().message);
  // A new key is a new message; the same key from another sender is their own message.
  assert.equal((await request(app, 'POST', url, bob, { text: 'ещё', clientKey: 'k2' })).statusCode, 200);
  const ownerCopy = await request(app, 'POST', url, owner, { text: 'моё', clientKey: 'k1' });
  assert.equal(ownerCopy.statusCode, 200, ownerCopy.body);
  assert.notEqual(ownerCopy.json().message.id, first.json().message.id);
  const listed = (await request(app, 'GET', url, bob)).json().messages;
  assert.deepEqual(listed.map(m => m.text), ['привет', 'ещё', 'моё']);
  // The same key in another channel is refused; a malformed key is a 400; no key still works.
  const other = (await request(app, 'POST', `/communities/${server.id}/channels`, owner, { kind: 'text', name: 'второй' })).json().channel;
  assert.equal((await request(app, 'POST', `/communities/${server.id}/channels/${other.id}/messages`, bob, { text: 'не туда', clientKey: 'k1' })).statusCode, 409);
  assert.equal((await request(app, 'POST', url, bob, { text: 'x', clientKey: 'a'.repeat(65) })).statusCode, 400);
  assert.equal((await request(app, 'POST', url, bob, { text: 'x', clientKey: 'пробел нет' })).statusCode, 400);
  assert.equal((await request(app, 'POST', url, bob, { text: 'без ключа' })).statusCode, 200);
  assert.equal((await request(app, 'POST', url, bob, { text: 'без ключа' })).statusCode, 200);
  assert.equal((await request(app, 'GET', url, bob)).json().messages.length, 5);
});
