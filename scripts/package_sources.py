#!/usr/bin/env python3
"""Inventory Linea 0.5.1 source files; create a ZIP only with --create-zip.

Previous release manifests remain historical evidence. The new 0.5.1 source
manifest and unchanged media manifests are compared with current source bytes.
"""
import argparse
import hashlib
import json
import os
import re
import stat
import tempfile
import zipfile
from pathlib import Path

BLOCKED_DIRS = {
    'node_modules', '.git', '.gradle', '.expo', '.qa', '.quality', '.kotlin',
    '.cxx', '.cache', '.pytest_cache', '__pycache__', '.nyc_output', '.metrics',
    'coverage', 'build', 'dist', 'data', 'uploads', 'cache', 'caches',
    '.venv', 'venv', 'target', 'test-tools', '.test-tools', 'quality-tools', 'tmp', '.tmp',
}
BLOCKED_EXTENSIONS = {
    '.keystore', '.jks', '.p12', '.pfx', '.p8', '.pem', '.key', '.mobileprovision',
    '.sqlite', '.sqlite3', '.db', '.pyc', '.pyo', '.salive', '.class', '.o',
    '.jar', '.aar', '.apk', '.aab', '.ipa', '.zip', '.tgz', '.tar', '.gz',
    '.so', '.dylib', '.dll', '.exe',
}
EVIDENCE_LOGS = {
    'docs/native-logs/android-module-compile.log',
    'docs/native-logs/android-release-build.log',
    'docs/native-logs/apk-signature.log',
    'docs/native-logs/apk-zipalign.log',
}
EVIDENCE_DIRECTORIES = {
    ('docs', 'native-logs'), ('docs', 'photo-evidence'),
    ('docs', 'photo-quality'), ('docs', 'quality'),
    ('docs', 'evidence-v05'), ('docs', 'evidence-v05-video'), ('docs', 'media-quality'),
    ('docs', 'username-quality'), ('docs', 'evidence-v05-build'), ('docs', 'ui-evidence'),
    ('docs', 'evidence-v051'),
}
ACTIVE_MANIFESTS = (
    'docs/SOURCE_MANIFEST_0.5.1.json',
    'docs/evidence-v05/native-v05-source-sha256.json',
    'docs/media-quality/source-manifest.json',
    'docs/evidence-v05-video/source-manifest.json',
)
REQUIRED = {
    '.gitignore', 'server/.dockerignore', 'package.json',
    'mobile/package.json', 'server/package.json',
    'mobile/package-lock.json', 'server/package-lock.json',
    'server/src/app.js', 'server/src/auth.js', 'server/src/e2ee.js', 'server/src/schema.sql',
    'mobile/modules/linea-signal/android/build.gradle',
    'mobile/modules/linea-signal/android/src/main/java/expo/modules/lineasignal/SignalCore.kt',
    'mobile/modules/linea-signal/android/src/main/java/expo/modules/lineasignal/LineSignalModule.kt',
    'mobile/modules/linea-signal/android/src/test/java/expo/modules/lineasignal/SignalCoreTest.kt',
    'mobile/modules/linea-signal/android/src/test/java/expo/modules/lineasignal/SignalInterop.kt',
    'mobile/modules/linea-signal/ios/SignalCore.swift',
    'mobile/modules/linea-signal/ios/LineSignalModule.swift',
    'mobile/modules/linea-signal/ios/LineaSignal.podspec',
    'mobile/modules/linea-signal/jvm-tests/build.gradle',
    'mobile/modules/linea-signal/jvm-tests/settings.gradle',
    'mobile/plugins/withLineSignal.js', 'mobile/assets/icon.png',
    'licenses/libsignal-AGPL-3.0.txt', 'THIRD_PARTY_NOTICES.md',
    'docs/QUALITY_REPORT.md', 'docs/quality/source-manifest.json',
    'docs/quality/server-coverage.lcov',
    'docs/NATIVE_ARTIFACT_VERIFICATION.json', 'docs/NATIVE_SOURCE_MANIFEST.json',
    'docs/native-logs/apk-manifest.xml', 'docs/native-logs/jvm-signal-tests.xml',
    'deploy/compose.production.yml', 'deploy/Caddyfile', 'deploy/.env.example',
    'mobile/.env.example', 'server/.env.example',
} | EVIDENCE_LOGS
REQUIRED |= {
    'mobile/plugins/withLinePhoto.js',
    'mobile/modules/linea-photo/android/build.gradle',
    'mobile/modules/linea-photo/android/src/main/java/expo/modules/lineaphoto/LinePhotoModule.kt',
    'mobile/modules/linea-photo/android/src/main/java/expo/modules/lineaphoto/PhotoBackground.kt',
    'mobile/modules/linea-photo/android/src/main/java/expo/modules/lineaphoto/PhotoFiles.kt',
    'mobile/modules/linea-photo/android/src/main/java/expo/modules/lineaphoto/PhotoOptions.kt',
    'mobile/modules/linea-photo/android/src/main/java/expo/modules/lineaphoto/PhotoPixels.kt',
    'mobile/modules/linea-photo/android/src/test/java/expo/modules/lineaphoto/PhotoOptionsTest.kt',
    'mobile/modules/linea-photo/android/src/test/java/expo/modules/lineaphoto/PhotoPixelsTest.kt',
    'mobile/modules/linea-photo/ios/LinePhotoModule.swift',
    'mobile/modules/linea-photo/ios/PhotoBackground.swift',
    'mobile/modules/linea-photo/ios/PhotoFiles.swift',
    'mobile/modules/linea-photo/ios/PhotoOptions.swift',
    'mobile/modules/linea-photo/ios/PhotoPixels.swift',
    'mobile/modules/linea-photo/ios/LineaPhoto.podspec',
    'mobile/modules/linea-photo/jvm-tests/build.gradle',
    'mobile/modules/linea-photo/jvm-tests/settings.gradle',
    'mobile/modules/linea-photo/index.ts',
    'mobile/modules/linea-photo/expo-module.config.json',
    'mobile/modules/linea-photo/package.json',
    'mobile/src/photo/PhotoEditor.tsx', 'mobile/src/photo/PreviewSession.ts',
    'mobile/src/photo/editorModel.ts', 'mobile/src/photo/pipeline.ts',
    'mobile/src/photo/png.ts', 'mobile/src/photo/formats.ts',
    'mobile/src/photo/bridge.ts', 'mobile/src/photo/bridge.native.ts',
    'mobile/test/photo-editor.test.mjs', 'mobile/test/photo-pipeline.test.mjs',
    'mobile/test/photo-formats.test.mjs', 'mobile/test/photo-png.test.mjs',
    'mobile/test/e2ee-photo-upload.test.mjs', 'mobile/test/support/png-fixture.mjs',
    'docs/PHOTO_UI_REPORT.md', 'docs/PHOTO_NATIVE_REPORT.md',
    'docs/PHOTO_PNG_REPORT.md', 'docs/TELEGRAM_PARITY.md',
    'docs/PHOTO_FEATURES.md', 'docs/PHOTO_PIPELINE_REPORT.md',
    'docs/PHOTO_BUILD_REPORT.md', 'docs/PHOTO_APK_VERIFICATION.json',
    'docs/TEST_REPORT_0.3.0.md',
    'docs/photo-evidence/android-prebuild.txt',
    'docs/photo-evidence/android-photo-compile.txt',
    'docs/photo-evidence/TEST-expo.modules.lineaphoto.PhotoOptionsTest.xml',
    'docs/photo-evidence/TEST-expo.modules.lineaphoto.PhotoPixelsTest.xml',
    'docs/photo-evidence/verification-v04.json',
    'docs/photo-evidence/e2ee-v04-final.txt',
    'docs/photo-evidence/android-v04-release-build.txt',
    'docs/photo-evidence/v04-apk-signature.txt',
    'docs/photo-evidence/v04-apk-zipalign.txt',
    'docs/photo-evidence/v04-apk-manifest.xml',
    'docs/photo-evidence/v04-elf-alignment.txt',
    'docs/photo-quality/png-crap.txt', 'docs/photo-quality/png-dry.txt',
    'docs/photo-quality/png-mutation.txt', 'docs/photo-quality/png-coverage.lcov',
    'docs/photo-quality/pixel-decoder-check.json',
    'docs/photo-quality/png-coverage-tests.log',
} | set(ACTIVE_MANIFESTS)

