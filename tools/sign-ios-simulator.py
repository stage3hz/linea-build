#!/usr/bin/env python3
"""Apply a private, per-bundle identity to a simulator-only test app.

No production entitlements or IPA are changed. Application and extension have
separate default keychain groups; no keychain group is shared between them.
"""
import pathlib, plistlib, struct, subprocess, sys, tempfile
app=pathlib.Path(sys.argv[1]).resolve()
bundles=list((app/'PlugIns').glob('*.appex'))+[app]
with tempfile.TemporaryDirectory(prefix='invizent-sim-sign-') as directory:
    for index,bundle in enumerate(bundles):
        info=plistlib.loads((bundle/'Info.plist').read_bytes())
        binary=(bundle/info['CFBundleExecutable']).read_bytes()
        if struct.unpack_from('<I',binary)[0]!=0xfeedfacf:raise SystemExit('Expected thin simulator Mach-O')
        offset=32;platforms=[]
        for _ in range(struct.unpack_from('<I',binary,16)[0]):
            command,size=struct.unpack_from('<II',binary,offset)
            if command==0x32:platforms.append(struct.unpack_from('<I',binary,offset+8)[0])
            offset+=size
        if platforms!=[7]:raise SystemExit('Refusing to sign a device binary with a simulator identity')
        identifier='SIMULATOR0.'+info['CFBundleIdentifier']
        entitlements={'application-identifier':identifier,'com.apple.developer.team-identifier':'SIMULATOR0','get-task-allow':True,'keychain-access-groups':[identifier]}
        target=pathlib.Path(directory)/f'{index}.plist';target.write_bytes(plistlib.dumps(entitlements))
        subprocess.run(['codesign','--force','--sign','-','--entitlements',str(target),str(bundle)],check=True)
