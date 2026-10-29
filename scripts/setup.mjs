import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (Number(process.versions.node.split('.')[0]) !== 24) {
  console.error('Для этого проекта используйте Node.js 24 LTS. Текущая версия: ' + process.version);
  process.exit(1);
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
for (const name of ['server', 'mobile']) {
  console.log('\nУстановка: ' + name);
  const result = spawnSync(npm, ['ci', '--no-fund'], { cwd: resolve(root, name), stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status || 1);
}
const envPath = resolve(root, 'mobile/.env.local');
if (!existsSync(envPath)) {
  writeFileSync(envPath, '# Укажите собственный HTTPS-сервер либо выберите его в приложении.\nEXPO_PUBLIC_API_URL=\nEXPO_PUBLIC_ALLOW_LOCAL_HTTP=0\n');
  console.log('\nУкажите собственный HTTPS-сервер в mobile/.env.local или на экране подключения.');
}
console.log('\nГотово. Сервер: npm run server.\nКлиенту нужна собственная нативная сборка: Expo Go не содержит libsignal и SQLCipher.\nДля установленного preview APK Metro не нужен. Инструкции — docs/BUILD.md.');