REQUIRED |= {
    'docs/TEST_REPORT_0.4.0.md', 'docs/MEDIA_0.5_REPORT.md', 'docs/RELEASE_0.5.md',
    'docs/E2EE_ONLY_0.5.md', 'docs/E2EE_INTEGRATION_MIGRATION_REPORT.md',
    'docs/MEDIA_QUALITY_REPORT.md', 'docs/BUILD_REPORT_0.5.md', 'docs/APK_VERIFICATION_0.5.json',
    'docs/PROFILE_THEME_UI_REPORT.md', 'docs/VIDEO_NATIVE_REPORT.md',
    'docs/PLATINA_WORDMARK.md', 'docs/DEPENDENCY_AUDIT_V05.md',
    'mobile/src/PlatinaWordmark.tsx',
    'mobile/assets/branding/platina-chrome.svg', 'mobile/assets/branding/platina-chrome-light.svg',
    'scripts/create_platina_wordmark.py', 'docs/evidence-v05-build/platina-svg-validation.json',
    'scripts/package_server.py', 'docs/DEPLOY_FROM_IPHONE.md', 'deploy/backup.sh',
    'mobile/test/secure-transport.test.mjs', 'server/test/support/relay-fixtures.js',
    'docs/ENGINEERING_LOG_0.5.md', 'docs/AI_BACKEND_REPORT.md', 'docs/AI_UI_REPORT.md',
    'docs/ATTACHMENT_UI_REPORT.md', 'docs/PHOTO_NATIVE_0.5_REPORT.md',
    'mobile/src/media/AttachmentViewer.tsx', 'mobile/src/media/pipeline.ts',
    'mobile/src/media/mp4.ts', 'mobile/src/media/mp4Boxes.ts', 'mobile/src/media/mp4Samples.ts',
    'mobile/src/media/previewModel.ts', 'mobile/src/media/thumbnail.ts', 'mobile/src/media/ViewSession.ts',
    'mobile/src/photo/jpeg.ts', 'mobile/src/photo/pngHdr.ts', 'mobile/src/photo/exifOrientation.ts',
    'mobile/src/ai/AIScreen.tsx', 'mobile/src/ai/conversation.ts',
    'mobile/src/ThemeSettings.tsx', 'mobile/src/themePreference.ts', 'mobile/src/StatusEmoji.tsx',
    'mobile/modules/linea-video/index.ts', 'mobile/modules/linea-video/expo-module.config.json',
    'mobile/plugins/withLineVideo.js',
    'server/src/ai.js', 'server/src/username.js', 'server/src/entitlements.js', 'server/src/platina-admin.js',
    'server/test/ai.test.js', 'server/test/ai-app.test.js', 'server/test/username.test.js', 'server/test/username-search.test.js',
}

