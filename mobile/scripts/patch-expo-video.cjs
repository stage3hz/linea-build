// expo-video sets the shared iOS audio session to .playback/.moviePlayback whenever any player changes state
// (a silent round video looping in the chat, a circle mounting or pausing). While a voice message is
// recording the session is .playAndRecord, and that switch cut the microphone: every other take came out
// silent and ~1 s long, with a flat waveform. While the app records, expo-video now leaves the session alone;
// the voice recorder switches back to playback itself when the take ends.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../node_modules/expo-video');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (version !== '57.0.5') throw new Error(`Review the expo-video audio session patch for ${version}`);
const file = path.join(root, 'ios/VideoManager.swift');
const before = '    let audioSession = AVAudioSession.sharedInstance()\n    let audioMixingMode = findAudioMixingMode()';
const after = '    let audioSession = AVAudioSession.sharedInstance()\n    // Linea: never take the session away from a recording (voice messages, round videos).\n    if audioSession.category == .playAndRecord || audioSession.category == .record { return }\n    let audioMixingMode = findAudioMixingMode()';
const source = fs.readFileSync(file, 'utf8');
if (!source.includes(after)) {
  if (!source.includes(before)) throw new Error('expo-video audio session patch anchor changed: ios/VideoManager.swift');
  fs.writeFileSync(file, source.replace(before, after));
}
