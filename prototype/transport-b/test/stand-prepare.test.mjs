import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const script=fileURLToPath(new URL('../stand/prepare.py',import.meta.url));
const setup=String.raw`
import copy, importlib.util, io, json, os, pathlib, tempfile
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('stand_prepare', __import__('sys').argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
SAFE={'system':'Linux','machine':'x86_64','os_id':'ubuntu','os_version':'24.04',
      'local_ips':['127.0.0.1','10.2.3.4'],'api_ips':['8.8.8.8'],
      'listeners':[{'protocol':'tcp','address':'0.0.0.0','port':22},
                   {'protocol':'udp','address':'127.0.0.53','port':53}],
      'docker_running':False,'errors':[],'needs_tools':[]}
def invoke(arguments,facts,preparer=None):
 output=io.StringIO()
 options={'scanner':lambda:facts,'output':output}
 if preparer is not None:options['preparer']=preparer
 result=m.main(arguments,**options)
 return result,json.loads(output.getvalue())
`;
function python(body){
 const result=spawnSync('python3',['-B','-c',setup+body,script],{encoding:'utf8',timeout:20_000});
 assert.equal(result.error,undefined);
 assert.equal(result.status,0,result.stderr||result.stdout);
 return result.stdout;
}

test('default/check are read only and disclose only sanitized namespace-local status',()=>{
 python(String.raw`
for arguments in [[],['--check']]:
 with patch.object(m,'prepare_stand',side_effect=AssertionError('must not prepare')), patch.object(m.urllib.request,'urlopen',side_effect=AssertionError('must not download')):
  result,report=invoke(arguments,SAFE,lambda *args: (_ for _ in ()).throw(AssertionError('must not prepare')))
 assert result==0 and report['status']=='check-passed' and report['prepare_ready'] is True
 assert report['scope']=='current-network-and-process-namespaces'
 assert 'not-proof-of-all-service-absence' in report['limitations']
 encoded=json.dumps(report)
 assert '10.2.3.4' not in encoded and '8.8.8.8' not in encoded
`);
});

test('known production addresses remain denied even after canonical DNS changes',()=>{
 python(String.raw`
for address in sorted(m.PRODUCTION_IPS)+['::ffff:'+value for value in sorted(m.PRODUCTION_IPS)]:
 facts=copy.deepcopy(SAFE);facts['local_ips'].append(address)
 called=[]
 result,report=invoke(['--prepare','/definitely-not-created'],facts,lambda *a:called.append(a))
 assert result==2 and 'KNOWN_PRODUCTION_HOST' in report['codes'] and called==[]
`);
});

test('canonical DNS ownership, lookup failures and incomplete inventories fail closed before writes',()=>{
 python(String.raw`
for patch_values,wanted in [
 ({'api_ips':['10.2.3.4']},'CANONICAL_API_HOST'),
 ({'api_ips':[]},'CANONICAL_DNS_UNAVAILABLE'),
 ({'errors':['CANONICAL_DNS_UNAVAILABLE']},'CANONICAL_DNS_UNAVAILABLE'),
 ({'local_ips':[]},'LOCAL_IP_INVENTORY_UNAVAILABLE'),
 ({'docker_running':None},'DOCKER_INVENTORY_UNAVAILABLE'),
 ({'errors':['LISTENER_INVENTORY_UNAVAILABLE']},'LISTENER_INVENTORY_UNAVAILABLE'),
 ({'errors':['LOCAL_IP_INVENTORY_UNAVAILABLE']},'LOCAL_IP_INVENTORY_UNAVAILABLE'),
]:
 facts=copy.deepcopy(SAFE);facts.update(patch_values);called=[]
 result,report=invoke(['--prepare','/not-created'],facts,lambda *a:called.append(a))
 assert result==2 and wanted in report['codes'] and called==[], (patch_values,report)
`);
});

