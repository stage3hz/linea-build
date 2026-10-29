import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import sys

KIT = Path(sys.argv[1]).resolve()
SOURCE = Path(sys.argv[2]).resolve()
WORK = Path(tempfile.mkdtemp(prefix='linea-prepare-test-'))
RESULTS = []

def fixture(name, version='0.5.0'):
    p = WORK / name
    p.mkdir()
    for filename in ['app.config.js', 'eas.json']:
        shutil.copyfile(SOURCE / filename, p / filename)
    (p / 'package.json').write_text(json.dumps({'name': 'linea-mobile', **({'version': version} if version is not None else {})}))
    return p

def run(p, *flags, ok=True):
    proc = subprocess.run(['node', str(KIT / 'prepare-ios.mjs'), str(p), *flags], capture_output=True, text=True, timeout=10)
    assert (proc.returncode == 0) == ok, f'expected success={ok}; code={proc.returncode}; stdout={proc.stdout}; stderr={proc.stderr}'
    return json.loads(proc.stdout if ok else proc.stderr)

def test(name, body):
    try:
        body()
        RESULTS.append({'name': name, 'passed': True})
    except Exception as error:
        RESULTS.append({'name': name, 'passed': False, 'error': str(error)})

def baseline():
    p = fixture('baseline')
    app = (p/'app.config.js').read_bytes()
    eas = (p/'eas.json').read_bytes()
    r = run(p)
    text = (p/'app.config.js').read_text()
    assert r['status'] == 'prepared' and r['publicConfiguration'] == {}
    assert 'useFrameworks' in text and "'static'" in text
    assert all(x in text for x in ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION', 'ACCESS_BACKGROUND_LOCATION', 'ACCESS_MEDIA_LOCATION', 'SYSTEM_ALERT_WINDOW', 'QUERY_ALL_PACKAGES', 'PACKAGE_USAGE_STATS', 'MANAGE_EXTERNAL_STORAGE', 'READ_CONTACTS', 'WRITE_CONTACTS', 'READ_CALENDAR', 'WRITE_CALENDAR'])
    assert (p/'.linea-ios-cloud-setup/app.config.original.js').read_bytes() == app
    assert (p/'.linea-ios-cloud-setup/eas.original.json').read_bytes() == eas == (p/'eas.json').read_bytes()
    assert (p/'.linea-ios-cloud-setup/withLocalPrivacy.cjs').read_bytes() == (KIT/'withLocalPrivacy.cjs').read_bytes()
    assert not r['cloudBuildStarted'] and not r['accountsConnected']
    before = (p/'app.config.js').stat().st_mtime_ns
    assert run(p)['status'] == 'unchanged'
    assert (p/'app.config.js').stat().st_mtime_ns == before
test('baseline backups, hardening, no cloud actions, byte-preserving idempotency', baseline)

def public_settings():
    p = fixture('public-settings', '0.5.1')
    package = (p/'package.json').read_bytes()
    run(p, '--app-version', '0.5.1', '--bundle-id', 'org.synthetic.fixture')
    r = run(p, '--owner', 'synthetic-fixture', '--project-id', '00000000-0000-4000-8000-000000000001')
    assert r['status'] == 'updated'
    assert r['publicConfiguration'] == {'projectId':'00000000-0000-4000-8000-000000000001', 'owner':'synthetic-fixture', 'bundleId':'org.synthetic.fixture', 'appVersion':'0.5.1'}
    assert 'version: "0.5.1"' in (p/'app.config.js').read_text()
    assert (p/'package.json').read_bytes() == package
    assert run(p)['status'] == 'unchanged'
test('synthetic public settings and app version persist without editing package', public_settings)

def wrong_baseline(filename):
    p = fixture('wrong-'+filename.replace('.', '-'))
    (p/filename).write_text((p/filename).read_text()+'\n')
    before = (p/filename).read_bytes()
    run(p, ok=False)
    assert (p/filename).read_bytes() == before
    assert not (p/'.linea-ios-cloud-setup').exists()
test('foreign app baseline refused before backups', lambda: wrong_baseline('app.config.js'))
test('foreign EAS baseline refused before backups', lambda: wrong_baseline('eas.json'))

def foreign_app():
    p = fixture('foreign-app')
    run(p)
    (p/'app.config.js').write_text((p/'app.config.js').read_text()+'\n// user change\n')
    before = (p/'app.config.js').read_bytes()
    run(p, '--owner', 'synthetic', ok=False)
    assert (p/'app.config.js').read_bytes() == before
test('later foreign app changes preserved and refused', foreign_app)

def later_eas():
    p = fixture('later-eas')
    run(p)
    data = json.loads((p/'eas.json').read_text())
    data['build']['preview']['environment'] = 'preview'
    (p/'eas.json').write_text(json.dumps(data, indent=2)+'\n')
    before = (p/'eas.json').read_bytes()
    r = run(p, '--app-version', '0.5.1')
    assert r['easChangedSinceBaseline'] and (p/'eas.json').read_bytes() == before
test('later EAS customization retained during public settings update', later_eas)

def invalid_flags():
    for i, args in enumerate([
        ['--project-id','https://invalid.example/'], ['--owner','@synthetic'],
        ['--bundle-id','org.*'], ['--app-version','0.5.1-beta.1'],
        ['--app-version','00.5.1'], ['--owner','a','--owner','b'], ['--secret','x']
    ]):
        p = fixture(f'invalid-{i}')
        before = (p/'app.config.js').read_bytes()
        run(p, *args, ok=False)
        assert (p/'app.config.js').read_bytes() == before
        assert not (p/'.linea-ios-cloud-setup').exists()
test('malformed public flags and unknown/duplicate options fail before mutation', invalid_flags)

def foreign_generated(filename):
    p = fixture('foreign-'+filename)
    run(p)
    f = p/'.linea-ios-cloud-setup'/filename
    f.write_text(f.read_text()+'\n// changed\n')
    before = (p/'app.config.js').read_bytes()
    run(p, '--owner', 'synthetic', ok=False)
    assert (p/'app.config.js').read_bytes() == before
test('modified privacy guard preserved and refused', lambda: foreign_generated('withLocalPrivacy.cjs'))
test('modified baseline backup preserved and refused', lambda: foreign_generated('app.config.original.js'))

def symlink_app():
    p = fixture('symlink-app')
    file = p/'app.config.js'
    file.rename(p/'original.js')
    file.symlink_to(p/'original.js')
    run(p, ok=False)
    assert file.is_symlink()
test('symlink app config rejected', symlink_app)

def existing_lock():
    p = fixture('lock')
    (p/'.linea-ios-cloud-setup.lock').write_text('synthetic lock')
    before = (p/'app.config.js').read_bytes()
    run(p, ok=False)
    assert (p/'app.config.js').read_bytes() == before
    assert (p/'.linea-ios-cloud-setup.lock').read_text() == 'synthetic lock'
test('existing lock blocks overwrite and is not removed', existing_lock)

test('unrelated package version rejected', lambda: run(fixture('wrong-version', '9.9.9'), ok=False))
test('missing package version rejected', lambda: run(fixture('missing-version', None), ok=False))

print(json.dumps({'syntheticTestIdentitiesOnly': True, 'results': RESULTS, 'passed': sum(x['passed'] for x in RESULTS), 'total': len(RESULTS)}, indent=2))
shutil.rmtree(WORK)
raise SystemExit(0 if all(x['passed'] for x in RESULTS) else 1)
