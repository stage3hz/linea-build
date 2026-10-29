const guard = require(process.argv[2]);
const extra = ['QUERY_ALL_PACKAGES', 'PACKAGE_USAGE_STATS', 'MANAGE_EXTERNAL_STORAGE', 'READ_CONTACTS', 'WRITE_CONTACTS', 'READ_CALENDAR', 'WRITE_CALENDAR'];
const permissions = ['ACCESS_COARSE_LOCATION','ACCESS_FINE_LOCATION','ACCESS_BACKGROUND_LOCATION','ACCESS_MEDIA_LOCATION','SYSTEM_ALERT_WINDOW',...extra].map(x=>'android.permission.'+x);
const base = () => ({name:'Synthetic fixture',slug:'synthetic-fixture',android:{blockedPermissions:[...permissions]},ios:{}});
const cases = [
 ['NSLocation property', c => c.ios.infoPlist={NSLocationWhenInUseUsageDescription:'Synthetic'}],
 ['background location', c => c.ios.infoPlist={UIBackgroundModes:['audio','location']}],
 ['installed app query schemes', c => c.ios.infoPlist={LSApplicationQueriesSchemes:[]}],
 ['explicit application groups', c => c.ios.entitlements={'com.apple.security.application-groups':[]}],
 ['explicit keychain groups', c => c.ios.entitlements={'keychain-access-groups':[]}],
 ['missing Android overlay block', c => c.android.blockedPermissions=c.android.blockedPermissions.filter(x=>x!=='android.permission.SYSTEM_ALERT_WINDOW')],
];
for(const key of ['UIFileSharingEnabled','LSSupportsOpeningDocumentsInPlace']) {
 for(const value of [true,1,'YES',null]) cases.push([`${key} rejects ${JSON.stringify(value)}`, c=>c.ios.infoPlist={[key]:value}]);
}
for(const permission of extra) cases.push([`missing Android ${permission} block`,c=>c.android.blockedPermissions=c.android.blockedPermissions.filter(x=>x!==`android.permission.${permission}`)]);
const results=[];
for(const [name, mutate] of cases) {
 const c=base(); mutate(c); let refused=false;
 try{guard(c)}catch(e){if(!e.message.startsWith('Linea privacy guard:')) throw e;refused=true;}
 results.push({name,expected:'refuse',passed:refused});
}
for(const [name, info] of [
 ['ordinary audio mode with no shared entitlements',{UIBackgroundModes:['audio']}],
 ['explicit boolean false for Documents sharing flags',{UIFileSharingEnabled:false,LSSupportsOpeningDocumentsInPlace:false}],
]) {
 const c=base();c.ios.infoPlist=info;const result=guard(c);
 results.push({name,expected:'accept',passed:typeof result.mods?.ios?.finalized==='function'});
}
console.log(JSON.stringify({passed:results.filter(x=>x.passed).length,total:results.length,results},null,2));
if(results.some(x=>!x.passed))process.exitCode=1;
