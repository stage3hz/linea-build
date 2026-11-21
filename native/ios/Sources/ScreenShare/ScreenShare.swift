import LiveKitWebRTC
import Security
import UIKit

/// Screen sharing in a voice channel: the screen part of the reference's communities/voice.ts
/// (`startVoiceScreen`, `stopVoiceScreen`, `serveScreen`, `bindControl`, the SFU session).
///
/// - Watching: a person's screen arrives either as a direct copy over their own checked connection (the video slot
///   every connection reserves, DTLS-SRTP) or through the server's SFU, sealed frame by frame with a key that person
///   sent over that same checked connection (SfuSession.swift). Their channel (`screen-control`) says whether they
///   share and in which quality; only then is the picture shown.
/// - Sharing: the system's broadcast sheet starts this app's extension (native/ios/ScreenBroadcast), which sends the
///   frames to the app (ScreenCapture.swift). With the SFU, one sealed upload goes to the server for the viewers who
///   said they can open «lk» frames (`caps`); every other checked person gets a direct copy. Frames and keys go only
///   to connections that passed the end-to-end check, the others get theirs when they pass it. Nothing unencrypted
///   goes through any server.
///
/// RoomVoice.swift tells this class about every connection (`attach`, `verified`, `dropped`, the channel's texts);
/// the screens listen to `changed` (and RoomVoice.changed, posted too). Main queue only.
final class ScreenShare {
    static let shared = ScreenShare()
    static let changed = Notification.Name("invizent.screen-share")

    /// A person's screen as the screens show it.
    struct Screen {
        let peer: String
        let userId: String
        let quality: ScreenQuality
        let track: LKRTCVideoTrack?
    }

    /// The quality this phone shares in; nil when it does not.
    private(set) var sharing: ScreenQuality?
    /// A share is being started (the system's sheet is up, or the extension has not connected yet).
    private(set) var starting = false
    /// Why the last share did not start, in the reference's words (empty: nothing).
    private(set) var error = ""
    /// This phone's own screen while it shares («Твой экран»).
    private(set) var localTrack: LKRTCVideoTrack?

    private final class Held {
        weak var media: RoomPeerMedia?
        init(_ media: RoomPeerMedia) { self.media = media }
    }
    private var medias: [String: Held] = [:]
    private var checked = Set<String>()
    private var announced: [String: (active: Bool, quality: ScreenQuality)] = [:]
    private var meshTracks: [String: LKRTCVideoTrack] = [:]
    private var sfuTracks: [String: LKRTCVideoTrack] = [:]
    private var sfuPeers = Set<String>()
    private var pendingKeys: [String: (index: Int, raw: Data)] = [:]
    private var sfu: SfuSession?
    private var shareKey: (raw: Data, index: Int)?
    private var shareKeyIndex = 0
    private var viaSfu = false
    private var generation = 0
    private var capture: ScreenCaptureSource?
    private var pendingCapture: ScreenCaptureSource?
    #if targetEnvironment(simulator)
    private var demo = false
    private var demoScreens: [Screen] = []
    #endif

