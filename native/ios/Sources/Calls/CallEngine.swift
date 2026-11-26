import UIKit

/// One-to-one calls of the signed-in account: the reference's CallProvider.tsx, step for step.
///
///   outgoing:  requesting («Запрос…») → ringing («Вызов…») → connecting («Соединение…») → active (the clock) → ended
///   incoming:  incoming («Входящий звонок») → connecting → active → ended
///
/// - The offer and the answer each travel once, with the phone's addresses already inside (non-trickle ICE), as
///   end-to-end encrypted messages of the chat (CallSignals.swift).
/// - A second call while one is on is answered «busy»; an offer older than a minute never rings; nobody answers
///   for a minute — «Нет ответа» on the caller's side, «Пропущенный звонок» here.
/// - Once the media is up a drop is not the end: «Восстановление связи…», ICE restarts numbered so a late one is
///   ignored (if both sides restart at once the caller's offer wins), «Связь потеряна» after 30 seconds.
/// - Offline, an outgoing call waits for the connection («Ожидание сети…») and ends with «Нет соединения» and
///   «Повторить» if it does not come.
///
/// The rules themselves are the shared core's (CallRules); the media is CallMedia; this class keeps the order.
/// There is no CallKit and no call notification from a closed app: a call lives while the app is open (it goes on
/// in the background once it is running — the app's audio keeps it alive). Main queue only.
final class Calls {
    static let shared = Calls()
    /// Posted on the main queue whenever the call (or the fact that there is one) changed.
    static let changed = Notification.Name("invizent.call")

    private(set) var call: CallState? {
        didSet { NotificationCenter.default.post(name: Calls.changed, object: nil) }
    }
    /// The media of the call that is on, for the screen's pictures.
    private(set) var media: CallMedia?
    /// The link's last reading (the diagnostics under the status), nil before the first one.
    private(set) var linkReading: [String: Any]?

    private weak var messenger: Messenger?
    private var signals: CallSignals?
    private let network = CallNetwork()
    private var networkRunning = false
    /// The ids of calls this phone has placed, rung for or refused.
    private var seen = Set<String>()
    /// The calls the other side ended before they came up here (an `end` heard while the offer was still being
    /// looked into): such a call never rings.
    private var over = Set<String>()
    private var ringTimer: Timer?
    /// Runs while a call is «Соединение…»: see `connecting`.
    private var connectTimer: Timer?
    private var reachTimer: Timer?
    private var linkTimer: Timer?
    private var beat: Timer?
    private var beats = 0
    /// Which ringback plays for an outgoing call, and whether the server has said how far the call got.
    private var ringTone = ""
    private var reachKnown = false
    /// The servers of the last call, for when fresh ones cannot be asked for.
    private var lastIce: (at: Date, servers: [[String: Any]])?
    /// Whether a relay is configured for this call, and whether its address has been gathered.
    private var wantRelay = false
    private var relayFound = false
    private var gatherWaits: [GatherWait] = []
    private var networkWaiters: [(id: String, wake: (Bool) -> Void)] = []
    // Automatic reconnection: the link's state (nil: up), our last restart number, the one we wait an answer
    // for, and the newest one the other side sent.
    private var link: [String: Any]?
    private var restartGen = 0
    private var pendingGen: Int?
    private var pendingAt = 0.0
    private var lastRemoteGen = 0
    private var restarting = false
    private var linkSample: [String: Any]?
    private var calm = 0
    /// What the call on screen went through (CallReport.swift), for the grey line of the preview build.
    private var report: CallReport?
    /// That line, once the call has ended (nil: none, or not this build).
    private(set) var endReport: String?
    /// Servers asked for this recently are used as they are (the relay's password lasts 6 hours).
    private static let iceFresh: TimeInterval = 5 * 60
    /// How long the preview build keeps a call that never came up on the screen, with its grey line.
    private static let reportHold: TimeInterval = 15
    #if targetEnvironment(simulator)
    /// The simulator's samples (-calldemo): the screens without an account, a server or any media.
    private var demo = false
    #endif

    private init() {
        network.onOnline = { [weak self] in self?.networkMoved() }
        network.onChange = { [weak self] in self?.feedLink(["kind": "network"]) }
    }

    // MARK: The account

    /// The account whose calls these are (nil: the simulator's shell without one).
    func start(_ messenger: Messenger?) {
        if self.messenger === messenger, signals != nil || messenger == nil { return }
        stop()
        self.messenger = messenger
        guard let messenger else { return }
        if !networkRunning {
            networkRunning = true
            network.start()
        }
        let heard = CallSignals(messenger: messenger)
        heard.onSignal = { [weak self] (message: [String: Any]) -> Void in self?.signalArrived(message) }
        heard.onReach = { [weak self] (chatId: String, reach: String) -> Void in self?.reached(chatId: chatId, reach: reach) }
        heard.onLine = { [weak self] in self?.networkMoved() }
        signals = heard
    }

    /// The account was left: a call that is on ends here (the other side is told while the session still lives).
    func stop() {
        if let current = call, !current.isOver { hangup() }
        cleanup()
        call = nil
        signals = nil
        messenger = nil
    }

    /// "online", "waiting" («Ожидание сети…») or "connecting" («Соединение…»): the road the signalling takes.
    var signalNetwork: String {
        #if targetEnvironment(simulator)
        if demo { return "online" }
        #endif
        var online: Any = NSNull()
        if let known = network.online { online = known }
        return CallRules.words("callSignalNetwork", [messenger?.live.line ?? "offline", online]) ?? "waiting"
    }