test('public services, reserved loopback services, containers and unsupported OS refuse preparation',()=>{
 python(String.raw`
blocked=[]
for port in [80,443,3478,40000,8080,5900,9222]:
 for address in ['0.0.0.0','::','194.87.254.123','172.17.0.1']:
  blocked.append(({'listeners':[{'protocol':'tcp','address':address,'port':port}]},'NON_SSH_PUBLIC_LISTENER'))
for port in [80,443,3478,40000]:
 blocked.append(({'listeners':[{'protocol':'tcp','address':'127.0.0.1','port':port}]},'RESERVED_SERVICE_LISTENER'))
blocked.extend([({'listeners':[{'protocol':'udp','address':'*','port':22}]},'NON_SSH_PUBLIC_LISTENER'),
 ({'docker_running':True},'RUNNING_DOCKER_CONTAINERS'),({'os_id':'debian'},'UNSUPPORTED_OS'),
 ({'os_version':'22.04'},'UNSUPPORTED_OS'),({'machine':'aarch64'},'UNSUPPORTED_PLATFORM')])
for changes,wanted in blocked:
 facts=copy.deepcopy(SAFE);facts.update(changes);called=[]
 result,report=invoke(['--prepare','/not-created'],facts,lambda *a:called.append(a))
 assert result==2 and wanted in report['codes'] and called==[], (changes,report)
`);
});

test('git requirement is reported separately after host checks, never installed by preflight',()=>{
 python(String.raw`
facts=copy.deepcopy(SAFE);facts['needs_tools']=['git']
result,report=invoke(['--check'],facts)
assert result==2 and report['host_checks_passed'] is True and report['prepare_ready'] is False
assert report['needs_tools']==['git'] and report['codes']==[]
facts['local_ips'].append('194.87.254.249')
result,report=invoke(['--check'],facts)
assert result==2 and 'KNOWN_PRODUCTION_HOST' in report['codes'] and report['needs_tools']==['git']
`);
});

test('Docker inspection refuses an inactive socket before any client could activate its daemon',()=>{
 python(String.raw`
import stat
from types import SimpleNamespace
def fake_stat(path,*args,**kwargs):
 if str(path)=='/run/docker.sock':return SimpleNamespace(st_mode=stat.S_IFSOCK,st_dev=1,st_ino=1)
 raise FileNotFoundError()
with patch.object(m,'process_names',return_value=set()),patch.object(m.Path,'stat',fake_stat),patch.object(m.socket,'socket',side_effect=AssertionError('must not connect')):
 try:m.docker_running()
 except m.StandFailure as failure:assert failure.code=='DOCKER_INVENTORY_UNAVAILABLE'
 else:raise AssertionError('inactive daemon was queried')
`);
});

test('target and unverified archive failures occur before creating directories or downloading',()=>{
 python(String.raw`
with tempfile.TemporaryDirectory(prefix='stand-preflight-test-') as parent:
 parent=pathlib.Path(parent);existing=parent/'existing';existing.mkdir()
 symlink=parent/'link';symlink.symlink_to(existing,target_is_directory=True)
 cache=parent/'fake-go.tar.gz';cache.write_bytes(b'not the official toolchain')
 cases=[([ '--prepare',str(existing)],'TARGET_ALREADY_EXISTS'),
        ([ '--prepare',str(symlink/'new')],'TARGET_PARENT_UNSAFE'),
        ([ '--prepare','relative/path'],'TARGET_MUST_BE_NEW_ABSOLUTE_PATH'),
        ([ '--prepare',str(parent/'new'),'--go-archive',str(cache)],'GO_ARCHIVE_HASH_MISMATCH')]
 for arguments,wanted in cases:
  before=sorted(str(path.relative_to(parent)) for path in parent.rglob('*'))
  with patch.object(m.urllib.request,'urlopen',side_effect=AssertionError('no download allowed')):
   result,report=invoke(arguments,SAFE)
  assert result==2 and report['codes']==[wanted],report
  assert before==sorted(str(path.relative_to(parent)) for path in parent.rglob('*'))
`);
});

