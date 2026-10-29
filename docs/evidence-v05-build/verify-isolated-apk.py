from pathlib import Path
import hashlib,json,os,re,shutil,struct,subprocess,tempfile,zipfile
import xml.etree.ElementTree as ET

if not __debug__:
    raise RuntimeError('APK verification requires Python assertions enabled')

ROOT=Path('/workspace/scratch/f1956a5cefad/linea-messenger')
STAGE=Path('/tmp/linea-v05-isolated')
SDK=Path('/tmp/linea-android-sdk')
EVIDENCE=ROOT/'docs/evidence-v05-build'
DELIVERABLE=ROOT.parent/'linea-0.5.0-preview-arm64.apk'
APK=STAGE/'apk-under-verification.apk'
SOURCE=STAGE/'mobile/android/app/build/outputs/apk/release/app-release.apk'
EXPECTED_CERT='fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c'
ENV={**os.environ,'JAVA_HOME':'/tmp/linea-jdk21','ANDROID_HOME':str(SDK),'ANDROID_USER_HOME':'/tmp/linea-android-user'}

def dex_definitions(data):
    assert len(data)>=112 and data[:4]==b'dex\n', 'Unexpected DEX header'
    assert struct.unpack_from('<I',data,40)[0]==0x12345678, 'Unexpected DEX byte order'
    strings,string_offset,types,type_offset=struct.unpack_from('<IIII',data,56)
    classes,class_offset=struct.unpack_from('<II',data,96)
    assert string_offset+strings*4<=len(data) and type_offset+types*4<=len(data)
    assert class_offset+classes*32<=len(data)
    found=set()
    for index in range(classes):
        type_index=struct.unpack_from('<I',data,class_offset+index*32)[0]
        assert type_index<types
        string_index=struct.unpack_from('<I',data,type_offset+type_index*4)[0]
        assert string_index<strings
        offset=struct.unpack_from('<I',data,string_offset+string_index*4)[0]
        for _ in range(5):
            assert offset<len(data)
            marker=data[offset];offset+=1
            if marker<128:break
        else:raise AssertionError('Invalid DEX string length')
        end=data.find(b'\0',offset)
        assert end>=offset
        found.add(data[offset:end])
    return found

def run(command,output):
    result=subprocess.run([str(x) for x in command],env=ENV,text=True,capture_output=True)
    (EVIDENCE/output).write_text(result.stdout+result.stderr)
    if result.returncode:
        raise RuntimeError(f'{output}: exit {result.returncode}: {result.stderr[-1500:]}')
    return result.stdout

assert SOURCE.is_file(),'Expected release APK is not present'
shutil.copy2(SOURCE,APK)
cert=run([SDK/'build-tools/36.0.0/apksigner','verify','--verbose','--print-certs',APK],'v05-apk-signature.txt')
actual=re.search(r'certificate SHA-256 digest: ([0-9a-fA-F]+)',cert).group(1).lower()
assert actual==EXPECTED_CERT,'Preview certificate changed'
assert 'Verified using v2 scheme (APK Signature Scheme v2): true' in cert
run([SDK/'build-tools/36.0.0/zipalign','-c','-P','16','-v','4',APK],'v05-apk-zipalign.txt')
xml=run([SDK/'cmdline-tools/latest/bin/apkanalyzer','manifest','print',APK],'v05-apk-manifest.xml')
manifest=ET.fromstring(xml)
NS='{http://schemas.android.com/apk/res/android}'
application=manifest.find('application');sdk=manifest.find('uses-sdk')
facts={
    'package':manifest.attrib['package'],
    'versionName':manifest.attrib[NS+'versionName'],
    'versionCode':manifest.attrib[NS+'versionCode'],
    'minimumSdk':sdk.attrib[NS+'minSdkVersion'],
    'targetSdk':sdk.attrib[NS+'targetSdkVersion'],
    'debuggable':application.get(NS+'debuggable','false'),
    'allowBackup':application.get(NS+'allowBackup','true'),
    'usesCleartextTraffic':application.get(NS+'usesCleartextTraffic'),
    'permissions':[x.attrib[NS+'name'] for x in manifest.findall('uses-permission')]
}
assert facts['package']=='com.linea.messenger.preview'
assert facts['versionName']=='0.5.0' and facts['versionCode']=='5'
assert facts['minimumSdk']=='26' and facts['targetSdk']=='36'
assert facts['debuggable']=='false' and facts['allowBackup']=='false'
assert facts['usesCleartextTraffic']=='false'
assert not set(facts['permissions']) & {'android.permission.RECORD_AUDIO','android.permission.CAMERA','android.permission.ACCESS_MEDIA_LOCATION','android.permission.WRITE_EXTERNAL_STORAGE','android.permission.READ_MEDIA_AUDIO'}