    /// Where a person's picture is asked for (empty: they have none).
    func pictureAddress(_ person: Person) -> String { messenger?.personAvatarAddress(person.avatarId) ?? "" }

    private func patch(_ change: (inout CallState) -> Void) {
        guard var current = call else { return }
        change(&current)
        call = current
    }

    /// Whether the call with this id is the one that is on (a call that has just ended is not: what was started
    /// for it stops where it is).
    private func isCurrent(_ id: String) -> Bool { call?.id == id && call?.isOver == false }

    private func send(_ current: CallState, _ action: [String: Any]) {
        messenger?.sendCallSignal(chatId: current.chatId, peerId: current.peer.id, action: action)
    }

    // MARK: Placing a call

    /// «Позвонить» / «Видеозвонок». With a call already on, that call comes back to the screen instead.
    func place(chatId: String, peer: Person, video: Bool) {
        // A call that has ended and only shows its last words is no call: a new one takes its place.
        if call?.isOver == false { return restore() }
        guard let messenger else { return }
        let id = UUID().uuidString.lowercased()
        seen.insert(id)
        MusicPlayer.shared.stop()
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        let made = CallReport(incoming: false)
        made.network = network.kind
        report = made
        endReport = nil
        call = CallState(id: id, chatId: chatId, peer: peer, incoming: false, video: video, status: "requesting", speaker: video)
        began()
        // The header knows only the name: the picture and the colour come from the profile.
        messenger.personProfile(peer.id) { [weak self] (result: Result<PersonProfile, ServerError>) -> Void in
            guard case .success(let profile) = result, self?.isCurrent(id) == true else { return }
            self?.patch { (current: inout CallState) -> Void in current.peer = profile.person }
        }
        // Offline: wait for the connection first (the screen says «Ожидание сети…»); nothing has been sent yet.
        waitForNetwork(id) { [weak self] (online: Bool) -> Void in
            guard let self, self.isCurrent(id) else { return }
            guard online else { return self.finish(CallRules.noConnectionText, notify: nil, retry: true) }
            // The callee decides who may ring them (Настройки → Конфиденциальность → Звонки).
            messenger.callAllowed(peer.id, incoming: false) { [weak self] (allowed: Bool?) -> Void in
                guard let self, self.isCurrent(id) else { return }
                if allowed == false { return self.finish("Этот человек ограничил, кто может ему звонить", notify: nil) }
                CallAudio.allow(video: video) { [weak self] (refusal: String?) -> Void in
                    guard let self, self.isCurrent(id) else { return }
                    if let refusal { return self.finish(refusal, notify: nil) }
                    CallAudio.start(video: video)
                    self.prepare(id: id, video: video) { [weak self] (made: CallMedia?) -> Void in
                        guard let self, self.isCurrent(id) else { return }
                        guard let made else { return self.finish("Не удалось начать звонок", notify: nil) }
                        self.offer(made, id: id, video: video, restart: false) { [weak self] (sdp: String?) -> Void in
                            guard let self, self.isCurrent(id) else { return }
                            guard let sdp else { return self.finish("Не удалось начать звонок", notify: nil) }
                            self.ring(id: id, video: video, sdp: sdp)
                        }
                    }
                }
            }
        }
    }