test('ip/ss parsers reject malformed snapshots while accepting normal IPv4 and IPv6 SSH',()=>{
 python(String.raw`
addresses=m.parse_addresses(b'[{"addr_info":[{"family":"inet","local":"10.2.3.4"},{"family":"inet6","local":"::1"}]}]')
assert addresses==['10.2.3.4','::1']
listeners=m.parse_listeners(b'tcp LISTEN 0 128 [::]:22 [::]:*\nudp UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*\n')
facts=copy.deepcopy(SAFE);facts['listeners']=listeners
assert m.evaluate(facts)['prepare_ready'] is True
for function,raw,code in [(m.parse_addresses,b'{}','LOCAL_IP_INVENTORY_UNAVAILABLE'),
                         (m.parse_addresses,b'[]','LOCAL_IP_INVENTORY_UNAVAILABLE'),
                         (m.parse_listeners,b'garbled private service details','LISTENER_INVENTORY_UNAVAILABLE')]:
 try:function(raw)
 except m.StandFailure as failure:assert failure.code==code
 else:raise AssertionError('invalid inventory accepted')
`);
});

test('invalid CLI cannot override safety and internal failures do not expose exception secrets',()=>{
 python(String.raw`
for arguments in [['--unsafe'],['--check','--prepare','/new'],['--go-archive','/cache']]:
 result,report=invoke(arguments,SAFE)
 assert result==2 and report['codes']==['INVALID_ARGUMENTS']
def fail(*args):raise RuntimeError('SECRET_FROM_ENV_OR_REMOTE_RESPONSE')
result,report=invoke(['--prepare','/new'],SAFE,fail)
assert result==2 and report['codes']==['INTERNAL_ERROR']
assert 'SECRET' not in json.dumps(report)
`);
});

test('successful preparation is explicitly only binary preparation and preserves the preflight ordering',()=>{
 python(String.raw`
events=[]
def scan():events.append('scan');return SAFE
def prepare(root,archive):
 assert events==['scan'];events.append('prepare')
 assert str(root)=='/new/private/stand' and archive is None
output=io.StringIO();result=m.main(['--prepare','/new/private/stand'],scanner=scan,preparer=prepare,output=output)
report=json.loads(output.getvalue())
assert result==0 and events==['scan','prepare']
assert report['services_started'] is False and report['platform_connection_verified'] is False
assert report['status']=='prepared-binaries-only' and report['manifest']=='manifest.json'
`);
});

test('packaging keeps executable/help/manifest private even when compiler outputs start world-readable',()=>{
 python(String.raw`
with tempfile.TemporaryDirectory(prefix='stand-permissions-test-') as parent:
 root=pathlib.Path(parent)/'new'
 def fake_download(target):target.write_bytes(b'not used as a real archive in packaging-only test')
 def fake_extract(archive,target):
  (target/'go/bin').mkdir(parents=True)
  (target/'go/bin/go').write_bytes(b'not executed in packaging-only test')
 def fake_command(arguments,**options):
  if arguments[-1:] == ['version']:return b'go version go1.26.1 linux/amd64\n',b''
  if 'init' in arguments:pathlib.Path(arguments[-1]).mkdir();return b'',b''
  if 'checkout' in arguments:
   (pathlib.Path(options['cwd'])/'LICENSE').write_text('MIT License\n')
   return b'',b''
  if 'rev-parse' in arguments:return (m.UPSTREAM_COMMIT+'\n').encode(),b''
  if 'build' in arguments:
   target=pathlib.Path(arguments[arguments.index('-o')+1]);target.write_bytes(b'fixture executable');target.chmod(0o755)
   return b'',b''
  if arguments[-1:] == ['--help']:return b'',b'Usage: fixture --help\n'
  return b'',b''
 previous=os.umask(0o022)
 try:
  with patch.object(m,'download_archive',fake_download),patch.object(m,'extract_go',fake_extract),patch.object(m,'command',fake_command):
   result,report=invoke(['--prepare',str(root)],SAFE)
  current=os.umask(0o022);assert current==0o022,'prepare restored caller umask'
 finally:os.umask(previous)
 assert result==0 and report['services_started'] is False
 manifest=json.loads((root/'manifest.json').read_text())
 assert root.stat().st_mode&0o077==0
 for binary in manifest['binaries'].values():
  for relative in [binary['path'],binary['help_path']]:assert (root/relative).stat().st_mode&0o077==0
 assert (root/'manifest.json').stat().st_mode&0o077==0
`);
});