alignments={};alignment_logs=[];branding_assets=[]
with zipfile.ZipFile(APK) as archive:
    assert archive.testzip() is None,'APK ZIP CRC check failed'
    names=archive.namelist()
    assert len(names)==len(set(names)), 'Duplicate APK ZIP entry'
    assert 'AndroidManifest.xml' in names and 'resources.arsc' in names, 'Missing compiled Android resources'
    assert any(n.startswith('res/') for n in names), 'Missing packaged Android resources'
    hidden_libs=[n for n in names if n.startswith('lib/') and any(part.startswith('.') for part in Path(n).parts)]
    assert not hidden_libs, f'Unexpected hidden native files: {hidden_libs}'
    libraries=sorted(n for n in names if n.startswith('lib/') and n.endswith('.so'))
    assert libraries and all(n.startswith('lib/arm64-v8a/') for n in libraries)
    assert 'lib/arm64-v8a/libsignal_jni.so' in libraries
    sqlcipher='lib/arm64-v8a/libexpo-sqlite.so'
    assert sqlcipher in libraries and b'sqlcipher' in archive.read(sqlcipher).lower()
    dex_files=[archive.read(n) for n in names if re.fullmatch(r'classes\d*\.dex',n)]
    definitions=set().union(*(dex_definitions(data) for data in dex_files))
    required_definitions={
        b'Lexpo/modules/lineaphoto/LinePhotoModule;',
        b'Lexpo/modules/lineasignal/LineSignalModule;',
        b'Lexpo/modules/lineavideo/LineVideoModule;',
        b'Lexpo/modules/ExpoModulesPackageList;',
        b'Lcom/linea/messenger/preview/MainActivity;',
        b'Lcom/linea/messenger/preview/MainApplication;',
    }
    assert required_definitions<=definitions, f'Missing DEX class definitions: {required_definitions-definitions}'
    forbidden=(b'SignalInteropKt',b'SignalCoreTest',b'PhotoPixelsTest',b'PhotoOptionsTest',b'PhotoSourceTest',b'VideoPolicyTest',b'VideoNalTest')
    assert not any(marker in definition for definition in definitions for marker in forbidden), 'Own tests/CLI packaged'
    bundle=archive.read('assets/index.android.bundle')
    bundle_sha=hashlib.sha256(bundle).hexdigest()
    for svg_name in ('platina-chrome.svg','platina-chrome-light.svg'):
        svg_path=ROOT/'mobile/assets/branding'/svg_name
        svg_bytes=svg_path.read_bytes()
        candidates=[n for n in names if archive.getinfo(n).file_size==len(svg_bytes)]
        matches=[n for n in candidates if archive.read(n)==svg_bytes]
        assert matches,f'PLATINA SVG asset absent or changed: {svg_name}'
        branding_assets.append({'source':svg_path.relative_to(ROOT).as_posix(),'apkEntries':matches,'sha256':hashlib.sha256(svg_bytes).hexdigest()})
    with tempfile.TemporaryDirectory(prefix='linea-v05-elf-') as directory:
        for name in libraries:
            local=Path(directory)/Path(name).name
            local.write_bytes(archive.read(name))
            result=subprocess.run([str(SDK/'ndk/27.1.12297006/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf'),'--program-headers','--wide',str(local)],text=True,capture_output=True,check=True)
            loads=[int(line.split()[-1],16) for line in result.stdout.splitlines() if line.strip().startswith('LOAD ')]
            assert loads and min(loads)>=16384,f'{name}: unsupported ELF LOAD alignment'
            alignments[name]=min(loads)
            alignment_logs.append(name+'\n'+result.stdout)
(EVIDENCE/'v05-elf-alignment.txt').write_text('\n'.join(alignment_logs))

