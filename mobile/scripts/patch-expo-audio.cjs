// expo-audio deactivates the shared iOS audio session 100 ms after ANY player's pause() or end of playback
// (AudioModule.deactivateSession) when no player is playing; recorders are not counted. Deactivating a
// session with running I/O stops it, so the AVAudioRecorder went deaf while expo-audio's own timer kept
// counting: voice messages came out ~0.1–1 s long, silent, with metering at −160 dB (no waveform).
// The voice recorder stopped the music player (pause) right before record(), so this hit every take.
// While the session is in a recording category the deactivation is skipped; the voice recorder switches
// back to playback itself when the take ends.
// The same deactivation also hit videos: opening one stops the music player (pause), and 100 ms later the session
// went down under the video that had just started — it froze on its first frame or stayed black. expo-video
// plays in the .moviePlayback mode, so the deactivation is skipped in that mode too.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../node_modules/expo-audio');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (version !== '57.0.5') throw new Error(`Review the expo-audio audio session patch for ${version}`);
const file = path.join(root, 'ios/AudioModule.swift');
const before = '      guard !hasActivePlayables else {\n        return\n      }\n      do {\n        try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])';
const earlier = '      guard !hasActivePlayables else {\n        return\n      }\n      // Linea: never switch the microphone off under a recording (voice messages, round videos).\n      let category = AVAudioSession.sharedInstance().category\n      if category == .playAndRecord || category == .record { return }\n      do {\n        try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])';
const after = '      guard !hasActivePlayables else {\n        return\n      }\n      // Linea: never switch the microphone off under a recording (voice messages, round videos).\n      let category = AVAudioSession.sharedInstance().category\n      if category == .playAndRecord || category == .record { return }\n      // Linea: nor under a video (expo-video plays in the .moviePlayback mode): the deactivation paused a video that had just started.\n      if AVAudioSession.sharedInstance().mode == .moviePlayback { return }\n      do {\n        try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])';
const source = fs.readFileSync(file, 'utf8');
if (!source.includes(after)) {
  // A tree patched by the earlier version of this script is brought up to date as well.
  const from = source.includes(earlier) ? earlier : before;
  if (!source.includes(from)) throw new Error('expo-audio audio session patch anchor changed: ios/AudioModule.swift');
  fs.writeFileSync(file, source.replace(from, after));
}