    private init() {
        NotificationCenter.default.addObserver(self, selector: #selector(event(_:)), name: Live.roomEvent, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(voiceMoved), name: RoomVoice.changed, object: nil)
    }

    private func changed() {
        NotificationCenter.default.post(name: ScreenShare.changed, object: nil)
        // The panel, the bar and the room's screen already follow the voice: they redraw with it.
        NotificationCenter.default.post(name: RoomVoice.changed, object: nil)
    }

    /// The screens of the people this phone is connected to, in the order of the room (`voice.peers.filter(p => p.screen)`).
    var screens: [Screen] {
        #if targetEnvironment(simulator)
        if demo { return demoScreens }
        #endif
        guard let voice = RoomVoice.shared.state else { return [] }
        var out: [Screen] = []
        for peer in voice.peers {
            if let said = announced[peer.peer] {
                // Shown once the person says they share: the copy through the server when there is one, else the direct copy.
                if said.active, let shown = sfuTracks[peer.peer] ?? meshTracks[peer.peer] { out.append(Screen(peer: peer.peer, userId: peer.userId, quality: said.quality, track: shown)) }
            } else if let shown = sfuTracks[peer.peer] {
                // A copy through the server before the person's channel said anything: 1080p, as the reference assumes.
                out.append(Screen(peer: peer.peer, userId: peer.userId, quality: .p1080, track: shown))
            }
        }
        return out
    }

    // MARK: What RoomVoice tells

    /// A new connection to a person (whatever was known of the old one is forgotten).
    func attach(_ peer: String, _ media: RoomPeerMedia) {
        medias[peer] = Held(media)
        checked.remove(peer)
        announced[peer] = nil
        meshTracks[peer] = nil
        media.onVideo = { [weak self, weak media] (track: LKRTCVideoTrack) -> Void in
            guard let self, let media, self.medias[peer]?.media === media else { return }
            self.meshTracks[peer] = track
            self.changed()
        }
        changed()
    }

    /// The person's channel opened: they hear whether this phone shares, and what it can open (`sendScreenState`, `sendCaps`).
    func channelOpened(_ peer: String) {
        sendState(to: peer)
        sendCaps(to: peer)
    }

    /// A text of the person's channel. True when it was about the screen (and is not passed on).
    func message(_ peer: String, _ text: String, verified: Bool) -> Bool {
        guard text.utf16.count <= 512, let data = text.data(using: .utf8),
              let extra = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let type = extra["type"] as? String else { return false }
        switch type {
        case "caps":
            // The person can watch through the server; their keys travel only over this channel.
            if extra["lk"] as? Bool == true, sfu != nil {
                sfuPeers.insert(peer)
                // Already sharing: this viewer now gets the picture from the server — the direct copy stops.
                if localTrack != nil, viaSfu, shareKey != nil, checked.contains(peer) {
                    sendKey(to: peer)
                    medias[peer]?.media?.setScreen(nil, maxBitrate: nil)
                }
            }
            return true
        case "screenKey":
            guard let index = (extra["keyId"] as? NSNumber)?.intValue, index >= 0, index < 256,
                  let key = extra["key"] as? String, key.count <= 44, let raw = Data(base64Encoded: key), raw.count == 16 else { return true }
            if verified { sfu?.setPeerKey(peer, index: index, raw: raw) } else { pendingKeys[peer] = (index: index, raw: raw) }
            return true
        case "screen":
            guard let said = ScreenShareModel.control(text) else { return true }
            announced[peer] = said
            changed()
            return true
        default:
            return false
        }
    }

    /// The connection is proven end to end: the frame key that waited, and the screen (`onVerified`).
    func verified(_ peer: String) {
        checked.insert(peer)
        if let key = pendingKeys.removeValue(forKey: peer) { sfu?.setPeerKey(peer, index: key.index, raw: key.raw) }
        guard localTrack != nil, sharing != nil else { return }
        if viaSfu && sfuPeers.contains(peer) { sendKey(to: peer) } else { serve(peer) }
    }

    /// The connection came up: the screen's cap is set again for it.
    func connected(_ peer: String) {
        guard localTrack != nil, sharing != nil, checked.contains(peer), !(viaSfu && sfuPeers.contains(peer)) else { return }
        serve(peer)
    }

    /// The person left, or their connection was refused.
    func dropped(_ peer: String) {
        medias[peer] = nil
        checked.remove(peer)
        announced[peer] = nil
        meshTracks[peer] = nil
        sfuTracks[peer] = nil
        sfuPeers.remove(peer)
        pendingKeys[peer] = nil
        sfu?.forget(peer)
        changed()
    }

    /// This phone left the room (or the account): nothing of the screens goes on.
    func voiceEnded() {
        #if targetEnvironment(simulator)
        if demo { return }
        #endif
        stop()
        sfu?.close()
        sfu = nil
        medias = [:]
        checked = []
        announced = [:]
        meshTracks = [:]
        sfuTracks = [:]
        sfuPeers = []
        pendingKeys = [:]
        error = ""
        changed()
    }

    @objc private func voiceMoved() {
        #if targetEnvironment(simulator)
        if demo && RoomVoice.shared.state == nil { demo = false; demoScreens = []; sharing = nil; starting = false; localTrack = nil; error = "" }
        if demo { return }
        #endif
        if RoomVoice.shared.state == nil && (sfu != nil || sharing != nil || starting || !medias.isEmpty) { voiceEnded() }
    }

    // MARK: The live line

    @objc private func event(_ note: Notification) {
        guard let data = note.userInfo?["event"] as? [String: Any], let type = data["type"] as? String else { return }
        #if targetEnvironment(simulator)
        if demo { return }
        #endif
        if type.hasPrefix("sfu.") {
            sfu?.handle(data)
            return
        }
        guard let voice = RoomVoice.shared.state else { return }
        if type == "voice.joined", data["channelId"] as? String == voice.roomId, voice.communityId != nil, data["sfu"] as? Bool == true, sfu == nil {
            // Many viewers through the server (community channels only; rooms are a mesh).
            let session = SfuSession(send: { (frame: [String: Any]) -> Bool in RoomVoice.shared.messenger?.live.send(frame) ?? false })
            session.onRemote = { [weak self] (peer: String, track: LKRTCVideoTrack?) -> Void in
                guard let self else { return }
                self.sfuTracks[peer] = track
                self.changed()
            }
            sfu = session
            session.start { [weak self, weak session] (fine: Bool) -> Void in
                guard let self, let session, self.sfu === session else { return }
                if fine {
                    for peer in self.medias.keys { self.sendCaps(to: peer) }
                } else {
                    session.close()
                    self.sfu = nil
                }
            }
        } else if type == "ready" {
            // The live line reconnected: the server forgot this phone (and its SFU transports); it walks in again.
            stop()
            sfu?.close()
            sfu = nil
            sfuPeers = []
            sfuTracks = [:]
            changed()
        }
    }

    // MARK: Messages to the people

    private func say(_ peer: String, _ value: [String: Any]) {
        guard let text = ScreenShareModel.json(value) else { return }
        _ = medias[peer]?.media?.send(text)
    }

    private func sendState(to peer: String) {
        say(peer, ["type": "screen", "active": sharing != nil, "quality": (sharing ?? .p720).rawValue])
    }

    /// `sfu`: opens legacy-layout SFU frames (computers only); `lk`: opens «lk» frames (this phone's FrameCryptor).
    private func sendCaps(to peer: String) {
        say(peer, ["type": "caps", "sfu": false, "lk": sfu != nil])
    }

    private func sendKey(to peer: String) {
        guard let key = shareKey else { return }
        say(peer, ["type": "screenKey", "keyId": key.index, "key": key.raw.base64EncodedString()])
    }

    /// A direct copy of this phone's screen for one checked person (`serveScreen`).
    private func serve(_ peer: String) {
        guard let track = localTrack, let quality = sharing else { return }
        medias[peer]?.media?.setScreen(track, maxBitrate: quality.maxBitrate)
    }

    // MARK: Sharing

    /// «720p · 60 FPS» / «1080p · 60 FPS»: explicit consent in the system's sheet for every new share; never resumed
    /// by itself. `done` gets nil, or the words that say why not.
    func start(_ quality: ScreenQuality, done: @escaping (String?) -> Void) {
        guard let voice = RoomVoice.shared.state, voice.status == "connected" else { return done("Сначала подключись к голосовому каналу.") }
        guard !starting, sharing == nil else { return done("Демонстрация уже запускается или включена.") }
        generation += 1
        let attempt = generation
        starting = true
        error = ""
        changed()
        let fail: (String) -> Void = { [weak self] (words: String) -> Void in
            guard let self else { return }
            self.stop()
            self.error = words
            self.changed()
            done(words)
        }
        do {
            try ScreenBroadcast.configure(quality)
            guard let made = ScreenCaptureSource(path: try ScreenBroadcast.socketPath()) else { return fail("Не удалось включить демонстрацию.") }
            pendingCapture = made
            try ScreenBroadcast.showPicker()
        } catch let problem as ScreenShareError {
            return fail(problem.words)
        } catch {
            return fail("Не удалось включить демонстрацию.")
        }
        wait(attempt, quality: quality, tries: 480, fail: fail, done: done)
    }

    /// `confirmScreenCapture`: up to two minutes for the person to press «Начать трансляцию».
    private func wait(_ attempt: Int, quality: ScreenQuality, tries: Int, fail: @escaping (String) -> Void, done: @escaping (String?) -> Void) {
        guard attempt == generation, RoomVoice.shared.state != nil else { return }
        if ScreenBroadcast.isActive() { return began(attempt, quality: quality, done: done) }
        guard tries > 0 else { return fail("Запуск демонстрации отменён или не подтверждён.") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.wait(attempt, quality: quality, tries: tries - 1, fail: fail, done: done)
        }
    }

    private func began(_ attempt: Int, quality: ScreenQuality, done: @escaping (String?) -> Void) {
        guard attempt == generation, let made = pendingCapture else { return }
        pendingCapture = nil
        capture = made
        made.onEnded = { [weak self, weak made] in
            guard let self, let made, self.capture === made else { return }
            self.stop()
        }
        localTrack = made.track
        sharing = quality
        error = ""
        changed()
        let finish: (Bool) -> Void = { [weak self] (sfuFine: Bool) -> Void in
            guard let self, attempt == self.generation else { return }
            self.viaSfu = sfuFine
            // Direct copies only for the checked people the server does not serve.
            for peer in self.medias.keys where self.checked.contains(peer) && !(sfuFine && self.sfuPeers.contains(peer)) { self.serve(peer) }
            self.starting = false
            for peer in self.medias.keys { self.sendState(to: peer) }
            self.changed()
            done(nil)
        }
        // Through the SFU: one sealed upload for all its viewers; key index 0..15 (the FrameCryptor's ring), a new key per share.
        guard let session = sfu else { return finish(false) }
        shareKeyIndex = (shareKeyIndex + 1) % ScreenFrameKeys.ring
        var raw = Data(count: 16)
        let status = raw.withUnsafeMutableBytes { (bytes: UnsafeMutableRawBufferPointer) -> Int32 in SecRandomCopyBytes(kSecRandomDefault, 16, bytes.baseAddress!) }
        guard status == errSecSuccess else { return finish(false) }
        shareKey = (raw: raw, index: shareKeyIndex)
        for peer in medias.keys where sfuPeers.contains(peer) && checked.contains(peer) { sendKey(to: peer) }
        session.publish(made.track, raw: raw, keyIndex: shareKeyIndex, maxBitrate: quality.maxBitrate) { (fine: Bool) -> Void in finish(fine) }
    }

    /// «Остановить демонстрацию» (and «Отменить запуск»): the extension is told to end, every copy stops.
    func stop() {
        #if targetEnvironment(simulator)
        if demo {
            sharing = nil
            starting = false
            localTrack = nil
            changed()
            return
        }
        #endif
        generation += 1
        let wasOn = sharing != nil || starting || capture != nil || pendingCapture != nil
        if wasOn { ScreenBroadcast.stop() }
        pendingCapture?.stop()
        pendingCapture = nil
        capture?.stop()
        capture = nil
        for held in medias.values { held.media?.setScreen(nil, maxBitrate: nil) }
        sfu?.unpublish()
        shareKey = nil
        viaSfu = false
        sharing = nil
        starting = false
        localTrack = nil
        for peer in medias.keys { sendState(to: peer) }
        if wasOn { changed() }
    }

    /// The notice under the buttons was read.
    func clearError() {
        guard !error.isEmpty else { return }
        error = ""
        changed()
    }

    // MARK: The simulator's samples

    #if targetEnvironment(simulator)
    /// A sample frame for the screens (-screendemo): no media at all.
    private(set) var demoFrames: [String: UIImage] = [:]

    func showDemo(screens: [(peer: String, userId: String, quality: ScreenQuality)], sharing: ScreenQuality?, starting: Bool, error: String) {
        demo = true
        demoScreens = screens.map { (item: (peer: String, userId: String, quality: ScreenQuality)) -> Screen in Screen(peer: item.peer, userId: item.userId, quality: item.quality, track: nil) }
        for item in screens { demoFrames[item.peer] = ScreenShareDemo.frame(desktop: true) }
        demoFrames["self"] = ScreenShareDemo.frame(desktop: false)
        self.sharing = sharing
        self.starting = starting
        self.error = error
        changed()
    }

    var isDemo: Bool { demo }
    #endif
}
