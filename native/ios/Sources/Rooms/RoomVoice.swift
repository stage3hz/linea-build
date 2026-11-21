import AVFoundation
import UIKit

/// Somebody this phone is connected to inside the room: `peer` is the id the server gave that person's connection
/// (one person may be inside from two devices), `connected` — the voice is flowing.
struct RoomVoicePeer {
    let peer: String
    let userId: String
    var muted: Bool
    var connected: Bool
}

/// The room this phone is inside, as the screens show it (the reference's `VoiceState` for a room).
struct RoomVoiceState {
    let roomId: String
    var name: String
    /// "connecting" or "connected".
    var status: String
    var muted = false
    /// The sound is on the loudspeaker (false: the earpiece, or headphones when they are connected).
    var speaker: Bool
    var peers: [RoomVoicePeer] = []
    var error = ""
    /// The worst link among the people this phone is connected to: "good", "weak" or "bad".
    var link = "good"
}

/// The voice of a room: the reference's communities/voice.ts, as far as a room uses it.
///
/// - A room is a full mesh, up to twelve people: this phone has its own connection (WebRTC, DTLS-SRTP) to every
///   person inside; the sound goes phone to phone, a relay (TURN) only forwards ciphertext. The server introduces
///   the devices: it relays the offers and answers (`voice.signal`) over the live line, and nothing else.
/// - The newcomer calls everyone who is already inside. The offer and the answer travel once, with the addresses
///   already in them (non-trickle ICE).
/// - The offers and answers go through the server in the clear, so the server could put itself in the middle.
///   Every connection is therefore checked end to end: each side sends the other's very device a short note
///   encrypted with Signal (`voice.auth`) naming the two DTLS fingerprints it sees. Until the other side's note
///   matches the connection this phone really made, its microphone is not put into that connection and nothing
///   that arrives over it is played; a wrong note, or none in twenty seconds, and the connection is closed.
/// - A checked connection that drops is restarted (ICE restart) over the same signalling; the restart must carry
///   the very fingerprints that were checked.
/// - After the live line reconnects the server no longer knows this phone is inside: it walks in again.
///
/// The rules are the shared core's (RoomRules, CallRules); the media is RoomMedia.swift; this class keeps the
/// order. No CallKit and nothing from a closed app: a room is entered while the app is open (it goes on in the
/// background once entered — the app's audio keeps it alive). Main queue only.
final class RoomVoice {
    static let shared = RoomVoice()
    /// Posted on the main queue whenever the room this phone is inside (or the fact that it is in one) changed.
    static let changed = Notification.Name("invizent.room-voice")

    private(set) var state: RoomVoiceState? {
        didSet { NotificationCenter.default.post(name: RoomVoice.changed, object: nil) }
    }
    /// Why the last attempt to walk in ended, in the server's words; empty when it did not fail.
    private(set) var lastError = ""
    /// The room the last failed attempt was for (its screen shows `lastError`; another room's does not).
    private(set) var lastErrorRoom = ""

    /// Music for everyone (RoomMusic.swift): a text of a checked person's peer-to-peer channel, and a person
    /// whose channel has just become usable.
    var onPeerText: ((String, String) -> Void)?
    var onPeerReady: ((String) -> Void)?
    /// This phone is about to leave the room (its connections are still open): the last word to the others.
    var onLeaving: (() -> Void)?

    private weak var messenger: Messenger?
    private var microphone: RoomMicrophone?
    private var iceServers: [[String: Any]] = []
    private var ownDevice = ""
    private var selfPeer: String?
    private var joining = 0
    private var connections: [String: RoomPeerMedia] = [:]
    private var peerInfo: [String: (userId: String, device: String?)] = [:]
    private var verified = Set<String>()
    private var authSdp: [String: (local: String, remote: String, media: RoomPeerMedia)] = [:]
    private var pendingNotes: [String: [String: Any]] = [:]
    private var authTimers: [String: Timer] = [:]
    // Automatic reconnection of a checked connection: the link's state (the core's), its timer, when this phone
    // last sent a restart offer.
    private var links: [String: (link: [String: Any]?, timer: Timer?, pendingAt: Double)] = [:]
    // The link's grade per person: the last sample of its statistics, the grade and how long it has been calm.
    private var grades: [String: (grade: String, calm: Int, sample: [String: Any]?)] = [:]
    private var linkTimer: Timer?
    private var beat: Timer?
    private var network: CallNetwork?
    #if targetEnvironment(simulator)
    /// The simulator's samples (-roomsdemo): the screens without an account, a server or any media.
    private var demo = false
    private var demoSpeaking = Set<String>()
    #endif