REQUIRED |= {
    'docs/BUILD_SOURCE_MANIFEST_0.5.json',
    'docs/RELEASE_0.5.1.md', 'docs/PREPARATION_REPORT_0.5.1.md',
    'docs/PLATINA_OWNER_0.5.1.md', 'docs/PRIVACY_0.5.1.md',
    'docs/evidence-v051/server-validation.json', 'docs/evidence-v051/server-full.txt',
    'docs/evidence-v051/mobile-status-emoji.txt', 'docs/evidence-v051/mobile-typecheck.json',
    'docs/evidence-v051/mobile-ios-export.json', 'docs/evidence-v051/mobile-verification.json',
    'mobile/.linea-ios-cloud-setup/withLocalPrivacy.cjs',
    'mobile/.linea-ios-cloud-setup/app.config.original.js',
    'mobile/.linea-ios-cloud-setup/eas.original.json',
    'tools/ios-cloud-setup/README.md', 'tools/ios-cloud-setup/prepare-ios.mjs',
    'tools/ios-cloud-setup/withLocalPrivacy.cjs',
    'tools/ios-cloud-setup/PREPARATION_REPORT.md', 'tools/ios-cloud-setup/VERIFICATION.json',
}

PRIVATE_KEY = re.compile(rb'-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----')
EVIDENCE_CREDENTIAL = re.compile(rb'''(?i)(?:authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|secret[_-]?key|password|passwd|storepass|keypass|storepassword|keypassword)["']?\s*[=:]\s*["']?[^\s"']+|https?://[^\s/@:]+:[^\s/@]+@''')


