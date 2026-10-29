const { withAppBuildGradle, withProjectBuildGradle, withGradleProperties, withPodfile, createRunOncePlugin } = require('expo/config-plugins');

const VERSION = '0.106.0';
// Published SHA-256 of the official release's prebuilt iOS FFI archive.
const IOS_SHA256 = 'ddfa5ac6fd6e0da9ebe4eb23890af048140aec1a3e916d3eccadc1036627152f';
function tagged(contents, name, body, prefix = '//') {
  const start = `${prefix} @linea-signal ${name} begin`, end = `${prefix} @linea-signal ${name} end`;
  const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = `${start}\n${body}\n${end}`;
  const pattern = new RegExp(`${escaped(start)}[\\s\\S]*?${escaped(end)}`, 'g');
  return pattern.test(contents) ? contents.replace(pattern, block) : `${contents.trimEnd()}\n\n${block}\n`;
}
function withLineSignal(config) {
  config = withGradleProperties(config, value => {
    value.modResults = value.modResults.filter(item => item.type !== 'property' || !['android.kotlinVersion', 'android.minSdkVersion'].includes(item.key));
    value.modResults.push({type:'property',key:'android.kotlinVersion',value:'2.2.20'},{type:'property',key:'android.minSdkVersion',value:'26'});
    return value;
  });
  config = withProjectBuildGradle(config, value => {
    if (value.modResults.language !== 'groovy') throw new Error('LineaSignal requires a Groovy Expo Android project.');
    value.modResults.contents = tagged(value.modResults.contents, 'repository', `allprojects {
  repositories {
    maven {
      url 'https://build-artifacts.signal.org/libraries/maven/'
      content { includeGroup 'org.signal' }
    }
  }
}`);
    return value;
  });
  config = withAppBuildGradle(config, value => {
    if (value.modResults.language !== 'groovy') throw new Error('LineaSignal requires a Groovy Expo Android application.');
    value.modResults.contents = tagged(value.modResults.contents, 'java21', `android {
  defaultConfig { minSdkVersion 26 }
  compileOptions {
    sourceCompatibility JavaVersion.VERSION_17
    targetCompatibility JavaVersion.VERSION_17
    coreLibraryDesugaringEnabled true
  }
  kotlinOptions { jvmTarget = '17' }
  packagingOptions {
    resources {
      excludes += ['libsignal_jni*.dylib', 'signal_jni*.dll', 'libsignal_jni*.so']
    }
  }
}
dependencies { coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.5' }`);
    return value;
  });
  config = withPodfile(config, value => {
    const declaration = `  # @linea-signal pod begin\n  pod 'LibSignalClient', :git => 'https://github.com/signalapp/libsignal.git', :tag => 'v${VERSION}'\n  # @linea-signal pod end`;
    let contents = value.modResults.contents;
    const old = /^[ \t]*# @linea-signal pod begin[\s\S]*?^[ \t]*# @linea-signal pod end/m;
    if (old.test(contents)) contents = contents.replace(old, declaration);
    else {
      if (!/^[ \t]*use_expo_modules!.*$/m.test(contents)) throw new Error('Cannot locate the Expo target in Podfile.');
      contents = contents.replace(/(^[ \t]*use_expo_modules!.*$)/m, `$1\n${declaration}`);
    }
    value.modResults.contents = tagged(contents, 'ffi-checksum', `ENV['LIBSIGNAL_FFI_PREBUILD_CHECKSUM'] = '${IOS_SHA256}'`, '#');
    // This assignment must execute before CocoaPods evaluates dependencies.
    const checksumBlock = /^# @linea-signal ffi-checksum begin[\s\S]*?^# @linea-signal ffi-checksum end\n?/m;
    const match = value.modResults.contents.match(checksumBlock);
    if (match) value.modResults.contents = `${match[0]}\n${value.modResults.contents.replace(checksumBlock, '')}`;
    return value;
  });
  return config;
}
module.exports = createRunOncePlugin(withLineSignal, 'linea-signal', '0.3.0');