    private init() {
        NotificationCenter.default.addObserver(self, selector: #selector(event(_:)), name: Live.roomEvent, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(callMoved), name: Calls.changed, object: nil)
    }

    private static var gatherTimeout: TimeInterval {
        (((Core.view("callRules", []) as? [String: Any])?["gatherTimeoutMs"] as? NSNumber)?.doubleValue ?? 3_000) / 1000
    }

    /// Whether the phone's sound goes to something worn or plugged in (anything but its own loudspeaker and earpiece).
    static var headphones: Bool {
        for output in AVAudioSession.sharedInstance().currentRoute.outputs {
            if output.portType != .builtInSpeaker && output.portType != .builtInReceiver { return true }
        }
        return false
    }

    private func patch(_ change: (inout RoomVoiceState) -> Void) {
        guard var current = state else { return }
        change(&current)
        state = current
    }

    private func send(_ frame: [String: Any]) -> Bool { messenger?.live.send(frame) ?? false }

    // MARK: Walking in and out

    /// Walks into the room: the microphone opens and the others hear this phone once each connection is checked.
    /// `done` gets nil, or the words that say why not. The microphone is asked for here, the first time.
    func join(_ messenger: Messenger, roomId: String, name: String, done: @escaping (String?) -> Void) {
        if state?.roomId == roomId { return done(nil) }
        // A one-to-one call and a room share the phone's microphone and its sound: one at a time.
        if let call = Calls.shared.call, !call.isOver { return done("Сначала заверши звонок.") }
        if state != nil { leave() }
        joining += 1
        let attempt = joining
        lastError = ""
        CallAudio.allow(video: false) { [weak self] (words: String?) -> Void in
            guard let self, self.joining == attempt else { return done(nil) }
            if let words { return done(words.replacingOccurrences(of: "чтобы звонить", with: "чтобы зайти в комнату")) }
            messenger.callIceServers { [weak self] (servers: [[String: Any]]?) -> Void in
                guard let self, self.joining == attempt else { return done(nil) }
                // Without the server's list: the public address finder alone, as the reference does.
                self.iceServers = servers ?? [["urls": ["stun:stun.l.google.com:19302"]]]
                // This phone's encryption device: the others seal their notes for exactly this device.
                messenger.crypto.run({ (crypto: CryptoService) -> String? in
                    _ = crypto.callNow("initialize")
                    guard case .success(let value) = crypto.callNow("deviceId") else { return nil }
                    return value as? String
                }, done: { [weak self] (device: String?) -> Void in
                    guard let self, self.joining == attempt else { return done(nil) }
                    guard let device, !device.isEmpty else { return done("Шифрование ещё не готово. Попробуй ещё раз.") }
                    if let call = Calls.shared.call, !call.isOver { return done("Сначала заверши звонок.") }
                    self.begin(messenger, roomId: roomId, name: name, device: device, done: done)
                })
            }
        }
    }

    private func begin(_ messenger: Messenger, roomId: String, name: String, device: String, done: @escaping (String?) -> Void) {
        self.messenger = messenger
        ownDevice = device
        CallAudio.start(video: false)
        // A room sounds on the loudspeaker, as in the reference — unless headphones are on.
        let speaker = !RoomVoice.headphones
        CallAudio.route(speaker ? true : nil, video: false)
        microphone = RoomMicrophone()
        let watch = CallNetwork()
        watch.onChange = { [weak self] in
            guard let self else { return }
            // Wi-Fi ↔ mobile or a new address: ICE is restarted with every checked person at once.
            for (peer, media) in self.connections { self.feedLink(peer, media, ["kind": "network"]) }
        }
        watch.start()
        network = watch
        messenger.live.heldByCall = true
        state = RoomVoiceState(roomId: roomId, name: name, status: "connecting", speaker: speaker)
        linkTimer = Timer.scheduledTimer(withTimeInterval: RoomRules.linkPoll, repeats: true) { [weak self] (_: Timer) -> Void in self?.checkLinks() }
        beat = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] (_: Timer) -> Void in
            guard let self else { return }
            for media in self.connections.values { media.tellState() }
        }
        guard send(["type": "voice.join", "roomId": roomId, "device": device]) else {
            cleanup()
            return done("Нет соединения с сервером.")
        }
        done(nil)
    }

    /// Walks out: the others are told, every connection is closed, the microphone released.
    func leave() {
        guard state != nil else { return }
        #if targetEnvironment(simulator)
        if demo {
            demo = false
            state = nil
            return
        }
        #endif
        _ = send(["type": "voice.leave"])
        cleanup()
    }

    /// The account was left: nothing of it goes on.
    func stop() {
        joining += 1
        leave()
        messenger = nil
        lastError = ""
    }

    private func cleanup() {
        if state != nil { onLeaving?() }
        for media in connections.values { media.close() }
        connections = [:]
        for timer in authTimers.values { timer.invalidate() }
        authTimers = [:]
        for entry in links.values { entry.timer?.invalidate() }
        links = [:]
        grades = [:]
        verified = []
        authSdp = [:]
        pendingNotes = [:]
        peerInfo = [:]
        selfPeer = nil
        linkTimer?.invalidate()
        linkTimer = nil
        beat?.invalidate()
        beat = nil
        network?.stop()
        network = nil
        microphone = nil
        // A one-to-one call that has just begun owns the phone's sound and the line from here on.
        let callOn = Calls.shared.call.map { (call: CallState) -> Bool in !call.isOver } ?? false
        if !callOn {
            CallAudio.stop()
            messenger?.live.heldByCall = false
        }
        state = nil
    }

    /// A one-to-one call began (placed here, or ringing): the room is left — the two cannot share the microphone.
    @objc private func callMoved() {
        guard state != nil else { return }
        #if targetEnvironment(simulator)
        if demo { return }
        #endif
        if let call = Calls.shared.call, !call.isOver {
            joining += 1
            leave()
        } else {
            // A call that ended took its hold off the line: the room's own hold is put back.
            messenger?.live.heldByCall = true
        }
    }

    // MARK: The controls

    func toggleMute() {
        guard let current = state else { return }
        let muted = !current.muted
        microphone?.set(on: !muted)
        _ = send(["type": "voice.mute", "muted": muted])
        patch { (state: inout RoomVoiceState) -> Void in state.muted = muted }
    }

    /// «Звук на динамике» ↔ «Звук в трубке» (with headphones on, the second one is the headphones).
    func toggleSpeaker() {
        guard let current = state else { return }
        let speaker = !current.speaker
        #if targetEnvironment(simulator)
        if !demo { CallAudio.route(speaker ? true : nil, video: false) }
        #else
        CallAudio.route(speaker ? true : nil, video: false)
        #endif
        patch { (state: inout RoomVoiceState) -> Void in state.speaker = speaker }
    }

    /// The notice of a refused connection was read.
    func clearError() {
        guard let current = state, !current.error.isEmpty else { return }
        patch { (state: inout RoomVoiceState) -> Void in state.error = "" }
    }

    /// Who is heard right now: the ids of the people whose incoming sound is above a whisper, and this account's
    /// own when its microphone is. Read from the connections' own statistics.
    func speaking(me: String, done: @escaping (Set<String>) -> Void) {
        #if targetEnvironment(simulator)
        if demo { return done(demoSpeaking) }
        #endif
        guard let current = state, !connections.isEmpty else { return done([]) }
        let level = RoomRules.speakingLevel
        var out = Set<String>()
        var waiting = connections.count
        for (peer, media) in connections {
            let userId = current.peers.first(where: { (item: RoomVoicePeer) -> Bool in item.peer == peer })?.userId
            media.statistics { (reports: [[String: Any]]) -> Void in
                for report in reports {
                    guard let heard = (report["audioLevel"] as? NSNumber)?.doubleValue, heard > level else { continue }
                    let audio = report["kind"] as? String == "audio" || report["mediaType"] as? String == "audio"
                    guard audio, let type = report["type"] as? String else { continue }
                    if type == "inbound-rtp" {
                        if let userId { out.insert(userId) }
                    } else if type == "media-source", !current.muted {
                        out.insert(me)
                    }
                }
                waiting -= 1
                if waiting == 0 { done(out) }
            }
        }
    }

    /// Music for everyone: tells every checked person whose channel is open. False when the text is not sent to anyone.
    @discardableResult
    func sendToPeers(_ text: String) -> Bool {
        var sent = false
        for (peer, media) in connections where verified.contains(peer) {
            if media.send(text) { sent = true }
        }
        return sent
    }

    /// The person behind a connection's id, among those inside.
    func userId(ofPeer peer: String) -> String? {
        state?.peers.first(where: { (item: RoomVoicePeer) -> Bool in item.peer == peer })?.userId
    }

    // MARK: What the live line says

    @objc private func event(_ note: Notification) {
        guard let data = note.userInfo?["event"] as? [String: Any], let type = data["type"] as? String else { return }
        #if targetEnvironment(simulator)
        if demo { return }
        #endif
        guard let current = state else { return }
        let roomId = current.roomId
        let here = data["channelId"] as? String == roomId
        switch type {
        case "voice.joined":
            guard here else { return }
            selfPeer = data["self"] as? String
            var peers: [RoomVoicePeer] = []
            for item in data["peers"] as? [[String: Any]] ?? [] {
                guard let peer = item["peer"] as? String, let userId = item["userId"] as? String else { continue }
                peerInfo[peer] = (userId: userId, device: item["device"] as? String)
                peers.append(RoomVoicePeer(peer: peer, userId: userId, muted: item["muted"] as? Bool ?? false, connected: false))
            }
            patch { (state: inout RoomVoiceState) -> Void in
                state.status = "connected"
                state.peers = peers
            }
            // The newcomer calls everyone already in the room.
            for item in peers { call(item.peer) }
        case "voice.signal":
            guard here, let from = data["from"] as? String, let payload = data["data"] as? [String: Any],
                  let kind = payload["kind"] as? String, let sdp = payload["sdp"] as? String else { return }
            if kind == "offer" {
                if acceptRestart(from, sdp) { return }
                offered(from, userId: data["userId"] as? String ?? "", device: data["device"] as? String, sdp: sdp)
            } else if kind == "answer" {
                answered(from, sdp)
            }
        case "voice.auth":
            guard here, let from = data["from"] as? String, let note = data["note"] as? [String: Any] else { return }
            if authSdp[from] != nil { verifyNote(from, note) } else { pendingNotes[from] = note }
        case "voice.left":
            if let peer = data["peer"] as? String { drop(peer) }
        case "voice.state":
            guard here, let members = data["members"] as? [[String: Any]] else { return }
            // The microphones of everyone in the room.
            var muted: [String: Bool] = [:]
            for item in members {
                if let userId = item["userId"] as? String { muted[userId] = item["muted"] as? Bool ?? false }
            }
            patch { (state: inout RoomVoiceState) -> Void in
                for index in state.peers.indices {
                    if let known = muted[state.peers[index].userId] { state.peers[index].muted = known }
                }
            }
        case "voice.kicked":
            // No longer a member, or the room is gone.
            if here { cleanup() }
        case "error":
            // The server refused the way in (the room is full, no longer a member).
            if current.status == "connecting" {
                lastError = data["error"] as? String ?? ""
                lastErrorRoom = roomId
                cleanup()
            }
        case "ready":
            // The live line reconnected: the server forgot this phone, it walks in again. (After the line's own
            // handling of «ready», so the line already counts as up.)
            DispatchQueue.main.async { [weak self] in self?.rejoin(roomId) }
        default:
            break
        }
    }

    private func rejoin(_ roomId: String) {
        guard let current = state, current.roomId == roomId else { return }
        for peer in Array(connections.keys) { drop(peer) }
        selfPeer = nil
        patch { (state: inout RoomVoiceState) -> Void in
            state.status = "connecting"
            state.peers = []
        }
        _ = send(["type": "voice.join", "roomId": roomId, "muted": current.muted, "device": ownDevice])
    }

    // MARK: Connections

    private func mark(_ sdp: String) -> String { CallRules.words("callMarkRestart", [sdp]) ?? sdp }
    private func strip(_ sdp: String) -> String { CallRules.words("callStripRestart", [sdp]) ?? sdp }

    /// A new connection to a person; whatever was known about the old one is forgotten.
    private func connectionFor(_ peer: String, initiator: Bool) -> RoomPeerMedia? {
        unverify(peer)
        connections[peer]?.close()
        connections[peer] = nil
        guard let microphone, let media = RoomPeerMedia(iceServers: iceServers, microphone: microphone, initiator: initiator) else { return nil }
        media.onState = { [weak self, weak media] (state: String) -> Void in
            guard let self, let media, self.connections[peer] === media else { return }
            self.feedLink(peer, media, ["kind": "state", "state": state])
            if state == "connected" {
                self.peerUpdate(peer, connected: true)
            } else if state == "failed" || state == "closed" {
                self.peerUpdate(peer, connected: false)
            }
        }
        media.onMessage = { [weak self, weak media] (text: String) -> Void in
            // Only from a person whose connection passed the check.
            guard let self, let media, self.connections[peer] === media, self.verified.contains(peer) else { return }
            self.onPeerText?(peer, text)
        }
        media.onChannelOpen = { [weak self, weak media] in
            guard let self, let media, self.connections[peer] === media else { return }
            self.onPeerReady?(peer)
        }
        connections[peer] = media
        return media
    }

    private func peerUpdate(_ peer: String, connected: Bool) {
        guard let current = state, let index = current.peers.firstIndex(where: { (item: RoomVoicePeer) -> Bool in item.peer == peer }), current.peers[index].connected != connected else { return }
        patch { (state: inout RoomVoiceState) -> Void in state.peers[index].connected = connected }
    }

    private func drop(_ peer: String) {
        unverify(peer)
        peerInfo[peer] = nil
        grades[peer] = nil
        connections[peer]?.close()
        connections[peer] = nil
        guard let current = state, current.peers.contains(where: { (item: RoomVoicePeer) -> Bool in item.peer == peer }) else { return }
        patch { (state: inout RoomVoiceState) -> Void in
            state.peers.removeAll { (item: RoomVoicePeer) -> Bool in item.peer == peer }
        }
    }

    /// This phone walked in: it calls a person who is already inside.
    private func call(_ peer: String) {
        guard let media = connectionFor(peer, initiator: true) else { return drop(peer) }
        media.makeOffer(iceRestart: false) { [weak self, weak media] (sdp: String?) -> Void in
            guard let self, let media, self.connections[peer] === media else { return }
            guard let sdp else { return self.drop(peer) }
            media.setLocal("offer", sdp: sdp) { [weak self, weak media] (fine: Bool) -> Void in
                guard let self, let media, self.connections[peer] === media else { return }
                guard fine else { return self.drop(peer) }
                media.whenGathered(fresh: false, timeout: RoomVoice.gatherTimeout) { [weak self, weak media] (local: String) -> Void in
                    guard let self, let media, self.connections[peer] === media else { return }
                    _ = self.send(["type": "voice.signal", "to": peer, "data": ["kind": "offer", "sdp": self.mark(local)]])
                }
            }
        }
    }

    /// A person walked in and calls this phone.
    private func offered(_ from: String, userId: String, device: String?, sdp: String) {
        peerInfo[from] = (userId: userId, device: device)
        if let current = state, !current.peers.contains(where: { (item: RoomVoicePeer) -> Bool in item.peer == from }) {
            patch { (state: inout RoomVoiceState) -> Void in
                state.peers.append(RoomVoicePeer(peer: from, userId: userId, muted: false, connected: false))
            }
        }
        guard let media = connectionFor(from, initiator: false) else { return drop(from) }
        media.setRemote("offer", sdp: strip(sdp)) { [weak self, weak media] (fine: Bool) -> Void in
            guard let self, let media, self.connections[from] === media else { return }
            guard fine else { return self.drop(from) }
            media.makeAnswer { [weak self, weak media] (answer: String?) -> Void in
                guard let self, let media, self.connections[from] === media else { return }
                guard let answer else { return self.drop(from) }
                media.setLocal("answer", sdp: answer) { [weak self, weak media] (fine: Bool) -> Void in
                    guard let self, let media, self.connections[from] === media else { return }
                    guard fine else { return self.drop(from) }
                    media.whenGathered(fresh: false, timeout: RoomVoice.gatherTimeout) { [weak self, weak media] (local: String) -> Void in
                        guard let self, let media, self.connections[from] === media else { return }
                        _ = self.send(["type": "voice.signal", "to": from, "data": ["kind": "answer", "sdp": self.mark(local)]])
                        self.startAuth(from, media, localSdp: local, remoteSdp: sdp)
                    }
                }
            }
        }
    }

    /// The answer to this phone's offer: the first one, or the answer to an ICE restart of a checked connection.
    private func answered(_ from: String, _ sdp: String) {
        guard let media = connections[from], media.signalingState == "have-local-offer" else { return }
        if verified.contains(from), let auth = authSdp[from] {
            // The same fingerprints, or the connection is refused.
            guard CallRules.flag("callSameFingerprints", [sdp, auth.remote]) else { return refuse(from) }
            // Not taken: the next attempt is on the timer.
            media.setRemote("answer", sdp: strip(sdp)) { (_: Bool) -> Void in }
            return
        }
        media.setRemote("answer", sdp: strip(sdp)) { [weak self, weak media] (fine: Bool) -> Void in
            guard let self, let media, self.connections[from] === media else { return }
            guard fine else { return self.drop(from) }
            self.startAuth(from, media, localSdp: media.localSdp, remoteSdp: sdp)
        }
    }

    // MARK: The end-to-end check of a connection

    private func unverify(_ peer: String) {
        links[peer]?.timer?.invalidate()
        links[peer] = nil
        verified.remove(peer)
        authSdp[peer] = nil
        pendingNotes[peer] = nil
        authTimers[peer]?.invalidate()
        authTimers[peer] = nil
    }

    /// The check failed, or never came: the connection to this person is closed and the room says so.
    private func refuse(_ peer: String) {
        guard state != nil else { return }
        drop(peer)
        patch { (state: inout RoomVoiceState) -> Void in state.error = RoomRules.refused }
    }

    /// Both SDPs of the connection are known: this phone sends its note (sealed for the person's very device) and
    /// checks theirs. Runs alongside the connection's own set-up, so it adds no wait before the voice.
    private func startAuth(_ peer: String, _ media: RoomPeerMedia, localSdp: String, remoteSdp: String) {
        guard connections[peer] === media, let current = state, let own = selfPeer else { return }
        authSdp[peer] = (local: localSdp, remote: remoteSdp, media: media)
        authTimers[peer]?.invalidate()
        authTimers[peer] = Timer.scheduledTimer(withTimeInterval: RoomRules.authTimeout, repeats: false) { [weak self, weak media] (_: Timer) -> Void in
            guard let self, let media, self.connections[peer] === media, !self.verified.contains(peer) else { return }
            self.refuse(peer)
        }
        // Without the person's device (an app without the check, or the server hid it) the timer refuses it.
        guard let info = peerInfo[peer], let device = info.device else { return }
        if let text = Core.view("roomAuthText", [current.roomId, own, peer, localSdp, remoteSdp]) as? String {
            seal(peer, media, userId: info.userId, device: device, text: text, again: true)
        } else {
            // An SDP without a fingerprint: there is nothing to vouch for.
            refuse(peer)
            return
        }
        if let waiting = pendingNotes.removeValue(forKey: peer) { verifyNote(peer, waiting) }
    }

    private func seal(_ peer: String, _ media: RoomPeerMedia, userId: String, device: String, text: String, again: Bool) {
        guard let messenger else { return }
        messenger.crypto.call("sealNote", [userId, device, text]) { [weak self, weak media] (result: Result<Any, CryptoFailure>) -> Void in
            guard let self, let media, self.connections[peer] === media else { return }
            if case .success(let value) = result, let note = value as? [String: Any] {
                _ = self.send(["type": "voice.auth", "to": peer, "note": note])
                return
            }
            // Once more in a second (the person's keys may not have been read yet), then the connection is refused.
            guard again else { return self.refuse(peer) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self, weak media] in
                guard let self, let media, self.connections[peer] === media else { return }
                self.seal(peer, media, userId: userId, device: device, text: text, again: false)
            }
        }
    }

    private func verifyNote(_ peer: String, _ note: [String: Any]) {
        guard let auth = authSdp[peer], let info = peerInfo[peer], let current = state, let own = selfPeer, !verified.contains(peer), let messenger else { return }
        let media = auth.media
        // The note must come from the device the server named for this person.
        guard let device = info.device, note["senderDeviceId"] as? String == device else {
            if connections[peer] === media { refuse(peer) }
            return
        }
        let expected: [String: Any] = ["channelId": current.roomId, "self": own, "peer": peer, "localSdp": auth.local, "remoteSdp": auth.remote]
        messenger.crypto.call("openNote", [info.userId, note]) { [weak self, weak media] (result: Result<Any, CryptoFailure>) -> Void in
            guard let self, let media, self.connections[peer] === media, !self.verified.contains(peer) else { return }
            var fine = false
            if case .success(let value) = result, let text = value as? String { fine = Core.view("roomCheckAuth", [text, expected]) as? Bool ?? false }
            guard fine else { return self.refuse(peer) }
            self.verified.insert(peer)
            self.authTimers[peer]?.invalidate()
            self.authTimers[peer] = nil
            // The connection is proven end to end: sound both ways.
            media.setAudible(true)
            media.setMicrophone(live: true)
            self.onPeerReady?(peer)
        }
    }

    // MARK: Automatic reconnection of a checked connection

    private func feedLink(_ peer: String, _ media: RoomPeerMedia, _ input: [String: Any]) {
        guard state != nil, let own = selfPeer, connections[peer] === media, verified.contains(peer) else { return }
        // The side with the smaller id restarts first; the other waits a little longer, so usually one offer is in flight.
        let polite = !(Core.view("roomRestartOfferer", [own, peer]) as? Bool ?? false)
        var entry: (link: [String: Any]?, timer: Timer?, pendingAt: Double) = links[peer] ?? (link: nil, timer: nil, pendingAt: 0)
        var held: Any = NSNull()
        if let link = entry.link { held = link }
        let step = CallRules.fields("callLinkNext", [held, input, CallRules.nowMs, polite])
        guard let next = step["link"] as? [String: Any] else { return }
        entry.timer?.invalidate()
        entry.timer = nil
        entry.link = next
        if let wakeAt = (step["wakeAt"] as? NSNumber)?.doubleValue {
            let pause = max(0, (wakeAt - CallRules.nowMs) / 1000)
            entry.timer = Timer.scheduledTimer(withTimeInterval: pause, repeats: false) { [weak self, weak media] (_: Timer) -> Void in
                guard let self, let media else { return }
                self.feedLink(peer, media, ["kind": "timer"])
            }
        }
        links[peer] = entry
        // The window ran out: shown as not connected, still in the room.
        if step["end"] as? Bool == true { peerUpdate(peer, connected: false) }
        if step["restart"] as? Bool == true { restart(peer, media) }
    }

    private func restart(_ peer: String, _ media: RoomPeerMedia) {
        guard let auth = authSdp[peer], links[peer] != nil, CallRules.flag("callRestartCapable", [auth.remote]) else { return }
        let signaling = media.signalingState
        guard signaling == "stable" || signaling == "have-local-offer" else { return }
        links[peer]?.pendingAt = CallRules.nowMs
        // The wait is set up before the offer: after an ICE restart the gathering starts over.
        media.whenGathered(fresh: true, timeout: RoomVoice.gatherTimeout) { [weak self, weak media] (local: String) -> Void in
            guard let self, let media, self.connections[peer] === media else { return }
            _ = self.send(["type": "voice.signal", "to": peer, "data": ["kind": "offer", "sdp": self.mark(local)]])
        }
        media.makeOffer(iceRestart: true) { [weak media] (sdp: String?) -> Void in
            guard let media else { return }
            // Not made: the next attempt is on the timer.
            guard let sdp else { return media.cancelGathering() }
            media.setLocal("offer", sdp: sdp) { [weak media] (fine: Bool) -> Void in
                if !fine { media?.cancelGathering() }
            }
        }
    }

    /// An offer for a checked connection with the very fingerprints it was checked with is an ICE restart of it:
    /// answered on that connection. True when the offer was one (anything else is a new connection and goes
    /// through the whole check again).
    private func acceptRestart(_ from: String, _ sdp: String) -> Bool {
        guard let media = connections[from], let auth = authSdp[from], verified.contains(from), let own = selfPeer,
              CallRules.flag("callSameFingerprints", [sdp, auth.remote]) else { return false }
        let polite = !(Core.view("roomRestartOfferer", [own, from]) as? Bool ?? false)
        let input: [String: Any] = ["gen": 1, "lastRemoteGen": 0, "signalingState": media.signalingState, "polite": polite, "fingerprintsMatch": true,
                                    "pendingAgeMs": CallRules.nowMs - (links[from]?.pendingAt ?? 0)]
        let decision = CallRules.words("callRemoteRestart", [input]) ?? "answer"
        // Both restarted at once and this phone's offer wins: the other side answers it.
        if decision == "ignore-glare" { return true }
        let localBefore = auth.local
        let answer: () -> Void = { [weak self, weak media] in
            guard let self, let media, self.connections[from] === media else { return }
            media.setRemote("offer", sdp: self.strip(sdp)) { [weak self, weak media] (fine: Bool) -> Void in
                // Not taken: they try again.
                guard let self, let media, fine, self.connections[from] === media else { return }
                media.whenGathered(fresh: true, timeout: RoomVoice.gatherTimeout) { [weak self, weak media] (local: String) -> Void in
                    guard let self, let media, self.connections[from] === media else { return }
                    // This phone's certificate did not change either; if it somehow did, the check no longer holds.
                    guard CallRules.flag("callSameFingerprints", [local, localBefore]) else { return self.refuse(from) }
                    _ = self.send(["type": "voice.signal", "to": from, "data": ["kind": "answer", "sdp": self.mark(local)]])
                }
                media.makeAnswer { [weak media] (made: String?) -> Void in
                    guard let media else { return }
                    guard let made else { return media.cancelGathering() }
                    media.setLocal("answer", sdp: made) { [weak media] (fine: Bool) -> Void in
                        if !fine { media?.cancelGathering() }
                    }
                }
            }
        }
        if decision == "rollback-and-answer" {
            media.cancelGathering()
            media.setLocal("rollback", sdp: "") { (_: Bool) -> Void in answer() }
        } else {
            answer()
        }
        return true
    }

    // MARK: The link's grade

    /// Every few seconds each person's link is read from the connection itself: when packets to or from someone
    /// are lost or late, the voice sent to that person is made lighter at once; it comes back step by step.
    private func checkLinks() {
        guard state != nil else { return }
        for (peer, media) in connections {
            media.statistics { [weak self, weak media] (reports: [[String: Any]]) -> Void in
                guard let self, let media, self.connections[peer] === media else { return }
                var known: (grade: String, calm: Int, sample: [String: Any]?) = self.grades[peer] ?? (grade: "good", calm: 0, sample: nil)
                var previous: Any = NSNull()
                if let sample = known.sample { previous = sample }
                let answer = CallRules.fields("callLink", [reports, previous, CallRules.nowMs])
                guard let reading = answer["link"] as? [String: Any] else { return }
                known.sample = answer["sample"] as? [String: Any]
                let step = CallRules.fields("callGrade", [reading, known.grade, known.calm])
                known.calm = (step["calm"] as? NSNumber)?.intValue ?? 0
                if let grade = step["grade"] as? String, grade != known.grade {
                    known.grade = grade
                    media.capAudio(bitrate: (CallRules.fields("callCaps", [CallRules.tier, grade])["audio"] as? NSNumber)?.doubleValue)
                }
                self.grades[peer] = known
                self.tellWorstLink()
            }
        }
    }

    private func tellWorstLink() {
        var worst = "good"
        for (peer, known) in grades where connections[peer] != nil {
            if known.grade == "bad" || (known.grade == "weak" && worst == "good") { worst = known.grade }
        }
        guard let current = state, current.link != worst else { return }
        patch { (state: inout RoomVoiceState) -> Void in state.link = worst }
    }

    // MARK: The simulator's samples

    #if targetEnvironment(simulator)
    /// A room this phone is «inside» without a server or any media (-roomsdemo).
    func showDemo(roomId: String, name: String, peers: [RoomVoicePeer], muted: Bool, speaking: Set<String>) {
        demo = true
        demoSpeaking = speaking
        var made = RoomVoiceState(roomId: roomId, name: name, status: "connected", speaker: true)
        made.muted = muted
        made.peers = peers
        state = made
    }

    var isDemo: Bool { demo }
    #endif
}