    /// The offer is ready: it goes out, and the call rings.
    private func ring(id: String, video: Bool, sdp: String) {
        // The connection dropped while the offer was being prepared: an offer queued now would ring much later
        // (or never), so wait again and end with «Нет соединения» if it does not come back.
        waitForNetwork(id) { [weak self] (online: Bool) -> Void in
            guard let self, let current = self.call, current.id == id, !current.isOver else { return }
            guard online else { return self.finish(CallRules.noConnectionText, notify: nil, retry: true) }
            self.send(current, ["type": "call", "call": id, "step": "offer", "video": video, "sdp": CallRules.words("callMarkRestart", [sdp]) ?? sdp])
            self.report?.offerAt = Date()
            self.patch { (call: inout CallState) -> Void in call.status = "ringing" }
            // The first ringback: the call is on its way. The server then says how far it got (`call.reach`) and
            // the ringing one takes over. A server that says nothing gets the ringing tone after 3 s.
            self.ringTone = "connecting"
            self.reachKnown = false
            CallSounds.play("connecting")
            self.reachTimer?.invalidate()
            self.reachTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] (_: Timer) -> Void in
                guard let self, self.isCurrent(id), self.call?.status == "ringing", self.ringTone == "connecting", !self.reachKnown else { return }
                self.ringTone = "outgoing"
                CallSounds.play("outgoing")
            }
            // No answer in time: «Нет ответа» — or «Нет соединения» with «Повторить» when the connection is down.
            self.ringTimer?.invalidate()
            self.ringTimer = Timer.scheduledTimer(withTimeInterval: CallRules.ringTimeout, repeats: false) { [weak self] (_: Timer) -> Void in
                guard let self, self.isCurrent(id), self.call?.status == "ringing" else { return }
                let expiry = CallRules.fields("callRingExpiry", [self.signalNetwork])
                self.report?.cause = "нет ответа за \(Int(CallRules.ringTimeout)) с"
                self.finish(expiry["text"] as? String ?? "Нет ответа", notify: "missed", retry: expiry["retry"] as? Bool ?? false)
            }
        }
    }

    private func reached(chatId: String, reach: String) {
        guard let current = call, !current.incoming, current.status == "ringing", current.chatId == chatId else { return }
        reachKnown = true
        // Reached (the app is connected, or a notification service took the call): the ringing tone. Not reached:
        // the «on its way» beeps go on.
        if (reach == "online" || reach == "push") && ringTone != "outgoing" {
            ringTone = "outgoing"
            CallSounds.play("outgoing")
        }
    }

    // MARK: The connection

    /// Asks for the call's servers and makes the connection with the microphone (and the camera).
    private func prepare(id: String, video: Bool, done: @escaping (CallMedia?) -> Void) {
        iceServers(attempt: 0) { [weak self] (servers: [[String: Any]], source: String) -> Void in
            guard let self, self.isCurrent(id) else { return }
            self.wantRelay = CallRules.flag("callHasRelay", [servers])
            self.relayFound = false
            if let report = self.report {
                report.servers = servers.count
                report.source = source
                report.wantRelay = self.wantRelay
            }
            guard let made = CallMedia(iceServers: servers, video: video) else { return done(nil) }
            made.onCandidate = { [weak self] (line: String) -> Void in
                if CallRules.flag("callIsRelayCandidate", [line]) {
                    self?.relayFound = true
                    self?.report?.relayFound = true
                }
            }
            made.onGathering = { [weak self] in self?.checkGathering() }
            made.onState = { [weak self, weak made] (state: String) -> Void in
                guard let self, let made, self.media === made else { return }
                self.connectionMoved(state)
            }
            made.onRemoteVideo = { [weak self] in
                self?.patch { (call: inout CallState) -> Void in call.remoteVideo = true }
            }
            self.resetLink()
            self.media = made
            self.patch { (call: inout CallState) -> Void in call.localVideo = made.hasCamera }
            done(made)
        }
    }

    /// Without the relay's address a call between two mobile networks cannot connect, so its request is not given
    /// up at the first failure: two more tries (after 0.4 and 1.5 s), then the servers of the last call (the
    /// relay's password lasts 6 hours), then the public address finder alone. Servers asked for a few minutes ago
    /// — while the call rang, see `prefetchIce` — are taken as they are. `done` also says where they came from.
    private func iceServers(attempt: Int, done: @escaping ([[String: Any]], String) -> Void) {
        if attempt == 0, let kept = lastIce, Date().timeIntervalSince(kept.at) < Calls.iceFresh { return done(kept.servers, "сервер, заранее") }
        guard let messenger else { return done([["urls": ["stun:stun.l.google.com:19302"]]], "публичные") }
        messenger.callIceServers { [weak self] (servers: [[String: Any]]?) -> Void in
            guard let self else { return }
            if let servers {
                self.lastIce = (Date(), servers)
                return done(servers, attempt == 0 ? "сервер" : "сервер, попытка \(attempt + 1)")
            }
            if attempt < 2 {
                DispatchQueue.main.asyncAfter(deadline: .now() + (attempt == 0 ? 0.4 : 1.5)) { self.iceServers(attempt: attempt + 1, done: done) }
                return
            }
            if let kept = self.lastIce, Date().timeIntervalSince(kept.at) < CallRules.iceReuse { return done(kept.servers, "прошлые") }
            done([["urls": ["stun:stun.l.google.com:19302"]]], "публичные")
        }
    }

    /// An incoming call rings: its servers are asked for now, while the person reaches for the phone, so that
    /// «Ответить» does not wait for them — and a request that fails has the ringing to be tried again. Only the
    /// servers are kept (in memory, like the last call's); nothing else is done with them.
    private func prefetchIce(_ callId: String, attempt: Int = 0) {
        guard let messenger else { return }
        messenger.callIceServers { [weak self] (servers: [[String: Any]]?) -> Void in
            guard let self else { return }
            if let servers { self.lastIce = (Date(), servers); return }
            guard attempt < 3, self.call?.id == callId, self.call?.status == "incoming" else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.prefetchIce(callId, attempt: attempt + 1) }
        }
    }

    /// Our SDP, with economy voice on slow links: the other phone sends us less, and our own audio is capped.
    private func setLocal(_ made: CallMedia, kind: String, sdp: String, done: @escaping (Bool) -> Void) {
        let tier = CallRules.tier
        let lean = CallRules.words("callEconomySdp", [sdp, tier]) ?? sdp
        made.setLocal(kind, sdp: lean) { (fine: Bool) -> Void in
            if fine, let cap = (CallRules.fields("callCaps", [tier, "good"])["send"] as? NSNumber)?.doubleValue { made.cap("audio", bitrate: cap) }
            done(fine)
        }
    }

    /// Makes an offer, sets it and waits until the addresses are inside. nil: it could not be made.
    private func offer(_ made: CallMedia, id: String, video: Bool, restart: Bool, done: @escaping (String?) -> Void) {
        let wait = restart ? gatherAgain(made, done: { (sdp: String) -> Void in done(sdp) }) : nil
        made.makeOffer(iceRestart: restart) { [weak self] (sdp: String?) -> Void in
            guard let self, let sdp else { wait?.cancel(); return done(nil) }
            self.setLocal(made, kind: "offer", sdp: sdp) { [weak self] (fine: Bool) -> Void in
                guard let self, fine else { wait?.cancel(); return done(nil) }
                if !restart { self.gather(made, done: { (sdp: String) -> Void in done(sdp) }) }
            }
        }
    }

    /// Takes the other side's offer, answers it and waits until the addresses are inside.
    private func answer(_ made: CallMedia, offer: String, again: Bool, done: @escaping (String?) -> Void) {
        made.setRemote("offer", sdp: offer) { [weak self] (fine: Bool) -> Void in
            guard let self, fine else { return done(nil) }
            // After an ICE restart the gathering starts over: the wait is set up before our answer is.
            let wait = again ? self.gatherAgain(made, done: { (sdp: String) -> Void in done(sdp) }) : nil
            made.makeAnswer { [weak self] (sdp: String?) -> Void in
                guard let self, let sdp else { wait?.cancel(); return done(nil) }
                self.setLocal(made, kind: "answer", sdp: sdp) { [weak self] (fine: Bool) -> Void in
                    guard let self, fine else { wait?.cancel(); return done(nil) }
                    if !again { self.gather(made, done: { (sdp: String) -> Void in done(sdp) }) }
                }
            }
        }
    }

    // MARK: Non-trickle ICE

    /// One wait for the addresses to be inside the SDP (the core's `callGatherDone`: at once when gathering is
    /// complete; after 3 s if the relay's address is there or none is configured; never later than 10 s).
    private final class GatherWait {
        let started = Date()
        /// «Complete» counts only from now on (after an ICE restart the state still says so from the last round).
        let fresh: Bool
        /// The gathering was seen under way after this wait began.
        var moved = false
        var settled = false
        weak var media: CallMedia?
        let done: (String) -> Void
        init(media: CallMedia, fresh: Bool, done: @escaping (String) -> Void) {
            self.media = media
            self.fresh = fresh
            self.done = done
        }
        func cancel() { settled = true }
    }

    @discardableResult
    private func gather(_ made: CallMedia, done: @escaping (String) -> Void) -> GatherWait {
        let wait = GatherWait(media: made, fresh: false, done: done)
        gatherWaits.append(wait)
        checkGathering()
        return wait
    }

    private func gatherAgain(_ made: CallMedia, done: @escaping (String) -> Void) -> GatherWait {
        relayFound = false
        let wait = GatherWait(media: made, fresh: true, done: done)
        gatherWaits.append(wait)
        return wait
    }

    /// Looked at on every event of the gathering and four times a second by the call's own beat.
    private func checkGathering() {
        for wait in gatherWaits where !wait.settled {
            guard let made = wait.media, made === media else { wait.settled = true; continue }
            let finished = made.gatheringComplete
            if !finished { wait.moved = true }
            let elapsed = (Date().timeIntervalSince(wait.started) * 1000).rounded()
            let complete = wait.fresh ? wait.moved && finished : finished
            if !CallRules.flag("callGatherDone", [complete, relayFound, wantRelay, elapsed]) { continue }
            wait.settled = true
            let sdp = made.localSdp
            if let report {
                report.gatherMs = elapsed
                report.gatherComplete = complete
                report.own = CallReport.counts(sdp)
            }
            wait.done(sdp)
        }
        gatherWaits.removeAll { (wait: GatherWait) -> Bool in wait.settled }
    }

    // MARK: An incoming call

    /// A decrypted message of the other side that carries a call's step.
    private func signalArrived(_ message: [String: Any]) {
        guard let action = (message["meta"] as? [String: Any])?["action"] as? [String: Any], action["type"] as? String == "call",
              let callId = action["call"] as? String, let step = action["step"] as? String, let chatId = message["chatId"] as? String else { return }
        let sdp = action["sdp"] as? String
        let gen = (action["gen"] as? NSNumber)?.intValue
        let video = action["video"] as? Bool ?? false

        if step == "offer", let current = call, current.id == callId, current.status != "incoming", let sdp {
            // Mid-call change (the other side turned the camera on): answer the new offer on the same connection.
            guard let made = media else { return }
            if video && !current.video { patch { (call: inout CallState) -> Void in call.video = true } }
            answer(made, offer: CallRules.words("callStripRestart", [sdp]) ?? sdp, again: false) { [weak self] (own: String?) -> Void in
                guard let self, let own, let now = self.call, now.id == callId, !now.isOver else { return }
                self.send(now, ["type": "call", "call": callId, "step": "answer", "sdp": CallRules.words("callMarkRestart", [own]) ?? own])
            }
            return
        }
        if step == "offer" {
            guard let sdp, let senderId = message["senderId"] as? String, let created = message["createdAt"] as? String else { return }
            if over.contains(callId) { return }
            guard CallRules.flag("callOfferFresh", [created, CallRules.nowMs, Array(seen), callId]) else { return }
            seen.insert(callId)
            guard let messenger else { return }
            messenger.callPeer(chatId: chatId) { [weak self] (peer: Person?) -> Void in
                guard let self, let peer else { return }
                // A modified client could skip the server check; this phone still never rings for a caller it must not.
                messenger.callAllowed(senderId, incoming: true) { [weak self] (allowed: Bool?) -> Void in
                    guard let self else { return }
                    if allowed == false {
                        messenger.sendCallSignal(chatId: chatId, peerId: peer.id, action: CallRules.end(id: callId, video: video, incoming: true, startedAt: nil, reason: "declined"))
                    } else {
                        self.rings(chatId: chatId, peer: peer, callId: callId, video: video, sdp: sdp, created: created)
                    }
                }
            }
            return
        }

        guard let current = call, current.id == callId else {
            // The caller gave up while this phone was still looking into the offer (who calls, whether they may):
            // the call must not come up after its own end — it would ring, or be answered, for nobody.
            if step == "end" { over.insert(callId) }
            return
        }
        // A call that has just ended here hears nothing more (its last words stay on the screen for a moment).
        if current.isOver { return }
        // ICE restart from the other side: numbered, so a late or repeated one is ignored; the DTLS fingerprints
        // must be the ones of this call (the key emoji stay valid); glare: the caller's offer wins.
        if step == "restart", let sdp, let gen, current.status == "active" || current.status == "connecting" {
            guard let made = media else { return }
            let theirs = CallRules.words("callStripRestart", [sdp]) ?? sdp
            let input: [String: Any] = ["gen": gen, "lastRemoteGen": lastRemoteGen, "signalingState": made.signalingState, "polite": current.incoming,
                                        "fingerprintsMatch": CallRules.flag("callSameFingerprints", [theirs, current.remoteSdp ?? ""]), "pendingAgeMs": CallRules.nowMs - pendingAt]
            let decision = CallRules.words("callRemoteRestart", [input]) ?? "ignore-stale"
            guard decision == "answer" || decision == "rollback-and-answer" else { return }
            lastRemoteGen = gen
            let reply: () -> Void = { [weak self] in
                guard let self else { return }
                self.answer(made, offer: theirs, again: true) { [weak self] (own: String?) -> Void in
                    // Not made: the other side retries with a newer number.
                    guard let self, let own, let now = self.call, now.id == callId, !now.isOver, self.media === made else { return }
                    self.send(now, ["type": "call", "call": callId, "step": "restart-answer", "gen": gen, "sdp": CallRules.words("callMarkRestart", [own]) ?? own])
                }
            }
            if decision == "rollback-and-answer" {
                pendingGen = nil
                made.setLocal("rollback", sdp: "") { (_: Bool) -> Void in reply() }
            } else {
                reply()
            }
            return
        }
        if step == "restart-answer", let sdp, let gen {
            guard let made = media else { return }
            let theirs = CallRules.words("callStripRestart", [sdp]) ?? sdp
            var pending: Any = NSNull()
            if let waiting = pendingGen { pending = waiting }
            let input: [String: Any] = ["gen": gen, "pendingGen": pending, "signalingState": made.signalingState,
                                        "fingerprintsMatch": CallRules.flag("callSameFingerprints", [theirs, current.remoteSdp ?? ""])]
            guard CallRules.flag("callRestartAnswerFits", [input]) else { return }
            pendingGen = nil
            made.setRemote("answer", sdp: theirs) { (_: Bool) -> Void in }
            return
        }
        if step == "answer", let sdp, current.status == "active" || current.status == "connecting", media?.signalingState == "have-local-offer" {
            media?.setRemote("answer", sdp: CallRules.words("callStripRestart", [sdp]) ?? sdp) { (_: Bool) -> Void in }
            return
        }
        if step == "answer", !current.incoming, let sdp {
            // The answer of a call is taken once, while it rings: a second copy must not end a call that is connecting.
            if current.status != "ringing" { return }
            ringTimer?.invalidate()
            reachTimer?.invalidate()
            CallSounds.stop()
            patch { (call: inout CallState) -> Void in
                call.status = "connecting"
                call.remoteSdp = sdp
            }
            report?.answer = "получен"
            report?.answerAt = Date()
            connecting(callId)
            guard let made = media else { return }
            made.setRemote("answer", sdp: CallRules.words("callStripRestart", [sdp]) ?? sdp) { [weak self] (fine: Bool) -> Void in
                guard let self, self.isCurrent(callId), self.media === made else { return }
                if fine { return self.showKey(local: made.localSdp, remote: sdp) }
                self.report?.answer = "не принят"
                self.report?.cause = "ответ не принят"
                self.finish("Не удалось соединиться", notify: "failed")
            }
            return
        }
        if step == "end" {
            report?.cause = "собеседник: " + (action["reason"] as? String ?? "—")
            finish(CallRules.endedWords(reason: action["reason"] as? String), notify: nil)
        }
    }

    /// An offer that may ring: the incoming call comes up — or, with a call already on, the caller hears «busy».
    private func rings(chatId: String, peer: Person, callId: String, video: Bool, sdp: String, created: String) {
        // Ended by the caller while it was being looked into: nothing rings, nobody is told «busy».
        if over.contains(callId) { return }
        // Busy only while a call is on: one that has ended and only shows its last words gives way.
        if call?.isOver == false {
            // Busy: the same `end` as a hang-up, so the caller's chat says «Собеседник занят» and ours a missed call.
            messenger?.sendCallSignal(chatId: chatId, peerId: peer.id, action: CallRules.end(id: callId, video: video, incoming: true, startedAt: nil, reason: "busy"))
            return
        }
        var incoming = CallState(id: callId, chatId: chatId, peer: peer, incoming: true, video: video, status: "incoming", speaker: video)
        incoming.remoteSdp = sdp
        let ringing = CallReport(incoming: true)
        ringing.network = network.kind
        ringing.offerAt = Messenger.date(created)
        report = ringing
        endReport = nil
        call = incoming
        began()
        prefetchIce(callId)
        CallSounds.play("incoming")
        CallSounds.vibrate()
        ringTimer?.invalidate()
        ringTimer = Timer.scheduledTimer(withTimeInterval: CallRules.ringTimeout, repeats: false) { [weak self] (_: Timer) -> Void in
            guard let self, self.isCurrent(callId), self.call?.status == "incoming" else { return }
            self.finish("Пропущенный звонок", notify: nil)
        }
    }

    /// «Ответить».
    func accept() {
        #if targetEnvironment(simulator)
        if demo { return demoAccept() }
        #endif
        guard let current = call, current.status == "incoming", let offer = current.remoteSdp else { return }
        let id = current.id
        ringTimer?.invalidate()
        CallSounds.stop()
        CallSounds.still()
        MusicPlayer.shared.stop()
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        patch { (call: inout CallState) -> Void in call.status = "connecting" }
        connecting(id)
        CallAudio.allow(video: current.video) { [weak self] (refusal: String?) -> Void in
            guard let self, self.isCurrent(id) else { return }
            if let refusal {
                self.report?.cause = "микрофон"
                return self.finish(refusal, notify: "failed")
            }
            CallAudio.start(video: current.video)
            self.prepare(id: id, video: current.video) { [weak self] (made: CallMedia?) -> Void in
                guard let self, self.isCurrent(id) else { return }
                guard let made else {
                    self.report?.cause = "нет соединения WebRTC"
                    return self.finish("Не удалось ответить", notify: "failed")
                }
                self.answer(made, offer: CallRules.words("callStripRestart", [offer]) ?? offer, again: false) { [weak self] (own: String?) -> Void in
                    guard let self, let now = self.call, now.id == id, !now.isOver else { return }
                    self.report?.answer = own == nil ? "не сделан" : "сделан"
                    guard let own, let messenger = self.messenger else {
                        self.report?.cause = "ответ не сделан"
                        return self.finish("Не удалось ответить", notify: "failed")
                    }
                    // The answer is the whole call: when it cannot leave this phone the caller rings on and nothing
                    // would ever connect here, so the call ends instead of saying «Соединение…» for ever.
                    let action: [String: Any] = ["type": "call", "call": id, "step": "answer", "sdp": CallRules.words("callMarkRestart", [own]) ?? own]
                    messenger.sendCallSignal(chatId: now.chatId, peerId: now.peer.id, action: action, done: { [weak self] (sent: Bool) -> Void in
                        guard let self, self.isCurrent(id) else { return }
                        self.report?.answer = sent ? "отправлен" : "не отправлен"
                        if sent { self.report?.answerAt = Date() }
                        guard !sent, self.call?.status == "connecting" else { return }
                        self.report?.cause = "ответ не ушёл"
                        self.finish("Не удалось соединиться", notify: "failed")
                    })
                    self.showKey(local: own, remote: offer)
                }
            }
        }
    }

    /// A call says «Соединение…» from here (answered on this phone, or the other side's answer arrived). The media
    /// normally says by itself whether it came up; when nothing at all is heard — the answer never left, the other
    /// side went away without a word that reached this phone — the call ends after as long as a call rings,
    /// instead of waiting for ever. The other side is told, like after any failed connection.
    private func connecting(_ id: String) {
        report?.connectingAt = Date()
        connectTimer?.invalidate()
        connectTimer = Timer.scheduledTimer(withTimeInterval: CallRules.ringTimeout, repeats: false) { [weak self] (_: Timer) -> Void in
            guard let self, self.isCurrent(id), self.call?.status == "connecting" else { return }
            self.report?.cause = "\(Int(CallRules.ringTimeout)) с без связи"
            self.finish("Не удалось соединиться", notify: "failed")
        }
    }

    /// The four emoji of the call's key: both sides see the same once both SDPs are known.
    private func showKey(local: String, remote: String) {
        guard let emoji = Core.view("callKey", [local, remote]) as? [String], emoji.count == 4 else { return }
        patch { (call: inout CallState) -> Void in call.key = emoji }
    }

    // MARK: The running call

    private func connectionMoved(_ state: String) {
        guard let current = call else { return }
        report?.state = state
        if state == "connected" && current.status != "active" && current.status != "ended" {
            connectTimer?.invalidate()
            connectTimer = nil
            resetLink()
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            patch { (call: inout CallState) -> Void in
                call.status = "active"
                call.startedAt = CallRules.nowMs
            }
            return
        }
        // Once the call is up, a drop is not the end: «Восстановление связи…», ICE restarts, «Связь потеряна» after 30 s.
        if current.status == "active" { return feedLink(["kind": "state", "state": state]) }
        if state == "failed" {
            report?.cause = "ICE failed"
            finish("Не удалось соединиться", notify: "failed")
        }
    }

    private func resetLink() {
        linkTimer?.invalidate()
        linkTimer = nil
        link = nil
        restartGen = 0
        pendingGen = nil
        lastRemoteGen = 0
        restarting = false
    }

    /// One input into the reconnect state machine (the connection's state, a change of network, its own timer).
    private func feedLink(_ input: [String: Any]) {
        guard let current = call, current.status == "active", media != nil else { return }
        // The caller acts first; the callee waits a little longer, so usually only one restart offer is in flight.
        var held: Any = NSNull()
        if let link { held = link }
        let step = CallRules.fields("callLinkNext", [held, input, CallRules.nowMs, current.incoming])
        guard let next = step["link"] as? [String: Any] else { return }
        link = next
        linkTimer?.invalidate()
        linkTimer = nil
        if let wakeAt = (step["wakeAt"] as? NSNumber)?.doubleValue {
            let pause = max(0, (wakeAt - CallRules.nowMs) / 1000)
            linkTimer = Timer.scheduledTimer(withTimeInterval: pause, repeats: false) { [weak self] (_: Timer) -> Void in self?.feedLink(["kind": "timer"]) }
        }
        let showing = step["showing"] as? Bool ?? false
        if current.reconnecting != showing { patch { (call: inout CallState) -> Void in call.reconnecting = showing } }
        if step["recovered"] as? Bool == true { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
        if step["end"] as? Bool == true {
            report?.cause = "связь потеряна"
            return finish("Связь потеряна", notify: "failed")
        }
        if step["restart"] as? Bool == true { sendRestart() }
    }

    /// An ICE restart offer, numbered, inside the same encrypted signalling as the first SDP.
    private func sendRestart() {
        guard let current = call, let made = media, current.status == "active", !restarting else { return }
        // An older app on the other side does not know the `restart` step: ICE may still recover by itself.
        var theirs: Any = NSNull()
        if let sdp = current.remoteSdp { theirs = sdp }
        guard CallRules.flag("callRestartCapable", [theirs]) else { return }
        restarting = true
        restartGen += 1
        let gen = restartGen
        pendingGen = gen
        pendingAt = CallRules.nowMs
        offer(made, id: current.id, video: current.video, restart: true) { [weak self] (sdp: String?) -> Void in
            guard let self else { return }
            // Not made: the next attempt is on the timer.
            self.restarting = false
            guard let sdp, let now = self.call, now.id == current.id, !now.isOver, self.media === made, self.pendingGen == gen else { return }
            self.send(now, ["type": "call", "call": now.id, "step": "restart", "gen": gen, "sdp": CallRules.words("callMarkRestart", [sdp]) ?? sdp])
        }
    }

    /// The link is read from the connection itself every three seconds for the whole call: when packets are lost
    /// or late the voice is made lighter at once and the picture gives way first; when the link has been calm for
    /// a while the quality comes back step by step.
    private func readLink() {
        guard let current = call, current.status == "active", let made = media else { return }
        made.statistics { [weak self] (reports: [[String: Any]]) -> Void in
            guard let self, let now = self.call, now.id == current.id, !now.isOver, now.status == "active", self.media === made else { return }
            var previous: Any = NSNull()
            if let sample = self.linkSample { previous = sample }
            let answer = CallRules.fields("callLink", [reports, previous, CallRules.nowMs])
            guard let reading = answer["link"] as? [String: Any] else { return }
            self.linkSample = answer["sample"] as? [String: Any]
            self.linkReading = reading
            let step = CallRules.fields("callGrade", [reading, now.grade, self.calm])
            self.calm = (step["calm"] as? NSNumber)?.intValue ?? 0
            guard let grade = step["grade"] as? String, grade != now.grade else { return }
            let caps = CallRules.fields("callCaps", [CallRules.tier, grade])
            made.cap("audio", bitrate: (caps["audio"] as? NSNumber)?.doubleValue)
            made.cap("video", bitrate: (caps["video"] as? NSNumber)?.doubleValue)
            self.patch { (call: inout CallState) -> Void in call.grade = grade }
        }
    }

    /// The lines of the diagnostics (a tap on the status): the route, the delay, the losses, the bitrates.
    var linkLines: [String] {
        let empty: [String: Any] = ["route": NSNull(), "rttMs": NSNull(), "lossPct": NSNull(), "jitterMs": NSNull(), "kbpsOut": NSNull(), "kbpsIn": NSNull()]
        return Core.view("callLinkLines", [linkReading ?? empty, CallRules.tier]) as? [String] ?? []
    }

    // MARK: The controls

    /// «Завершить» / «Отклонить»: the reason by status — a call that never connected is never an answered call.
    func hangup() {
        guard let current = call, !current.isOver else { return }
        let outcome = CallRules.fields("callHangup", [current.status, current.incoming])
        if let report, report.cause.isEmpty { report.cause = "кнопка" }
        finish(outcome["text"] as? String ?? "Звонок завершён", notify: outcome["reason"] as? String)
    }

    func toggleMute() {
        guard let current = call, !current.isOver else { return }
        media?.setMicrophone(on: current.muted)
        patch { (call: inout CallState) -> Void in call.muted = !current.muted }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    /// «Динамик».
    func toggleSpeaker() {
        guard let current = call, !current.isOver else { return }
        CallAudio.route(CallRules.speakerRoute(chosen: !current.speaker, video: current.video), video: current.video)
        patch { (call: inout CallState) -> Void in call.speaker = !current.speaker }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    /// «Видео»: switches this phone's camera off and on; during an audio call the first press turns the call
    /// into a video call (a new offer inside the same call).
    func toggleCamera() {
        guard let current = call, !current.isOver else { return }
        #if targetEnvironment(simulator)
        if demo { return patch { (call: inout CallState) -> Void in call.cameraOff = !current.cameraOff } }
        #endif
        guard let made = media else { return }
        if !made.hasCamera { return enableVideo() }
        guard current.video else { return }
        made.setCamera(on: current.cameraOff)
        patch { (call: inout CallState) -> Void in call.cameraOff = !current.cameraOff }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    private func enableVideo() {
        guard let current = call, let made = media, current.status == "active" else { return }
        let id = current.id
        CallAudio.allowCamera { [weak self] (refusal: String?) -> Void in
            // The camera is not allowed: the call goes on with audio.
            guard let self, refusal == nil, self.isCurrent(id), self.media === made, self.call?.status == "active" else { return }
            made.addCamera()
            // No camera could be opened: the call stays audio.
            guard made.hasCamera else { return }
            CallAudio.route(true, video: true)
            self.patch { (call: inout CallState) -> Void in
                call.video = true
                call.cameraOff = false
                call.speaker = true
                call.localVideo = made.hasCamera
            }
            self.offer(made, id: id, video: true, restart: false) { [weak self] (sdp: String?) -> Void in
                guard let self, let sdp, let now = self.call, now.id == id, !now.isOver, self.media === made else { return }
                self.send(now, ["type": "call", "call": id, "step": "offer", "video": true, "sdp": CallRules.words("callMarkRestart", [sdp]) ?? sdp])
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
        }
    }

    /// «Повернуть»: the other camera.
    func flipCamera() {
        media?.flipCamera()
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        // The small picture is a mirror for the front camera only.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NotificationCenter.default.post(name: Calls.changed, object: nil) }
    }

    func minimize() {
        guard let current = call, current.status != "incoming", !current.isOver else { return }
        patch { (call: inout CallState) -> Void in call.minimized = true }
    }

    func restore() { patch { (call: inout CallState) -> Void in call.minimized = false } }

    /// «Нет соединения» → «Повторить»: the same chat, the same kind of call, a new call id.
    func retry() {
        guard let current = call, current.isOver else { return }
        #if targetEnvironment(simulator)
        if demo { return showDemo("outgoing") }
        #endif
        call = nil
        place(chatId: current.chatId, peer: current.peer, video: current.video)
    }

    /// «Закрыть».
    func close() {
        guard call?.isOver == true else { return }
        call = nil
    }

    // MARK: The end

    /// A call is on from here: the line stays open with it, and the call's own beat runs.
    private func began() {
        messenger?.live.heldByCall = true
        beats = 0
        beat?.invalidate()
        beat = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] (_: Timer) -> Void in self?.tick() }
    }

    private func tick() {
        beats += 1
        checkGathering()
        // The connection is asked for its state as well as heard, and for its statistics every three seconds.
        if beats % 4 == 0 { media?.tellState() }
        if beats % 12 == 0 { readLink() }
    }

    private func cleanup() {
        resetLink()
        ringTimer?.invalidate()
        ringTimer = nil
        connectTimer?.invalidate()
        connectTimer = nil
        reachTimer?.invalidate()
        reachTimer = nil
        beat?.invalidate()
        beat = nil
        ringTone = ""
        for wait in gatherWaits { wait.cancel() }
        gatherWaits = []
        // Whoever still waits for the network finds the call gone when its own time runs out.
        networkWaiters = []
        CallSounds.stop()
        CallSounds.still()
        media?.close()
        media = nil
        CallAudio.stop()
        CallSounds.restore()
        linkSample = nil
        linkReading = nil
        calm = 0
        messenger?.live.heldByCall = false
    }

    /// The call ends with these words on the screen. `notify`: the reason the other side is told (the `end` both
    /// chats show as the call's row); nil — nothing is sent. `retry`: «Нет соединения» stays with «Повторить».
    private func finish(_ words: String, notify: String?, retry: Bool = false) {
        guard let current = call, !current.isOver else { return }
        // The grey line of the preview build: made before the connection is closed (its last state is in it).
        let line = report?.line(theirs: current.remoteSdp)
        report = nil
        endReport = CallReport.shown ? line : nil
        if let notify { send(current, CallRules.end(current, reason: notify)) }
        cleanup()
        var ended = current
        ended.status = "ended"
        ended.endedText = words
        ended.retry = retry
        ended.localVideo = false
        ended.remoteVideo = false
        ended.reconnecting = false
        if retry { ended.minimized = false }
        call = ended
        if retry { return }
        // A call that never came up stays on the screen long enough for a picture of its line to be taken.
        let troubled = endReport != nil && current.startedAt == nil && (current.status == "connecting" || notify == "failed" || notify == "missed")
        DispatchQueue.main.asyncAfter(deadline: .now() + (troubled ? Calls.reportHold : 1.6)) { [weak self] in
            guard let self, let ended = self.call, ended.id == current.id, ended.isOver else { return }
            self.call = nil
        }
    }

    // MARK: The signalling road

    /// Calls back with true once the signalling road is up, false after `networkWait` or when this call is gone.
    private func waitForNetwork(_ id: String, done: @escaping (Bool) -> Void) {
        if signalNetwork == "online" { return done(true) }
        var settled = false
        let wake: (Bool) -> Void = { [weak self] (online: Bool) -> Void in
            if settled { return }
            settled = true
            done(online && self?.isCurrent(id) == true)
        }
        networkWaiters.append((id, wake))
        DispatchQueue.main.asyncAfter(deadline: .now() + CallRules.networkWait) { [weak self] in
            guard let self, !settled else { return }
            self.networkWaiters.removeAll { (waiter: (id: String, wake: (Bool) -> Void)) -> Bool in waiter.id == id }
            wake(false)
        }
    }

    /// The live line or the phone's network changed: whoever waits for the road is woken, the screens show it.
    private func networkMoved() {
        if signalNetwork == "online" {
            let waiting = networkWaiters
            networkWaiters = []
            for waiter in waiting { waiter.wake(true) }
        }
        if call != nil { NotificationCenter.default.post(name: Calls.changed, object: nil) }
    }

    // MARK: The simulator's samples

    #if targetEnvironment(simulator)
    /// -calldemo outgoing | incoming | active | video | ended | retry | bar: one state of a call on made-up data —
    /// no account, no server, no microphone, no camera.
    func showDemo(_ state: String) {
        cleanup()
        demo = true
        let peer = PeopleDemo.named("Алиса Воронцова")
        var sample = CallState(id: "demo-call", chatId: "demo", peer: peer, incoming: state == "incoming", video: state == "video", status: "ringing", speaker: state == "video")
        switch state {
        case "incoming":
            sample.status = "incoming"
        case "active", "bar":
            sample.status = "active"
            sample.startedAt = CallRules.nowMs - 42_000
            sample.key = ["🦊", "🌵", "🎧", "⭐"]
            sample.minimized = state == "bar"
        case "video":
            sample.status = "active"
            sample.startedAt = CallRules.nowMs - 192_000
            sample.key = ["🐳", "🍋", "🚀", "🌙"]
            sample.localVideo = true
            sample.remoteVideo = true
        case "ended":
            sample.status = "ended"
            sample.endedText = "Звонок завершён"
        case "retry":
            sample.status = "ended"
            sample.endedText = CallRules.noConnectionText
            sample.retry = true
        default:
            break
        }
        call = sample
    }

    /// Whether the call on screen is a sample (its pictures are drawn, not filmed).
    var isDemo: Bool { demo }

    private func demoAccept() {
        patch { (call: inout CallState) -> Void in
            call.status = "active"
            call.startedAt = CallRules.nowMs
            call.key = ["🦊", "🌵", "🎧", "⭐"]
        }
    }
    #endif
}