def exclusion(relative, directory=False):
    parts = relative.parts
    if parts[:2] in (('mobile', 'android'), ('mobile', 'ios')):
        return 'generated native application'
    if any(part.lower() in BLOCKED_DIRS for part in (parts if directory else parts[:-1])):
        return 'dependency, build output or cache'
    name = relative.name.lower()
    if name in {'.ds_store', 'thumbs.db', 'id_rsa', 'id_ed25519'}:
        return 'local metadata or credential'
    if name == '.env' or name.startswith('.env.') or name.endswith('.env'):
        if not (name in {'.env.example', '.env.sample', '.env.template', 'example.env', 'sample.env', 'template.env'} or name.startswith('.env.') and name.endswith('.example')):
            return 'actual environment file'
    if relative.suffix.lower() in BLOCKED_EXTENSIONS or re.search(r'\.(?:sqlite3?|db)(?:-wal|-shm|-journal)$', name):
        return 'credential, database or compiled artifact'
    if (name.endswith('.log') or '.log.' in name) and parts[:2] not in EVIDENCE_DIRECTORIES:
        return 'unapproved log'
    return None


def parse_manifest(name, data):
    """Read the current build, native photo/video and quality manifests strictly."""
    if not isinstance(data, dict):
        raise ValueError('Manifest root is not an object.')
    if name == ACTIVE_MANIFESTS[0]:
        entries = data.get('files')
    elif name == ACTIVE_MANIFESTS[1]:
        entries = data.get('files')
    elif name == ACTIVE_MANIFESTS[3]:
        entries = data.get('sha256')
    else:
        sources = data.get('sources')
        if not isinstance(sources, dict):
            raise ValueError('Quality manifest has no sources object.')
        entries = {}
        for path, item in sources.items():
            if not isinstance(item, dict) or item.get('matchesTestedStaging') is not True:
                raise ValueError('Quality source is not confirmed to match tested staging.')
            entries[path] = item.get('sha256')
    if not isinstance(entries, dict) or not entries:
        raise ValueError('Manifest has no source hash entries.')
    for path, digest in entries.items():
        if not isinstance(path, str) or Path(path).is_absolute() or '..' in Path(path).parts:
            raise ValueError('Manifest contains an unsafe source path.')
        if Path(path).as_posix() != path or not path:
            raise ValueError('Manifest contains a noncanonical source path.')
        if not isinstance(digest, str) or re.fullmatch(r'[0-9a-f]{64}', digest) is None:
            raise ValueError('Manifest contains an invalid SHA-256.')
    if name == ACTIVE_MANIFESTS[0]:
        aggregate = hashlib.sha256(''.join(f'{entries[path]}  {path}\n' for path in sorted(entries)).encode('utf-8')).hexdigest()
        if aggregate != data.get('aggregateSha256'):
            raise ValueError('Build manifest aggregate SHA-256 does not match its entries.')
    return entries


def verify_manifests(read_bytes, selected):
    reports = []
    for name in ACTIVE_MANIFESTS:
        report = {'path': name, 'checked': 0, 'differences': [], 'missingIncluded': [], 'errors': []}
        reports.append(report)
        if name not in selected:
            report['errors'].append('Required active manifest is absent from the source inventory.')
            continue
        try:
            entries = parse_manifest(name, json.loads(read_bytes(name)))
            report['checked'] = len(entries)
            for relative, recorded in entries.items():
                if relative not in selected:
                    report['missingIncluded'].append(relative)
                elif hashlib.sha256(read_bytes(relative)).hexdigest() != recorded:
                    report['differences'].append(relative)
        except (ValueError, OSError, KeyError) as error:
            report['errors'].append(str(error))
    return reports


def manifest_failures(reports):
    return any(report['differences'] or report['missingIncluded'] or report['errors'] for report in reports)