snapshot_path=ROOT/'docs/BUILD_SOURCE_MANIFEST_0.5.json'
snapshot=json.loads(snapshot_path.read_text())
changed=[name for name,digest in snapshot['files'].items() if hashlib.sha256((ROOT/name).read_bytes()).hexdigest()!=digest]
assert not changed,f'Production inputs changed: {changed}'
stage_changed=[name for name,digest in snapshot['files'].items() if not (STAGE/name).is_file() or hashlib.sha256((STAGE/name).read_bytes()).hexdigest()!=digest]
assert not stage_changed,f'Isolated inputs changed: {stage_changed}'
registration=STAGE/'mobile/node_modules/expo/android/build/generated/expo/src/main/java/expo/modules/ExpoModulesPackageList.kt'
registered=registration.read_text()
assert 'expo.modules.lineaphoto.LinePhotoModule::class.java' in registered
assert 'expo.modules.lineasignal.LineSignalModule::class.java' in registered
assert 'expo.modules.lineavideo.LineVideoModule::class.java' in registered
assert 'expo.sqlite.useSQLCipher=true' in (STAGE/'mobile/android/gradle.properties').read_text()
snapshot['verification']=f"All {len(snapshot['files'])} production inputs match both the original project and isolated build stage after the final APK build and verification"
log=(STAGE/'android-release-build.log').read_text()
duration=re.search(r'BUILD SUCCESSFUL in ([^\n]+)',log).group(1)
metro=re.search(r'Android Bundled (\d+)ms index.ts \((\d+) modules\)',log)
metro_log='android-release-build.log'
if metro is None:
    prior_log=(STAGE/'android-first-metaspace-failed.log').read_text()
    metro=re.search(r'Android Bundled (\d+)ms index.ts \((\d+) modules\)',prior_log)
    metro_log='android-first-metaspace-failed.log'
assert metro is not None, 'No completed Metro component build in the isolated stage logs'
verified_sha=hashlib.sha256(APK.read_bytes()).hexdigest()
pending=DELIVERABLE.with_name(DELIVERABLE.name+'.verified-copy')
shutil.copy2(APK,pending)
assert hashlib.sha256(pending.read_bytes()).hexdigest()==verified_sha, 'Final copy hash mismatch'
os.replace(pending,DELIVERABLE)
assert hashlib.sha256(DELIVERABLE.read_bytes()).hexdigest()==verified_sha, 'Published file hash mismatch'
facts_json={
    'deliverablePath':str(DELIVERABLE),
    'sizeBytes':APK.stat().st_size,
    'apkSha256':hashlib.sha256(APK.read_bytes()).hexdigest(),
    'certificateSha256':actual,
    'apkSignatureVerified':True,
    'zipalign16KiBVerified':True,
    'manifest':facts,
    'nativeLibraries':libraries,
    'elfMinimumLoadAlignments':alignments,
    'nativePhotoModuleInDex':True,
    'nativeSignalModuleInDex':True,
    'nativeVideoModuleInDex':True,
    'allThreeModulesRegisteredByExpo':True,
    'sqlcipherBinaries':[sqlcipher],
    'ourNativeTestsAndCliAbsent':True,
    'requiredDexClassDefinitions':[x.decode('ascii') for x in sorted(required_definitions)],
    'finalCopyHashVerified':True,
    'bundleSha256':bundle_sha,
    'platinaSvgAssets':branding_assets,
    'bundleModules':int(metro.group(2)) if metro else None,
    'bundleMilliseconds':int(metro.group(1)) if metro else None,
    'bundleCompilationLog':metro_log,
    'bundleReusedAfterLintMemoryRetry':metro_log!='android-release-build.log',
    'sourceAggregateSha256':snapshot['aggregateSha256'],
    'productionInputsUnchanged':len(snapshot['files']),
    'buildDuration':duration,
    'isolatedBuildRoot':str(STAGE),
    'isolatedInputsMatch':len(snapshot['files']),
    'androidManifestAndResourceTablePresent':True,
    'apkResourceEntries':sum(n.startswith('res/') for n in names),
    'apkZipEntries':len(names),
    'hiddenNativeFilesAbsent':True,
    'physicalAndroidRuntimeTested':False,
    'iOSBuildTested':False
}
(ROOT/'docs/APK_VERIFICATION_0.5.json').write_text(json.dumps(facts_json,indent=2)+'\n')
snapshot_path.write_text(json.dumps(snapshot,indent=2)+'\n')
print(json.dumps({k:facts_json[k] for k in ('deliverablePath','sizeBytes','apkSha256','certificateSha256','productionInputsUnchanged','buildDuration','bundleModules')},indent=2))
