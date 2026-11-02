// Two INVIZENT desktop instances (tester ↔ friend) exchange encrypted messages through the local stand.
const fs = require('fs');
const STAND = process.env.STAND || '/tmp/invizent-stand';
const { launch } = require('./electron-walk.cjs');
const accounts = JSON.parse(fs.readFileSync(STAND + '/test-accounts.json', 'utf8'));
const out = STAND + '/shots';
const tag = process.argv[2] || 'e2ee';

async function signIn(who) {
  const s = await launch(who), { page } = s, acc = accounts[who];
  await page.setViewportSize({ width: 1100, height: 760 }).catch(() => {});
  await page.waitForTimeout(3500);
  const type = async (ph, text) => { const el = page.getByPlaceholder(ph).first(); if (!(await el.count())) return false; await el.click(); await page.keyboard.type(text, { delay: 4 }); return true; };
  const tap = text => page.getByText(text, { exact: true }).last().click({ timeout: 8000 });
  if (await type('например, vladik', acc.username)) {
    await tap('Продолжить'); await type('Твой пароль', acc.password); await tap('Продолжить');
    await type('Твоё слово для входа', acc.confirmationWord); await tap('Войти в Инвиз');
  }
  await page.waitForTimeout(6000);
  s.shot = async name => { await page.waitForTimeout(1200); await page.screenshot({ path: `${out}/${tag}-${who}-${name}.png` }); console.log('shot', who, name); };
  s.tap = tap;
  return s;
}

(async () => {
  const a = await signIn('a');
  const b = await signIn('b');
  const stamp = new Date().toISOString().slice(11, 19);
  const first = `Привет из ПК ${stamp}`, reply = `Ответ получен ${stamp}`;
  // tester opens the chat with friend and sends.
  await a.tap(accounts.b.displayName || 'Друг').catch(async () => a.tap('Друг'));
  await a.page.waitForTimeout(2500); await a.shot('chat-open');
  const composer = a.page.getByPlaceholder(/Сообщение/).first();
  await composer.click(); await a.page.keyboard.type(first, { delay: 6 }); await a.page.keyboard.press('Enter');
  await a.shot('sent');
  // First contact: the app asks to check device codes, then delivers on its own.
  const approve = async (s, label) => {
    const btn = s.page.getByText('Сверить коды', { exact: true }).last();
    if (!(await btn.count())) { console.log(label, ': no «Сверить коды» notice'); return false; }
    await btn.click(); await s.page.waitForTimeout(2500); await s.shot('trust-sheet');
    await s.page.getByRole('checkbox').last().click();
    await s.page.getByText('Подтвердить проверенные ключи', { exact: true }).last().click();
    await s.page.waitForTimeout(4000); await s.shot('approved'); return true;
  };
  await approve(a, 'tester');
  // friend should see it.
  await b.page.waitForTimeout(5000); await b.shot('list');
  const chatWithA = b.page.getByText(accounts.a.displayName || 'Тестер', { exact: true }).first();
  await chatWithA.click({ timeout: 10000 }).catch(e => console.log('b: no chat with a:', e.message.slice(0, 120)));
  await b.page.waitForTimeout(3500); await b.shot('chat');
  let seen = await b.page.getByText(first).count();
  if (!seen) { await approve(b, 'friend'); await b.page.waitForTimeout(3000); seen = await b.page.getByText(first).count(); await b.shot('chat-after-approve'); }
  console.log('friend sees first message:', seen > 0);
  if (seen) {
    const c2 = b.page.getByPlaceholder(/Сообщение/).first();
    await c2.click(); await b.page.keyboard.type(reply, { delay: 6 }); await b.page.keyboard.press('Enter');
    await b.shot('replied');
    await a.page.waitForTimeout(5000); await a.shot('got-reply');
    console.log('tester sees reply:', (await a.page.getByText(reply).count()) > 0);
  }
  console.log('logs a:\n' + a.logs.filter(l => !/useNativeDriver|expo-notifications/.test(l)).slice(0, 25).join('\n'));
  console.log('logs b:\n' + b.logs.filter(l => !/useNativeDriver|expo-notifications/.test(l)).slice(0, 25).join('\n'));
  await a.app.close(); await b.app.close();
})().catch(e => { console.error('FATAL', e.message.slice(0, 500)); process.exit(1); });
