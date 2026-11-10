// expo-audio deactivates the shared iOS audio session 100 ms after ANY player's pause() or end of playback
// (AudioModule.deactivateSession) when no player is playing; recorders are not counted. Deactivating a
// session with running I/O stops it, so the AVAudioRecorder went deaf while expo-audio's own timer kept
// counting: voice messages came out ~0.1–1 s long, silent, with metering at −160 dB (no waveform).
// The voice recorder stopped the music player (pause) right before record(), so this hit every take.
// While the session is in a recording category the deactivation is skipped; the voice recorder switches
// back to playback itself when the take ends.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../node_modules/expo-audio');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (version !== '57.0.5') throw new Error(`Review the expo-audio audio session patch for ${version}`);
const file = path.join(root, 'ios/AudioModule.swift');
const before = '      guard !hasActivePlayables else {\n        return\n      }\n      do {\n        try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])';
const after = '      guard !hasActivePlayables else {\n        return\n      }\n      // Linea: never switch the microphone off under a recording (voice messages, round videos).\n      let category = AVAudioSession.sharedInstance().category\n      if category == .playAndRecord || category == .record { return }\n      do {\n        try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])';
const source = fs.readFileSync(file, 'utf8');
if (!source.includes(after)) {
  if (!source.includes(before)) throw new Error('expo-audio audio session patch anchor changed: ios/AudioModule.swift');
  fs.writeFileSync(file, source.replace(before, after));
}
