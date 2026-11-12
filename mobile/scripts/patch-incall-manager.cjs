// react-native-incall-manager (the call's audio route) sets the iOS audio session's category for a call as
// «play and record» with NO options. Without the Bluetooth options iOS does not offer Bluetooth headphones as a
// route at all, so a call made with headphones connected came out of the phone itself (the earpiece or the speaker).
// Every place the library sets that category goes through one method; there the two Bluetooth options are added
// (hands-free for the microphone, A2DP for headphones that only play). Forcing the speaker still works: that is a
// port override on top of the category.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../node_modules/react-native-incall-manager');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (version !== '4.3.0') throw new Error(`Review the react-native-incall-manager Bluetooth patch for ${version}`);
const file = path.join(root, 'ios/RNInCallManager/RNInCallManager.m');
const before = '                     callerMemo:(NSString *)callerMemo\n{\n    @try {\n        if (options != 0) {\n            [_audioSession setCategory:audioCategory\n                           withOptions:options';
const after = '                     callerMemo:(NSString *)callerMemo\n{\n    // Linea: a call may use Bluetooth headphones (without these options iOS never routes to them).\n    if ([audioCategory isEqualToString:AVAudioSessionCategoryPlayAndRecord]) {\n        options |= AVAudioSessionCategoryOptionAllowBluetooth | AVAudioSessionCategoryOptionAllowBluetoothA2DP;\n    }\n    @try {\n        if (options != 0) {\n            [_audioSession setCategory:audioCategory\n                           withOptions:options';
const source = fs.readFileSync(file, 'utf8');
if (!source.includes(after)) {
  if (source.split(before).length !== 2) throw new Error('react-native-incall-manager Bluetooth patch anchor changed: ios/RNInCallManager/RNInCallManager.m');
  fs.writeFileSync(file, source.replace(before, after));
}
