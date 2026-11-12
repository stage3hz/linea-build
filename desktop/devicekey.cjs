// The key this computer's sessions are bound to (server: devicebind.js): ECDSA P-256.
//
// Windows with a TPM: the key is created inside the chip («Microsoft Platform Crypto Provider») and cannot be
// exported — a program that copies the app's files, or decrypts them as this user, gets nothing it can sign with on
// another machine. Windows has no API for that in Electron or Node, so the two operations (create, sign) are done by
// Windows PowerShell with the .NET CNG classes; that is one short process when the app starts and one every few
// minutes (the server's proof lasts ten).
// No TPM, or the chip refuses: an ordinary key in the app's vault (DPAPI). That is no stronger than the session
// token next to it, and the server is told so (kind «software»).
const { createPrivateKey, createPublicKey, createSign, generateKeyPairSync, verify } = require('node:crypto');
const { execFile } = require('node:child_process');
const path = require('node:path');

const KEY_NAME = 'INVIZENT-device-key-v1';
const RECORD = 'key';

// Arguments arrive in the environment, never in the command text. Output: one line of JSON.
const SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Core',
  '$name=$env:INVIZENT_KEY_NAME',
  "$provider=New-Object System.Security.Cryptography.CngProvider('Microsoft Platform Crypto Provider')",
  "if($env:INVIZENT_KEY_ACTION -eq 'create' -and -not [System.Security.Cryptography.CngKey]::Exists($name,$provider)){",
  '  $p=New-Object System.Security.Cryptography.CngKeyCreationParameters',
  '  $p.Provider=$provider',
  '  $p.KeyUsage=[System.Security.Cryptography.CngKeyUsages]::Signing',
  '  $p.ExportPolicy=[System.Security.Cryptography.CngExportPolicies]::None',
  '  $key=[System.Security.Cryptography.CngKey]::Create([System.Security.Cryptography.CngAlgorithm]::ECDsaP256,$name,$p)',
  "} elseif(-not [System.Security.Cryptography.CngKey]::Exists($name,$provider)){ [Console]::Out.Write('{\"missing\":true}'); exit 0",
  '} else { $key=[System.Security.Cryptography.CngKey]::Open($name,$provider) }',
  '$out=@{publicBlob=[Convert]::ToBase64String($key.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob))}',
  "if($env:INVIZENT_KEY_ACTION -eq 'sign'){",
  '  $ecdsa=New-Object System.Security.Cryptography.ECDsaCng($key)',
  '  $ecdsa.HashAlgorithm=[System.Security.Cryptography.CngAlgorithm]::Sha256',
  '  $out.signature=[Convert]::ToBase64String($ecdsa.SignData([Convert]::FromBase64String($env:INVIZENT_KEY_MESSAGE)))',
  '}',
  '[Console]::Out.Write(($out|ConvertTo-Json -Compress))',
].join('\n');

/** Windows PowerShell by its full path (never whatever `powershell` resolves to on PATH). */
function runPowerShell(action, messageBase64) {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const exe = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const env = { ...process.env, INVIZENT_KEY_NAME: KEY_NAME, INVIZENT_KEY_ACTION: action, INVIZENT_KEY_MESSAGE: messageBase64 || '' };
  return new Promise((resolve, reject) => {
    execFile(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', SCRIPT], { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024, env }, (error, stdout) => {
      if (error) { reject(new Error('TPM key operation failed')); return; }
      try { resolve(JSON.parse(String(stdout).trim())); } catch { reject(new Error('TPM key operation failed')); }
    });
  });
}

const base64url = bytes => Buffer.from(bytes).toString('base64url');
/** BCRYPT_ECCKEY_BLOB of a P-256 public key: magic «ECS1», cbKey = 32, X, Y → the point 04 ‖ X ‖ Y. */
function pointFromBlob(blobBase64) {
  const blob = Buffer.from(String(blobBase64 || ''), 'base64');
  if (blob.length !== 72 || blob.readUInt32LE(0) !== 0x31534345 || blob.readUInt32LE(4) !== 32) throw new Error('Unexpected TPM public key');
  return base64url(Buffer.concat([Buffer.from([4]), blob.subarray(8)]));
}
function publicKeyObject(point) {
  const raw = Buffer.from(point, 'base64url');
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('Unexpected public key');
  return createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: base64url(raw.subarray(1, 33)), y: base64url(raw.subarray(33)) } });
}
/** r ‖ s (64 bytes), as CNG signs. */
function rawSignature(signatureBase64) {
  const signature = Buffer.from(String(signatureBase64 || ''), 'base64');
  if (signature.length !== 64) throw new Error('Unexpected TPM signature');
  return signature;
}

/**
 * `vault`: () => Promise<{ get(name), commit(changes) }> — the app's encrypted store for this key's record.
 * `platform`, `run`: for tests.
 */
function createDeviceKey({ vault, platform = process.platform, run = runPowerShell }) {
  let record = null, queue = Promise.resolve();
  const serial = action => { const result = queue.then(action, action); queue = result.catch(() => {}); return result; };

  async function hardware() {
    const created = await run('create');
    const publicKey = pointFromBlob(created.publicBlob);
    // Proof that the chip really signs with this key, before a session is tied to it.
    const probe = Buffer.from('invizent-device-key-selftest');
    const signed = await run('sign', probe.toString('base64'));
    if (pointFromBlob(signed.publicBlob) !== publicKey || !verify('sha256', probe, { key: publicKeyObject(publicKey), dsaEncoding: 'ieee-p1363' }, rawSignature(signed.signature))) throw new Error('TPM key self-test failed');
    return { kind: 'hardware', publicKey };
  }
  function software() {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    return { kind: 'software', publicKey: base64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])), privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
  }
  const valid = value => value && typeof value === 'object' && (value.kind === 'hardware' || (value.kind === 'software' && typeof value.privateKey === 'string')) && typeof value.publicKey === 'string' && value.publicKey.length === 87;

  async function load() {
    if (record) return record;
    const store = await vault();
    const saved = await store.get(RECORD);
    if (valid(saved)) { record = saved; return record; }
    let made = null;
    if (platform === 'win32') { try { made = await hardware(); } catch { made = null; } }
    if (!made) made = software();
    await store.commit({ [RECORD]: made });
    record = made;
    return record;
  }

  return {
    /** { publicKey, kind }: the key is created on the first call and kept. */
    ensure: () => serial(async () => { const { publicKey, kind } = await load(); return { publicKey, kind }; }),
    /** ECDSA P-256 / SHA-256 over the message's UTF-8 bytes, base64url (DER, or r ‖ s from the TPM). */
    sign: message => serial(async () => {
      if (typeof message !== 'string' || message.length > 512 || !message.startsWith('invizent-device-')) throw new Error('Invalid message');
      const key = await load();
      const bytes = Buffer.from(message, 'utf8');
      if (key.kind === 'software') return createSign('sha256').update(bytes).sign(createPrivateKey({ key: Buffer.from(key.privateKey, 'base64'), format: 'der', type: 'pkcs8' })).toString('base64url');
      const signed = await run('sign', bytes.toString('base64'));
      // The chip's key is gone or was replaced (TPM cleared): this is no longer the key the session knows.
      if (signed.missing || pointFromBlob(signed.publicBlob) !== key.publicKey) throw new Error('TPM key changed');
      return base64url(rawSignature(signed.signature));
    }),
  };
}

module.exports = { createDeviceKey, pointFromBlob, KEY_NAME };
