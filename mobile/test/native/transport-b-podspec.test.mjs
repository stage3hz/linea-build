// Run explicitly on the macOS native runner after staging the real xcframework
// and shared Swift source. A missing CocoaPods or real artifact is a failure.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = fileURLToPath(new URL('../../modules/linea-transport-b/ios/', import.meta.url));
const filename = 'LineaTransportB.podspec';
const required = ['Frameworks/Mobile.xcframework/Info.plist', 'Generated/StageBProofJoiner.swift', 'Generated/StageBJoinParameters.swift'];

function fixture(withArtifacts, run) {
  const root = mkdtempSync(join(tmpdir(), 'invizent-podspec-'));
  try {
    copyFileSync(join(source, filename), join(root, filename));
    if (withArtifacts) {
      for (const relative of required) assert.ok(existsSync(join(source, relative)), `Prepare real artifact: ${relative}`);
      for (const directory of ['Frameworks', 'Generated']) symlinkSync(join(source, directory), join(root, directory));
    }
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function environment(mode) {
  const env = { ...process.env };
  delete env.INVIZENT_TRANSPORT_B;
  if (mode !== undefined) env.INVIZENT_TRANSPORT_B = mode;
  return env;
}
function read(root, mode) {
  return JSON.parse(execFileSync('pod', ['ipc', 'spec', join(root, filename), '--no-ansi'], {
    env: environment(mode), encoding: 'utf8', timeout: 60_000,
  }));
}
const values = value => Array.isArray(value) ? value : [value];
function common(spec) {
  assert.equal(spec.name, 'LineaTransportB');
  assert.equal(spec.static_framework, true);
  assert.equal(spec.platforms.ios, '16.4');
  assert.deepEqual(values(spec.swift_versions), ['5.9']);
  assert.ok(Object.hasOwn(spec.dependencies, 'ExpoModulesCore'));
  assert.equal(spec.pod_target_xcconfig.DEFINES_MODULE, 'YES');
  assert.equal(spec.pod_target_xcconfig.SWIFT_COMPILATION_MODE, 'wholemodule');
}
function disabled(spec) {
  common(spec);
  assert.deepEqual(values(spec.source_files), ['TransportBModule.swift', 'TransportBURLSession.swift']);
  assert.equal(spec.vendored_frameworks, undefined);
  assert.equal(spec.libraries, undefined);
  assert.equal(spec.pod_target_xcconfig.SWIFT_ACTIVE_COMPILATION_CONDITIONS, undefined);
}

test('default and explicit disabled podspec evaluate without any Go/Swift artifacts', () => {
  fixture(false, root => {
    disabled(read(root, undefined));
    disabled(read(root, '0'));
  });
});
test('disabled podspec excludes the framework even when real artifacts are staged', () => {
  fixture(true, root => disabled(read(root, '0')));
});
test('enabled podspec evaluates in CocoaPods with the real framework and shared Swift source', () => {
  fixture(true, root => {
    const spec = read(root, '1');
    common(spec);
    assert.deepEqual(values(spec.source_files), ['TransportBModule.swift', 'TransportBURLSession.swift', 'Generated/*.swift']);
    assert.deepEqual(values(spec.vendored_frameworks), ['Frameworks/Mobile.xcframework']);
    assert.deepEqual(spec.libraries, ['resolv', 'c++']);
    assert.equal(spec.pod_target_xcconfig.SWIFT_ACTIVE_COMPILATION_CONDITIONS,
      '$(inherited) INVIZENT_TRANSPORT_B');
  });
});
test('enabled podspec fails closed for any missing required artifact', () => {
  fixture(true, () => fixture(false, root => {
    for (const missing of required) {
      for (const relative of required.filter(value => value !== missing)) {
        mkdirSync(dirname(join(root, relative)), { recursive: true });
        symlinkSync(join(source, relative), join(root, relative));
      }
      const result = spawnSync('pod', ['ipc', 'spec', join(root, filename), '--no-ansi'], {
        env: environment('1'), encoding: 'utf8', timeout: 60_000,
      });
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.ok(`${result.stdout}\n${result.stderr}`.includes(`Transport B enabled but missing ${missing}`));
      for (const directory of ['Frameworks', 'Generated']) rmSync(join(root, directory), { recursive: true, force: true });
    }
  }));
});
