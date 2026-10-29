#!/usr/bin/env node
// Prepares a user-owned copy of Linea 0.5.0. Does not log in, build, or read env.
import { readFile, writeFile, lstat, realpath, mkdir, rename, unlink, open } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const BASELINE = {
  app: '0c514d669eba235570ca5d62a598db6da4c1d8ab6819f6b0f8657d530e0b20d3',
  eas: '067a38734aa7fc0e4aaed23d7525071b82a2857f0f26c5cf72d8dd6f0a36afff',
};
const DIRECTORY = '.linea-ios-cloud-setup';
const HEADER = '// Linea iOS cloud setup v1: ';
const PERMISSIONS = [
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.ACCESS_MEDIA_LOCATION',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.QUERY_ALL_PACKAGES',
  'android.permission.PACKAGE_USAGE_STATS',
  'android.permission.MANAGE_EXTERNAL_STORAGE',
  'android.permission.READ_CONTACTS',
  'android.permission.WRITE_CONTACTS',
  'android.permission.READ_CALENDAR',
  'android.permission.WRITE_CALENDAR',
];
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };

function optionsFrom(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Invalid setup options.');
  if (Object.keys(input).some(key => !['projectId', 'owner', 'bundleId', 'appVersion'].includes(key))) fail('Unknown setup option.');
  const output = {};
  if (input.projectId !== undefined) {
    if (typeof input.projectId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.projectId)) fail('--project-id must be a real EAS project UUID; this tool cannot verify its ownership.');
    output.projectId = input.projectId;
  }
  if (input.owner !== undefined) {
    if (typeof input.owner !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(input.owner)) fail('--owner must be an Expo account or organization name, without @ or a URL.');
    output.owner = input.owner;
  }
  if (input.bundleId !== undefined) {
    if (typeof input.bundleId !== 'string' || input.bundleId.length > 255 || !/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/i.test(input.bundleId)) fail('--bundle-id must be an explicit reverse-DNS iOS identifier, without wildcards.');
    output.bundleId = input.bundleId;
  }
  if (input.appVersion !== undefined) {
    if (typeof input.appVersion !== 'string' || input.appVersion.length > 64 || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(input.appVersion)) fail('--app-version must be a release semver MAJOR.MINOR.PATCH; iOS prerelease suffixes are not supported here.');
    output.appVersion = input.appVersion;
  }
  return output;
}

function argumentsFrom(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return null;
  let target;
  const values = {};
  const names = { '--project-id': 'projectId', '--owner': 'owner', '--bundle-id': 'bundleId', '--app-version': 'appVersion' };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (names[value]) {
      const key = names[value];
      if (values[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) fail(`Missing or repeated value for ${value}.`);
      values[key] = argv[++i];
    } else if (value.startsWith('-') || target) fail(`Unexpected argument: ${value}`);
    else target = value;
  }
  if (!target) fail('Pass the path to an unpacked mobile directory from Linea 0.5.0.');
  return { target: resolve(target), values: optionsFrom(values) };
}

async function regularFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) fail(`Expected a regular configuration file: ${path}`);
  return readFile(path, 'utf8');
}

function replaceOnce(source, original, replacement) {
  if (source.split(original).length !== 2) fail('Baseline configuration shape is unexpected. No file was overwritten.');
  return source.replace(original, replacement);
}

function generatedConfig(baseline, options) {
  let text = replaceOnce(baseline,
    "['expo-build-properties', { android: { usesCleartextTraffic: allowDevelopmentHttp } }],",
    "['expo-build-properties', { android: { usesCleartextTraffic: allowDevelopmentHttp }, ios: { useFrameworks: 'static' } }],\n      './.linea-ios-cloud-setup/withLocalPrivacy.cjs',");
  const blocked = "blockedPermissions: ['android.permission.RECORD_AUDIO', 'android.permission.CAMERA','android.permission.ACCESS_MEDIA_LOCATION','android.permission.WRITE_EXTERNAL_STORAGE','android.permission.READ_MEDIA_AUDIO'],";
  const all = [...new Set(['android.permission.RECORD_AUDIO', 'android.permission.CAMERA', 'android.permission.ACCESS_MEDIA_LOCATION', 'android.permission.WRITE_EXTERNAL_STORAGE', 'android.permission.READ_MEDIA_AUDIO', ...PERMISSIONS])];
  text = replaceOnce(text, blocked, `blockedPermissions: ${JSON.stringify(all)},`);
  let identity = '';
  if (options.owner) identity += `    owner: ${JSON.stringify(options.owner)},\n`;
  if (options.projectId) identity += `    extra: { eas: { projectId: ${JSON.stringify(options.projectId)} } },\n`;
  if (identity) text = replaceOnce(text, "    slug: 'linea-messenger',\n", "    slug: 'linea-messenger',\n" + identity);
  if (options.bundleId) text = replaceOnce(text,
    "bundleIdentifier: development ? 'com.linea.messenger.preview' : 'com.linea.messenger',",
    `bundleIdentifier: ${JSON.stringify(options.bundleId)},`);
  if (options.appVersion) text = replaceOnce(text, "    version: '0.5.0',", `    version: ${JSON.stringify(options.appVersion)},`);
  return HEADER + JSON.stringify(options) + '\n' + text;
}

