const { withInfoPlist, withEntitlementsPlist, withAndroidManifest, withXcodeProject, createRunOncePlugin } = require('expo/config-plugins');
const fs = require('node:fs'); const path = require('node:path'); const plist = require('@expo/plist').default;
function withScreenBroadcast(config) {
  const bundle = config.ios.bundleIdentifier, group = process.env.IOS_SCREEN_APP_GROUP || `group.${bundle}.screen`;
  config = withInfoPlist(config, c => { c.modResults.RTCAppGroupIdentifier = group; c.modResults.RTCScreenSharingExtension = `${bundle}.ScreenBroadcast`; return c; });
  config = withEntitlementsPlist(config, c => { c.modResults['com.apple.security.application-groups'] = [...new Set([...(c.modResults['com.apple.security.application-groups'] || []),group])]; return c; });
  config = withAndroidManifest(config, c => {
    c.modResults.manifest['uses-permission'] ||= [];
    for (const name of ['android.permission.FOREGROUND_SERVICE','android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION']) if (!c.modResults.manifest['uses-permission'].some(v => v.$['android:name'] === name)) c.modResults.manifest['uses-permission'].push({ $: { 'android:name': name } });
    return c;
  });
  return withXcodeProject(config, c => {
    const root = c.modRequest.platformProjectRoot, name = 'ScreenBroadcast', folder = path.join(root,name), project = c.modResults;
    fs.mkdirSync(folder,{recursive:true}); fs.copyFileSync(path.join(__dirname,'screen-broadcast','SampleHandler.swift'),path.join(folder,'SampleHandler.swift'));
    fs.writeFileSync(path.join(folder,'Info.plist'),plist.build({ CFBundleDevelopmentRegion:'en', CFBundleExecutable:'$(EXECUTABLE_NAME)', CFBundleIdentifier:'$(PRODUCT_BUNDLE_IDENTIFIER)', CFBundleInfoDictionaryVersion:'6.0', CFBundleName:name, CFBundlePackageType:'XPC!', CFBundleShortVersionString:config.version, CFBundleVersion:'1', RTCAppGroupIdentifier:group, NSExtension:{ NSExtensionPointIdentifier:'com.apple.broadcast-services-upload', NSExtensionPrincipalClass:'$(PRODUCT_MODULE_NAME).SampleHandler', NSExtensionAttributes:{ RPBroadcastProcessMode:'RPBroadcastProcessModeSampleBuffer' } } }));
    fs.writeFileSync(path.join(folder,'ScreenBroadcast.entitlements'),plist.build({ 'com.apple.security.application-groups':[group] }));
    if (project.pbxTargetByName(name)) return c;
    const target = project.addTarget(name,'app_extension',name,`${bundle}.${name}`);
    const nativeGroup = project.addPbxGroup([],name,name); project.addToPbxGroup(nativeGroup.uuid,project.getFirstProject().firstProject.mainGroup);
    project.addBuildPhase(['SampleHandler.swift'],'PBXSourcesBuildPhase','Sources',target.uuid,undefined,name); project.addBuildPhase([],'PBXFrameworksBuildPhase','Frameworks',target.uuid);
    for (const [id, ref] of Object.entries(project.pbxFileReferenceSection())) if (ref && typeof ref === 'object' && String(ref.name).replaceAll('\"','') === 'SampleHandler.swift') { ref.path = JSON.stringify(name + '/SampleHandler.swift'); ref.sourceTree = 'SOURCE_ROOT'; nativeGroup.pbxGroup.children.push({ value: id, comment: 'SampleHandler.swift' }); }
    for (const entry of Object.values(project.pbxXCBuildConfigurationSection())) if (entry && typeof entry === 'object' && entry.buildSettings?.PRODUCT_NAME === '"ScreenBroadcast"') Object.assign(entry.buildSettings, { INFOPLIST_FILE:'ScreenBroadcast/Info.plist', CODE_SIGN_ENTITLEMENTS:'ScreenBroadcast/ScreenBroadcast.entitlements', SWIFT_VERSION:'5.0', IPHONEOS_DEPLOYMENT_TARGET:'16.4', APPLICATION_EXTENSION_API_ONLY:'YES', SKIP_INSTALL:'YES', TARGETED_DEVICE_FAMILY:'"1,2"', GENERATE_INFOPLIST_FILE:'NO' });
    return c;
  });
}
module.exports = createRunOncePlugin(withScreenBroadcast,'invizent-screen-broadcast','0.14.0');
