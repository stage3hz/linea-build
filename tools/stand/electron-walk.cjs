// Launches the real INVIZENT desktop app (Electron) against the local test stand
// and walks it as one account. Usage: node electron-walk.cjs <a|b> <tag>
const { _electron: electron } = require('playwright');
const fs = require('fs');
const STAND = process.env.STAND || '/tmp/invizent-stand';
const path = require('path');
const who = process.argv[2] || 'a', tag = process.argv[3] || who;
const acc = JSON.parse(fs.readFileSync(STAND + '/test-accounts.json', 'utf8'))[who];
const out = STAND + '/shots'; fs.mkdirSync(out, { recursive: true });
const desktop = require('path').resolve(__dirname, '../../desktop');

async function launch(profile) {
  const env = { ...process.env, XDG_CONFIG_HOME: `${STAND}/profile-${profile}`, NODE_EXTRA_CA_CERTS: STAND + '/ca.crt', NO_PROXY: '*', no_proxy: '*' };
  delete env.HTTPS_PROXY; delete env.HTTP_PROXY; delete env.https_proxy; delete env.http_proxy; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: path.join(desktop, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', '--no-proxy-server', '--password-store=gnome-libsecret', desktop], cwd: desktop, env, timeout: 60000 });
  const page = await app.firstWindow();
  const logs = [];
  page.on('pageerror', e => logs.push('pageerror: ' + e.message.slice(0, 300)));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type() + ': ' + m.text().slice(0, 300)); });
  app.process().stderr?.on('data', d => { const s = String(d); if (/error/i.test(s)) logs.push('main: ' + s.slice(0, 300)); });
  return { app, page, logs };
}
module.exports = { launch, acc };

if (require.main === module) (async () => {
  const { app, page, logs } = await launch(who);
  const shot = async name => { await page.waitForTimeout(1500); await page.screenshot({ path: `${out}/${tag}-${name}.png` }); console.log('shot', name); };
  await page.setViewportSize({ width: 1200, height: 800 }).catch(() => {});
  await page.waitForTimeout(4000);
  await shot('start');
  const typeInto = async (ph, text) => { const el = page.getByPlaceholder(ph).first(); await el.click(); await page.keyboard.type(text, { delay: 5 }); };
  const tap = async text => page.getByText(text, { exact: true }).last().click({ timeout: 8000 });
  try {
    await typeInto('например, vladik', acc.username); await tap('Продолжить');
    await typeInto('Твой пароль', acc.password); await tap('Продолжить');
    await typeInto('Твоё слово для входа', acc.confirmationWord); await tap('Войти в Инвиз');
    await page.waitForTimeout(6000); await shot('signed-in');
  } catch (e) { console.log('login step failed:', e.message.slice(0, 200)); await shot('login-fail'); }
  console.log('logs:\n' + logs.slice(0, 40).join('\n'));
  await app.close();
})().catch(e => { console.error('FATAL', e.message.slice(0, 400)); process.exit(1); });