def collect_inventory(project):
    project = Path(project).resolve()
    if project.name != 'linea-messenger' or not project.is_dir():
        raise ValueError('The source root must be the linea-messenger directory.')
    files, excluded, suspicious = [], [], []
    for directory, dirs, names in os.walk(project, followlinks=False):
        parent = Path(directory)
        for name in list(dirs):
            path = parent/name
            relative = path.relative_to(project)
            reason = 'symlink' if path.is_symlink() else exclusion(relative, True)
            if reason:
                dirs.remove(name)
                excluded.append({'path': relative.as_posix()+'/', 'reason': reason})
        for name in names:
            path = parent/name
            relative = path.relative_to(project)
            reason = 'symlink' if path.is_symlink() else exclusion(relative)
            if reason:
                excluded.append({'path': relative.as_posix(), 'reason': reason})
                continue
            if not path.is_file():
                raise ValueError(f'Non-regular source entry: {relative}')
            data = path.read_bytes()
            if PRIVATE_KEY.search(data):
                suspicious.append({'path': relative.as_posix(), 'reason': 'private-key block'})
            if relative.parts[:2] in EVIDENCE_DIRECTORIES and EVIDENCE_CREDENTIAL.search(data):
                suspicious.append({'path': relative.as_posix(), 'reason': 'possible credential in evidence'})
            if len(data) > 8*1024*1024:
                suspicious.append({'path': relative.as_posix(), 'reason': 'source file exceeds 8 MiB'})
            files.append({'path': relative.as_posix(), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'executable': bool(path.stat().st_mode & 0o111)})
    files.sort(key=lambda item: item['path'])
    selected = {item['path'] for item in files}
    manifests = verify_manifests(lambda name: (project/name).read_bytes(), selected)
    return {'project': str(project), 'files': files, 'fileCount': len(files), 'totalBytes': sum(item['bytes'] for item in files), 'excluded': sorted(excluded, key=lambda item: item['path']), 'missingRequired': sorted(REQUIRED-selected), 'suspicious': suspicious, 'activeManifests': manifests, 'historicalManifestsNotCompared': ['docs/BUILD_SOURCE_MANIFEST_0.5.json', 'docs/quality/source-manifest.json', 'docs/NATIVE_SOURCE_MANIFEST.json', 'docs/PHOTO_BUILD_SOURCE_MANIFEST.json', 'docs/photo-evidence/native-source-sha256.json', 'docs/photo-quality/source-manifest.json']}


def create_archive(project, inventory, destination):
    if inventory['missingRequired'] or inventory['suspicious'] or manifest_failures(inventory['activeManifests']):
        raise ValueError('Inventory requires review; see missingRequired, suspicious and activeManifests fields.')
    destination = Path(destination).resolve()
    if destination.name != 'linea-messenger-v0.5.1.zip':
        raise ValueError('The 0.5.1 archive must be named linea-messenger-v0.5.1.zip.')
    if destination.is_relative_to(project):
        raise ValueError('Write the archive outside the source project.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix='linea-source-', suffix='.tmp', dir=destination.parent)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for item in inventory['files']:
                data = (project/item['path']).read_bytes()
                if hashlib.sha256(data).hexdigest() != item['sha256']:
                    raise ValueError(f'Source changed while packaging: {item["path"]}')
                info = zipfile.ZipInfo('linea-messenger/'+item['path'])
                info.create_system = 3
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (stat.S_IFREG | (0o755 if item['executable'] else 0o644)) << 16
                archive.writestr(info, data, compresslevel=9)
        with zipfile.ZipFile(temporary) as archive:
            if archive.testzip() is not None:
                raise ValueError('ZIP CRC verification failed.')
            if set(archive.namelist()) != {'linea-messenger/'+item['path'] for item in inventory['files']}:
                raise ValueError('ZIP entry list does not match the reviewed inventory.')
            selected = {item['path'] for item in inventory['files']}
            for item in inventory['files']:
                data = archive.read('linea-messenger/'+item['path'])
                if hashlib.sha256(data).hexdigest() != item['sha256']:
                    raise ValueError('ZIP entry differs from the reviewed source: '+item['path'])
            archive_manifests = verify_manifests(lambda name: archive.read('linea-messenger/'+name), selected)
            if manifest_failures(archive_manifests):
                raise ValueError('The active manifests do not match the archived bytes.')
        if collect_inventory(project)['files'] != inventory['files']:
            raise ValueError('Source tree changed during packaging. Rerun after editing finishes.')
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)
    return {'path': str(destination), 'bytes': destination.stat().st_size, 'sha256': hashlib.sha256(destination.read_bytes()).hexdigest(), 'crc': 'PASS', 'activeManifestsInsideZip': archive_manifests}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--create-zip', type=Path)
    args = parser.parse_args()
    project = args.project.resolve()
    inventory = collect_inventory(project)
    if args.manifest:
        args.manifest.parent.mkdir(parents=True, exist_ok=True)
        args.manifest.write_text(json.dumps(inventory, ensure_ascii=False, indent=2)+'\n')
    summary = {key: value for key, value in inventory.items() if key not in {'files', 'excluded'}}
    summary['excludedEntries'] = len(inventory['excluded'])
    summary['mode'] = 'archive' if args.create_zip else 'inventory'
    if args.create_zip:
        summary['archive'] = create_archive(project, inventory, args.create_zip)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 2 if inventory['missingRequired'] or inventory['suspicious'] or manifest_failures(inventory['activeManifests']) else 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print(str(error), file=__import__('sys').stderr)
        raise SystemExit(2)