async function backup(path, contents) {
  try {
    const previous = await regularFile(path);
    if (previous !== contents) fail(`Existing backup differs; refusing to overwrite it: ${path}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(path, contents, { flag: 'wx', mode: 0o600 });
  }
}

async function atomicReplace(path, contents, expected) {
  const temporary = join(dirname(path), `.linea-ios-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o644 });
    if (await regularFile(path) !== expected) fail('app.config.js changed during preparation; refusing to overwrite it.');
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function prepare(args) {
  const target = await realpath(args.target);
  const appPath = join(target, 'app.config.js');
  const easPath = join(target, 'eas.json');
  const backupDirectory = join(target, DIRECTORY);
  const pluginPath = join(backupDirectory, 'withLocalPrivacy.cjs');
  const pluginSource = await regularFile(join(dirname(fileURLToPath(import.meta.url)), 'withLocalPrivacy.cjs'));
  const packageJson = JSON.parse(await regularFile(join(target, 'package.json')));
  if (packageJson.name !== 'linea-mobile') fail('This kit expects the linea-mobile package.');
  const current = await regularFile(appPath);
  const eas = await regularFile(easPath);
  const initialized = current.startsWith(HEADER);
  let baseline = current;
  let previous = {};
  if (initialized) {
    const directory = await lstat(backupDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) fail('Invalid backup directory.');
    baseline = await regularFile(join(backupDirectory, 'app.config.original.js'));
    const originalEas = await regularFile(join(backupDirectory, 'eas.original.json'));
    if (sha(baseline) !== BASELINE.app || sha(originalEas) !== BASELINE.eas) fail('Original backup checksum mismatch.');
    previous = optionsFrom(JSON.parse(current.slice(HEADER.length, current.indexOf('\n'))));
    if (current !== generatedConfig(baseline, previous)) fail('app.config.js contains changes outside this helper. They were preserved; use a separate baseline copy or review the changes manually.');
    if (await regularFile(pluginPath) !== pluginSource) fail('Privacy plugin was modified or belongs to another kit version. It was preserved.');
  } else {
    if (sha(current) !== BASELINE.app || sha(eas) !== BASELINE.eas) fail('Baseline app.config.js/eas.json checksum mismatch. Use an untouched copy of the supplied 0.5.0 source; no configuration was overwritten.');
  }
  const options = optionsFrom({ ...previous, ...args.values });
  if (typeof packageJson.version !== 'string' || !['0.5.0', previous.appVersion, options.appVersion].includes(packageJson.version)) fail('package.json version does not match the baseline or the recorded/requested app version. The helper never edits package.json or its lockfile.');
  const output = generatedConfig(baseline, options);
  if (initialized && output === current) return summary('unchanged', target, output, eas, options);
  const lockPath = join(target, '.linea-ios-cloud-setup.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
    if (await regularFile(appPath) !== current || await regularFile(easPath) !== eas) fail('Configuration changed while preparing. No configuration was overwritten.');
    try { await mkdir(backupDirectory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const directory = await lstat(backupDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) fail('Backup path is not an ordinary directory.');
    await backup(join(backupDirectory, 'app.config.original.js'), baseline);
    if (!initialized) await backup(join(backupDirectory, 'eas.original.json'), eas);
    await backup(pluginPath, pluginSource);
    await atomicReplace(appPath, output, current);
    return summary(initialized ? 'updated' : 'prepared', target, output, eas, options);
  } finally {
    if (lock) { await lock.close(); await unlink(lockPath); }
  }
}

function summary(status, target, app, eas, options) {
  return { status, target, baselineVersion: '0.5.0', appConfigSha256: sha(app), easSha256: sha(eas), easPreserved: true,
    easChangedSinceBaseline: sha(eas) !== BASELINE.eas, backupDirectory: join(target, DIRECTORY), publicConfiguration: options,
    effects: ['ios.useFrameworks=static', 'Android location/overlay/application-discovery/broad-storage/contacts/calendar permissions blocked for future builds', 'finalized iOS privacy checks'],
    cloudBuildStarted: false, accountsConnected: false };
}

try {
  const args = argumentsFrom(process.argv.slice(2));
  if (!args) console.log('Usage: node prepare-ios.mjs /path/to/mobile [--project-id UUID] [--owner EXPO_NAME] [--bundle-id IOS_ID] [--app-version MAJOR.MINOR.PATCH]\nOnly public identifiers/settings are accepted. No login, dependency installation, signing, or build is performed. package.json and lockfiles are never edited.');
  else console.log(JSON.stringify(await prepare(args), null, 2));
} catch (error) {
  console.error(JSON.stringify({ error: error.code === 'EEXIST' ? 'Another preparation is running, or its lock remains. Inspect the lock before removing it.' : error.message }));
  process.exitCode = 1;
}
