import Foundation
import LiveKitWebRTC

/// The keys of shared screens and the sealing of their frames: the reference's `NativeCipher` (communities/sfu/
/// session.ts) on the FrameCryptor of the WebRTC build (LiveKit's, the very one the reference app links).
///
/// A frame through the server is AES-GCM with a fresh 96-bit IV, its first bytes left readable for the codec (10 of
/// a VP8 key frame, 3 otherwise, 1 of an Opus frame) and authenticated; then the IV, its length (12) and the key's
/// index 0..15 («lk» frames, frameCrypto.ts). The AES-128 key is HKDF-SHA256(raw key, salt «INVIZENT screen frames
/// v1», 128 zero bytes) — the FrameCryptor's key provider with HKDF and this ratchet salt derives exactly that, so
/// the computers' frames (insertable streams + WebCrypto) and the phones' frames are the same bytes.
///
/// Raw keys reach this phone only over the peer-to-peer channels of connections that passed the end-to-end check
/// (RoomVoice.swift); the server forwards frames it cannot open.
final class ScreenFrameKeys {
    static let salt = "INVIZENT screen frames v1"
    static let ring = 16
    static let own = "self"
    let provider: LKRTCFrameCryptorKeyProvider

    init() {
        // keyDerivationAlgorithm 1 = HKDF (LKRTCKeyDerivationAlgorithmHKDF), as the reference passes it.
        let hkdf = LKRTCKeyDerivationAlgorithm(rawValue: 1)!
        provider = LKRTCFrameCryptorKeyProvider(ratchetSalt: Data(ScreenFrameKeys.salt.utf8), ratchetWindowSize: 0, sharedKeyMode: false, uncryptedMagicBytes: nil,
                                                failureTolerance: -1, keyRingSize: Int32(ScreenFrameKeys.ring), discardFrameWhenCryptorNotReady: true, keyDerivationAlgorithm: hkdf)
    }

    /// A key a person sent over their checked channel. A legacy-layout key (index 16 and up): such a sharer sends this
    /// phone a direct copy instead.
    func setPeerKey(_ peer: String, index: Int, raw: Data) {
        guard index >= 0, index < ScreenFrameKeys.ring, peer != ScreenFrameKeys.own, raw.count == 16 else { return }
        provider.setKey(raw, with: Int32(index), forParticipant: peer)
    }

    func setOwnKey(index: Int, raw: Data) {
        provider.setKey(raw, with: Int32(index), forParticipant: ScreenFrameKeys.own)
    }

    /// The cryptor that opens what one person sends (nil when the build could not make one: nothing is shown then).
    func opener(_ receiver: LKRTCRtpReceiver, peer: String) -> LKRTCFrameCryptor? {
        guard let cryptor = LKRTCFrameCryptor(factory: CallMedia.factory, rtpReceiver: receiver, participantId: peer, algorithm: .aesGcm, keyProvider: provider) else { return nil }
        cryptor.enabled = true
        return cryptor.enabled ? cryptor : nil
    }

    /// The cryptor that seals what this phone sends, with the key at `index`.
    func sealer(_ sender: LKRTCRtpSender, index: Int) -> LKRTCFrameCryptor? {
        guard let cryptor = LKRTCFrameCryptor(factory: CallMedia.factory, rtpSender: sender, participantId: ScreenFrameKeys.own, algorithm: .aesGcm, keyProvider: provider) else { return nil }
        cryptor.keyIndex = Int32(index)
        cryptor.enabled = true
        return cryptor.enabled ? cryptor : nil
    }
}

/// One transport to the server's SFU (mediasoup): one peer connection, ICE-lite on the server's side, this phone
/// the DTLS client. The server's half of the SDP is written here from the server's parameters, as mediasoup-client
/// does it (handlers/sdp/RemoteSdp.js, RemoteMediaSection.js). Main queue.
private final class SfuTransport: NSObject, LKRTCPeerConnectionDelegate {
    struct Section {
        var mid: String
        var kind: String
        /// The lines of the section between «c=» and «a=setup» (codecs, extensions, ssrcs, direction).
        var body: [String]
        var payloads: String
        var closed = false
    }

    let id: String
    let sending: Bool
    private let ufrag: String
    private let pwd: String
    private let candidates: [String]
    private let fingerprint: String
    private(set) var connection: LKRTCPeerConnection?
    var ready = false
    var sections: [Section] = []
    private var version = 0
    private var queue: [(@escaping () -> Void) -> Void] = []
    private var running = false

    init?(_ params: [String: Any], sending: Bool) {
        guard let id = params["id"] as? String, let ice = params["iceParameters"] as? [String: Any],
              let ufrag = ice["usernameFragment"] as? String, let pwd = ice["password"] as? String,
              let dtls = params["dtlsParameters"] as? [String: Any], let prints = dtls["fingerprints"] as? [[String: Any]],
              let last = prints.last, let algorithm = last["algorithm"] as? String, let value = last["value"] as? String else { return nil }
        self.id = id
        self.sending = sending
        self.ufrag = ufrag
        self.pwd = pwd
        fingerprint = algorithm + " " + value
        var lines: [String] = []
        for item in params["iceCandidates"] as? [[String: Any]] ?? [] {
            guard let foundation = item["foundation"], let priority = item["priority"] as? NSNumber, let port = item["port"] as? NSNumber,
                  let address = (item["address"] as? String) ?? (item["ip"] as? String), let proto = item["protocol"] as? String else { continue }
            var line = "a=candidate:\(foundation) 1 \(proto) \(priority.int64Value) \(address) \(port.intValue) typ \(item["type"] as? String ?? "host")"
            if let tcp = item["tcpType"] as? String { line += " tcptype " + tcp }
            lines.append(line)
        }
        candidates = lines
        super.init()
        let config = LKRTCConfiguration()
        config.iceServers = []
        config.bundlePolicy = .maxBundle
        config.rtcpMuxPolicy = .require
        config.sdpSemantics = .unifiedPlan
        let none = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let made = CallMedia.factory.peerConnection(with: config, constraints: none, delegate: self) else { return nil }
        connection = made
    }

    /// One negotiation at a time on this connection: `step` calls its argument when it is over.
    func serial(_ step: @escaping (@escaping () -> Void) -> Void) {
        queue.append(step)
        runNext()
    }

    private func runNext() {
        guard !running, !queue.isEmpty else { return }
        running = true
        let step = queue.removeFirst()
        step { [weak self] in
            DispatchQueue.main.async {
                guard let self else { return }
                self.running = false
                self.runNext()
            }
        }
    }

    /// The server's half of the SDP: an offer (receiving) or an answer (sending).
    func remoteSdp() -> String {
        version += 1
        var out: [String] = ["v=0", "o=mediasoup-client 10000 \(version) IN IP4 0.0.0.0", "s=-", "t=0 0", "a=ice-lite", "a=fingerprint:" + fingerprint,
                             "a=msid-semantic: WMS *"]
        let mids = sections.filter { (item: Section) -> Bool in !item.closed }.map { (item: Section) -> String in item.mid }
        out.append("a=group:BUNDLE " + mids.joined(separator: " "))
        if !sending { out.append("a=extmap-allow-mixed") }
        out.append("a=ice-options:ice2")
        for section in sections {
            out.append("m=\(section.kind) \(section.closed ? 0 : 7) UDP/TLS/RTP/SAVPF \(section.payloads)")
            out.append("c=IN IP4 127.0.0.1")
            if section.closed {
                out.append("a=mid:" + section.mid)
                out.append("a=inactive")
                continue
            }
            out.append(contentsOf: section.body)
            out.append("a=setup:" + (sending ? "passive" : "actpass"))
            out.append("a=mid:" + section.mid)
            out.append("a=ice-ufrag:" + ufrag)
            out.append("a=ice-pwd:" + pwd)
            out.append(contentsOf: candidates)
            out.append("a=end-of-candidates")
            out.append("a=ice-options:renomination")
            out.append("a=rtcp-mux")
            out.append("a=rtcp-rsize")
        }
        return out.joined(separator: "\r\n") + "\r\n"
    }

    func close() {
        queue = []
        connection?.close()
        connection = nil
    }

    // Nothing to tell: the server is ICE-lite (it learns this phone's addresses from the checks themselves).
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange stateChanged: LKRTCSignalingState) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didAdd stream: LKRTCMediaStream) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove stream: LKRTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: LKRTCPeerConnection) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceConnectionState) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceGatheringState) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didGenerate candidate: LKRTCIceCandidate) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove candidates: [LKRTCIceCandidate]) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didOpen dataChannel: LKRTCDataChannel) {}
}

/// The lines of one SDP, cut into its session part and its media sections (enough for what mediasoup needs).
private struct SdpText {
    let session: [String]
    let media: [[String]]

    init(_ sdp: String) {
        let lines = sdp.components(separatedBy: "\n").map { (line: String) -> String in line.hasSuffix("\r") ? String(line.dropLast()) : line }.filter { (line: String) -> Bool in !line.isEmpty }
        var session: [String] = []
        var media: [[String]] = []
        for line in lines {
            if line.hasPrefix("m=") { media.append([line]) } else if media.isEmpty { session.append(line) } else { media[media.count - 1].append(line) }
        }
        self.session = session
        self.media = media
    }

    static func value(_ lines: [String], _ prefix: String) -> String? {
        guard let line = lines.first(where: { (item: String) -> Bool in item.hasPrefix(prefix) }) else { return nil }
        return String(line.dropFirst(prefix.count))
    }

    func section(mid: String) -> [String]? {
        media.first { (lines: [String]) -> Bool in SdpText.value(lines, "a=mid:") == mid }
    }

    /// The DTLS fingerprint this phone offers («sha-256 AB:CD…»), media level first.
    func fingerprint(mid: String?) -> (algorithm: String, value: String)? {
        var text = mid.flatMap { (wanted: String) -> String? in section(mid: wanted).flatMap { SdpText.value($0, "a=fingerprint:") } }
        if text == nil { text = SdpText.value(session, "a=fingerprint:") }
        if text == nil { text = media.compactMap { SdpText.value($0, "a=fingerprint:") }.first }
        guard let words = text?.split(separator: " "), words.count == 2 else { return nil }
        return (algorithm: String(words[0]).lowercased(), value: String(words[1]))
    }

    /// «a=fmtp:96 a=1;b=x» → ["a": 1, "b": "x"] (numbers as numbers, as sdp-transform reads them).
    static func parameters(_ text: String) -> [String: Any] {
        var out: [String: Any] = [:]
        for part in text.split(separator: ";") {
            let item = part.trimmingCharacters(in: .whitespaces)
            guard let equal = item.firstIndex(of: "=") else { continue }
            let key = String(item[item.startIndex..<equal]), value = String(item[item.index(after: equal)...])
            if let number = Int(value) { out[key] = number } else { out[key] = value }
        }
        return out
    }

    static func parametersText(_ parameters: [String: Any]) -> String {
        return parameters.keys.sorted().map { (key: String) -> String in "\(key)=\(parameters[key] ?? "")" }.joined(separator: ";")
    }
}

/// Screen sharing through the server's SFU (server/src/sfu.js, mediasoup): the reference's `SfuSession`. The person
/// sharing uploads one copy, every frame sealed before it leaves the phone; viewers open frames only with keys
/// received over their checked peer-to-peer channels. The server never sees a picture.
///
/// Signalling: `{ type: 'sfu', id, op, … }` over the live line → `{ type: 'sfu.reply', id, ok, data | error }`;
/// `sfu.producer` (somebody started sending), `sfu.closed` (what this phone received has stopped). Main queue.
final class SfuSession {
    private let send: ([String: Any]) -> Bool
    /// A person's screen through the server (nil: it ended).
    var onRemote: ((String, LKRTCVideoTrack?) -> Void)?
    private let keys = ScreenFrameKeys()
    private var nextId = 1
    private var pending: [Int: (done: (Result<[String: Any], String>) -> Void, timer: Timer)] = [:]
    private var routerCaps: [String: Any] = [:]
    private var recv: SfuTransport?
    private var sendTransport: SfuTransport?
    private var sendSlot: LKRTCRtpTransceiver?
    private var sealer: LKRTCFrameCryptor?
    private var sendParameters: [String: Any]?
    private var producerId: String?
    private var consumers: [String: (peer: String, kind: String, mid: String, cryptor: LKRTCFrameCryptor, track: LKRTCMediaStreamTrack?)] = [:]
    private var closed = false
    private let streamId = UUID().uuidString.lowercased()

    init(send: @escaping ([String: Any]) -> Bool) {
        self.send = send
    }

    // MARK: Requests

    private func request(_ op: String, _ payload: [String: Any] = [:], done: @escaping (Result<[String: Any], String>) -> Void) {
        let id = nextId
        nextId += 1
        let timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { [weak self] (_: Timer) -> Void in
            guard let self, let waiting = self.pending.removeValue(forKey: id) else { return }
            waiting.done(.failure("Сервер не ответил."))
        }
        pending[id] = (done: done, timer: timer)
        var frame = payload
        frame["type"] = "sfu"
        frame["id"] = id
        frame["op"] = op
        if !send(frame) {
            timer.invalidate()
            pending[id] = nil
            done(.failure("Нет соединения с сервером."))
        }
    }

    /// Live-line messages for this session. True when handled.
    @discardableResult
    func handle(_ data: [String: Any]) -> Bool {
        guard let type = data["type"] as? String else { return false }
        if type == "sfu.reply" {
            guard let id = (data["id"] as? NSNumber)?.intValue, let waiting = pending.removeValue(forKey: id) else { return true }
            waiting.timer.invalidate()
            if data["ok"] as? Bool == true {
                waiting.done(.success(data["data"] as? [String: Any] ?? [:]))
            } else {
                waiting.done(.failure(data["error"] as? String ?? "Ошибка сервера демонстрации."))
            }
            return true
        }
        if type == "sfu.producer", let peer = data["peer"] as? String, let producer = data["producerId"] as? String {
            consume(peer, producer)
            return true
        }
        if type == "sfu.closed", let consumer = data["consumerId"] as? String {
            dropConsumer(consumer)
            return true
        }
        return false
    }

    // MARK: Start

    /// The server's codecs, the receiving transport, and whatever the others already send. `done`: whether it worked.
    func start(done: @escaping (Bool) -> Void) {
        request("caps") { [weak self] (result: Result<[String: Any], String>) -> Void in
            guard let self, !self.closed else { return }
            guard case .success(let body) = result, let caps = body["rtpCapabilities"] as? [String: Any] else { return done(false) }
            self.routerCaps = caps
            self.request("transport", ["direction": "recv"]) { [weak self] (result: Result<[String: Any], String>) -> Void in
                guard let self, !self.closed else { return }
                guard case .success(let params) = result, let transport = SfuTransport(params, sending: false) else { return done(false) }
                self.recv = transport
                self.request("producers") { [weak self] (result: Result<[String: Any], String>) -> Void in
                    guard let self, !self.closed else { return }
                    if case .success(let body) = result {
                        for item in body["producers"] as? [[String: Any]] ?? [] {
                            if let peer = item["peer"] as? String, let producer = item["producerId"] as? String { self.consume(peer, producer) }
                        }
                    }
                    done(true)
                }
            }
        }
    }

    /// What this phone can receive: the server's own codecs and the header extensions it sends (`getRecvRtpCapabilities`).
    private var receiveCaps: [String: Any] {
        var out = routerCaps
        let extensions = routerCaps["headerExtensions"] as? [[String: Any]] ?? []
        out["headerExtensions"] = extensions.filter { (item: [String: Any]) -> Bool in
            let direction = item["direction"] as? String ?? "sendrecv"
            return direction == "sendrecv" || direction == "sendonly"
        }
        return out
    }

    /// The header extensions the server takes from a sender of `kind` (`uri` set).
    private func sendableExtensions(_ kind: String) -> Set<String> {
        var out = Set<String>()
        for item in routerCaps["headerExtensions"] as? [[String: Any]] ?? [] {
            guard item["kind"] as? String == kind, let uri = item["uri"] as? String else { continue }
            let direction = item["direction"] as? String ?? "sendrecv"
            if direction == "sendrecv" || direction == "recvonly" { out.insert(uri) }
        }
        return out
    }

    private func connect(_ transport: SfuTransport, sdp: SdpText, mid: String?, done: @escaping (Bool) -> Void) {
        if transport.ready { return done(true) }
        guard let print = sdp.fingerprint(mid: mid) else { return done(false) }
        let dtls: [String: Any] = ["role": "client", "fingerprints": [["algorithm": print.algorithm, "value": print.value]]]
        request("connect", ["transportId": transport.id, "dtlsParameters": dtls]) { (result: Result<[String: Any], String>) -> Void in
            if case .success = result {
                transport.ready = true
                done(true)
            } else {
                done(false)
            }
        }
    }

    // MARK: Sending

    /// Share: one upload to the server, every frame sealed with `raw` (its index 0..15 lets the viewers pick the key).
    /// The sealing cryptor is on the sender before anything is negotiated, so no frame can leave unsealed.
    func publish(_ track: LKRTCVideoTrack, raw: Data, keyIndex: Int, maxBitrate: Int, done: @escaping (Bool) -> Void) {
        guard !closed else { return done(false) }
        keys.setOwnKey(index: keyIndex, raw: raw)
        if let transport = sendTransport {
            return produce(transport, track: track, keyIndex: keyIndex, maxBitrate: maxBitrate, done: done)
        }
        request("transport", ["direction": "send"]) { [weak self] (result: Result<[String: Any], String>) -> Void in
            guard let self, !self.closed else { return done(false) }
            guard case .success(let params) = result, let transport = SfuTransport(params, sending: true) else { return done(false) }
            self.sendTransport = transport
            self.produce(transport, track: track, keyIndex: keyIndex, maxBitrate: maxBitrate, done: done)
        }
    }

    private func produce(_ transport: SfuTransport, track: LKRTCVideoTrack, keyIndex: Int, maxBitrate: Int, done: @escaping (Bool) -> Void) {
        transport.serial { [weak self] (finish: @escaping () -> Void) -> Void in
            guard let self, !self.closed, let connection = transport.connection else { done(false); return finish() }
            let fail: () -> Void = { [weak self] in
                self?.sendSlot?.sender.track = nil
                done(false)
                finish()
            }
            // The slot made once is used again for every share (the server keeps at most two transports per person).
            if let slot = self.sendSlot, let sealer = self.sealer, var parameters = self.sendParameters {
                sealer.keyIndex = Int32(keyIndex)
                slot.sender.track = track
                self.cap(slot.sender, maxBitrate)
                if var encodings = parameters["encodings"] as? [[String: Any]], !encodings.isEmpty {
                    encodings[0]["maxBitrate"] = maxBitrate
                    parameters["encodings"] = encodings
                }
                self.sendParameters = parameters
                return self.askProduce(transport, parameters, done: done, finish: finish, fail: fail)
            }
            let slotInit = LKRTCRtpTransceiverInit()
            slotInit.direction = .sendOnly
            slotInit.streamIds = [self.streamId]
            let encoding = LKRTCRtpEncodingParameters()
            encoding.isActive = true
            encoding.maxBitrateBps = NSNumber(value: maxBitrate)
            encoding.maxFramerate = NSNumber(value: 60)
            slotInit.sendEncodings = [encoding]
            guard let slot = connection.addTransceiver(with: track, init: slotInit) else { return fail() }
            // Sealed from the very first frame; without a cryptor nothing goes out.
            guard let sealer = self.keys.sealer(slot.sender, index: keyIndex) else {
                slot.sender.track = nil
                slot.setDirection(.inactive, error: nil)
                return fail()
            }
            self.sendSlot = slot
            self.sealer = sealer
            let constraints = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
            connection.offer(for: constraints, completionHandler: { [weak self] (offer: LKRTCSessionDescription?, _: Error?) -> Void in
                DispatchQueue.main.async {
                    guard let self, !self.closed, let offer else { return fail() }
                    let parsed = SdpText(offer.sdp)
                    self.connect(transport, sdp: parsed, mid: nil) { [weak self] (fine: Bool) -> Void in
                        guard let self, fine, !self.closed else { return fail() }
                        connection.setLocalDescription(offer, completionHandler: { [weak self] (error: Error?) -> Void in
                            DispatchQueue.main.async {
                                guard let self, !self.closed, error == nil, let local = connection.localDescription else { return fail() }
                                let mid = slot.mid
                                guard let built = self.sendingParameters(SdpText(local.sdp), mid: mid, maxBitrate: maxBitrate) else { return fail() }
                                transport.sections = [built.section]
                                let answer = LKRTCSessionDescription(type: .answer, sdp: transport.remoteSdp())
                                connection.setRemoteDescription(answer, completionHandler: { [weak self] (error: Error?) -> Void in
                                    DispatchQueue.main.async {
                                        guard let self, !self.closed, error == nil else { return fail() }
                                        self.cap(slot.sender, maxBitrate)
                                        self.sendParameters = built.parameters
                                        self.askProduce(transport, built.parameters, done: done, finish: finish, fail: fail)
                                    }
                                })
                            }
                        })
                    }
                }
            })
        }
    }

    private func askProduce(_ transport: SfuTransport, _ parameters: [String: Any], done: @escaping (Bool) -> Void, finish: @escaping () -> Void, fail: @escaping () -> Void) {
        request("produce", ["transportId": transport.id, "kind": "video", "rtpParameters": parameters, "source": "screen"]) { [weak self] (result: Result<[String: Any], String>) -> Void in
            guard let self, !self.closed, case .success(let body) = result, let id = body["producerId"] as? String else { return fail() }
            self.producerId = id
            done(true)
            finish()
        }
    }

    private func cap(_ sender: LKRTCRtpSender, _ maxBitrate: Int) {
        let parameters = sender.parameters
        guard let encoding = parameters.encodings.first else { return }
        encoding.maxBitrateBps = NSNumber(value: maxBitrate)
        encoding.maxFramerate = NSNumber(value: 60)
        sender.parameters = parameters
    }

    /// The producer's RTP parameters read from this phone's offer (VP8 and its retransmission, the header extensions
    /// the server takes, the SSRCs and the CNAME — `getSendingRtpParameters`, `getRtpEncodings`), and the server's
    /// answer for the section (`RemoteAnswerMediaSection`, with `videoGoogleStartBitrate: 2000`).
    private func sendingParameters(_ sdp: SdpText, mid: String, maxBitrate: Int) -> (parameters: [String: Any], section: SfuTransport.Section)? {
        guard !mid.isEmpty, let lines = sdp.section(mid: mid) else { return nil }
        var rtpmap: [Int: String] = [:]
        var fmtp: [Int: [String: Any]] = [:]
        var feedback: [Int: [[String: String]]] = [:]
        var extensions: [(id: Int, uri: String)] = []
        var ssrcs: [Int] = []
        var groups: [(Int, Int)] = []
        var cname = ""
        for line in lines {
            if line.hasPrefix("a=rtpmap:"), let space = line.firstIndex(of: " "), let pt = Int(line[line.index(line.startIndex, offsetBy: 9)..<space]) {
                rtpmap[pt] = String(line[line.index(after: space)...])
            } else if line.hasPrefix("a=fmtp:"), let space = line.firstIndex(of: " "), let pt = Int(line[line.index(line.startIndex, offsetBy: 7)..<space]) {
                fmtp[pt] = SdpText.parameters(String(line[line.index(after: space)...]))
            } else if line.hasPrefix("a=rtcp-fb:") {
                let words = line.dropFirst(10).split(separator: " ").map(String.init)
                if words.count >= 2, let pt = Int(words[0]) {
                    feedback[pt, default: []].append(["type": words[1], "parameter": words.count > 2 ? words[2] : ""])
                }
            } else if line.hasPrefix("a=extmap:") {
                let words = line.dropFirst(9).split(separator: " ").map(String.init)
                if words.count >= 2, let id = Int(words[0].split(separator: "/").first ?? "") { extensions.append((id: id, uri: words[1])) }
            } else if line.hasPrefix("a=ssrc-group:FID ") {
                let words = line.dropFirst(17).split(separator: " ").compactMap { Int($0) }
                if words.count == 2 { groups.append((words[0], words[1])) }
            } else if line.hasPrefix("a=ssrc:") {
                let words = line.dropFirst(7).split(separator: " ", maxSplits: 1).map(String.init)
                if let ssrc = Int(words.first ?? ""), !ssrcs.contains(ssrc) { ssrcs.append(ssrc) }
                if words.count == 2, words[1].hasPrefix("cname:") { cname = String(words[1].dropFirst(6)) }
            }
        }
        guard let vp8 = rtpmap.keys.sorted().first(where: { (pt: Int) -> Bool in rtpmap[pt]?.lowercased() == "vp8/90000" }) else { return nil }
        let rtx = rtpmap.keys.sorted().first { (pt: Int) -> Bool in
            rtpmap[pt]?.lowercased() == "rtx/90000" && (fmtp[pt]?["apt"] as? Int) == vp8
        }
        guard let ssrc = groups.first(where: { (pair: (Int, Int)) -> Bool in ssrcs.contains(pair.0) })?.0 ?? ssrcs.first else { return nil }
        let rtxSsrc = groups.first { (pair: (Int, Int)) -> Bool in pair.0 == ssrc }?.1
        // The server's VP8 feedback (nack, nack pli, ccm fir, goog-remb, transport-cc): only what both sides know.
        let known: Set<String> = ["nack", "nack pli", "ccm fir", "goog-remb", "transport-cc"]
        var vp8Feedback = (feedback[vp8] ?? []).filter { (fb: [String: String]) -> Bool in
            let key = ((fb["type"] ?? "") + " " + (fb["parameter"] ?? "")).trimmingCharacters(in: .whitespaces)
            return known.contains(key)
        }
        let takes = sendableExtensions("video")
        let chosen = extensions.filter { (ext: (id: Int, uri: String)) -> Bool in
            takes.contains(ext.uri) && ext.uri != "https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension"
        }
        let codecs: [[String: Any]] = {
            var list: [[String: Any]] = [["mimeType": "video/VP8", "payloadType": vp8, "clockRate": 90000, "parameters": fmtp[vp8] ?? [:], "rtcpFeedback": vp8Feedback]]
            if let rtx { list.append(["mimeType": "video/rtx", "payloadType": rtx, "clockRate": 90000, "parameters": ["apt": vp8], "rtcpFeedback": [] as [[String: String]]]) }
            return list
        }()
        var encoding: [String: Any] = ["ssrc": ssrc, "maxBitrate": maxBitrate, "maxFramerate": 60]
        if let rtxSsrc, rtx != nil { encoding["rtx"] = ["ssrc": rtxSsrc] }
        let parameters: [String: Any] = [
            "mid": mid,
            "codecs": codecs,
            "headerExtensions": chosen.map { (ext: (id: Int, uri: String)) -> [String: Any] in ["uri": ext.uri, "id": ext.id, "encrypt": false, "parameters": [String: Any]()] },
            "encodings": [encoding],
            "rtcp": ["cname": cname, "reducedSize": true],
        ]
        // The answer: transport-cc when there is its extension, REMB otherwise (`getSendingRemoteRtpParameters`).
        let uris = Set(chosen.map { (ext: (id: Int, uri: String)) -> String in ext.uri })
        if uris.contains("http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01") {
            vp8Feedback = vp8Feedback.filter { (fb: [String: String]) -> Bool in fb["type"] != "goog-remb" }
        } else if uris.contains("http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time") {
            vp8Feedback = vp8Feedback.filter { (fb: [String: String]) -> Bool in fb["type"] != "transport-cc" }
        } else {
            vp8Feedback = vp8Feedback.filter { (fb: [String: String]) -> Bool in fb["type"] != "transport-cc" && fb["type"] != "goog-remb" }
        }
        var body: [String] = ["a=rtpmap:\(vp8) VP8/90000"]
        if let rtx { body.append("a=rtpmap:\(rtx) rtx/90000") }
        body.append("a=fmtp:\(vp8) x-google-start-bitrate=2000")
        if let rtx { body.append("a=fmtp:\(rtx) apt=\(vp8)") }
        for fb in vp8Feedback {
            let parameter = fb["parameter"] ?? ""
            body.append("a=rtcp-fb:\(vp8) \(fb["type"] ?? "")" + (parameter.isEmpty ? "" : " " + parameter))
        }
        for ext in chosen { body.append("a=extmap:\(ext.id) \(ext.uri)") }
        body.append("a=recvonly")
        let payloads = rtx.map { "\(vp8) \($0)" } ?? "\(vp8)"
        return (parameters: parameters, section: SfuTransport.Section(mid: mid, kind: "video", body: body, payloads: payloads))
    }

    /// Stops sending: the picture leaves the slot and the server forgets the producer (the slot stays for the next share).
    func unpublish() {
        sendSlot?.sender.track = nil
        if let id = producerId {
            producerId = nil
            request("close", ["producerId": id]) { (_: Result<[String: Any], String>) -> Void in }
        }
    }

    // MARK: Receiving

    /// A key a person sent over their own checked peer-to-peer channel.
    func setPeerKey(_ peer: String, index: Int, raw: Data) { keys.setPeerKey(peer, index: index, raw: raw) }

    private func consume(_ peer: String, _ producer: String) {
        guard !closed, let transport = recv else { return }
        request("consume", ["transportId": transport.id, "producerId": producer, "rtpCapabilities": receiveCaps]) { [weak self] (result: Result<[String: Any], String>) -> Void in
            guard let self, !self.closed, case .success(let body) = result, let consumer = body["consumerId"] as? String,
                  let kind = body["kind"] as? String, let parameters = body["rtpParameters"] as? [String: Any] else { return }
            self.receive(transport, peer: peer, consumer: consumer, kind: kind, parameters: parameters)
        }
    }

    /// The server's offer gets one more section for the consumer (`RemoteOfferMediaSection`); this phone answers it.
    private func receive(_ transport: SfuTransport, peer: String, consumer: String, kind: String, parameters: [String: Any]) {
        transport.serial { [weak self] (finish: @escaping () -> Void) -> Void in
            guard let self, !self.closed, let connection = transport.connection else { return finish() }
            let mid = (parameters["mid"] as? String) ?? String(transport.sections.count)
            guard let section = SfuSession.offerSection(mid: mid, kind: kind, parameters: parameters, trackId: "consumer-" + consumer) else { return finish() }
            if let reuse = transport.sections.firstIndex(where: { (item: SfuTransport.Section) -> Bool in item.closed && item.kind == kind }) {
                transport.sections[reuse] = section
            } else {
                transport.sections.append(section)
            }
            let offer = LKRTCSessionDescription(type: .offer, sdp: transport.remoteSdp())
            let fail: () -> Void = { [weak self] in
                self?.closeSection(transport, mid: mid)
                finish()
            }
            connection.setRemoteDescription(offer, completionHandler: { [weak self] (error: Error?) -> Void in
                DispatchQueue.main.async {
                    guard let self, !self.closed, error == nil else { return fail() }
                    let constraints = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
                    connection.answer(for: constraints, completionHandler: { [weak self] (made: LKRTCSessionDescription?, _: Error?) -> Void in
                        DispatchQueue.main.async {
                            guard let self, !self.closed, let made else { return fail() }
                            // A computer's sound in stereo when the sender says so (`applyCodecParameters`).
                            let sdp = SfuSession.stereoAnswer(made.sdp, mid: mid, parameters: parameters)
                            let answer = LKRTCSessionDescription(type: .answer, sdp: sdp)
                            self.connect(transport, sdp: SdpText(sdp), mid: mid) { [weak self] (fine: Bool) -> Void in
                                guard let self, fine, !self.closed else { return fail() }
                                connection.setLocalDescription(answer, completionHandler: { [weak self] (error: Error?) -> Void in
                                    DispatchQueue.main.async {
                                        guard let self, !self.closed, error == nil,
                                              let slot = connection.transceivers.first(where: { (item: LKRTCRtpTransceiver) -> Bool in item.mid == mid }) else { return fail() }
                                        // Never shown without the opener: frames that cannot be opened are dropped.
                                        guard let opener = self.keys.opener(slot.receiver, peer: peer) else { return fail() }
                                        self.consumers[consumer] = (peer: peer, kind: kind, mid: mid, cryptor: opener, track: slot.receiver.track)
                                        finish()
                                        self.request("resume", ["consumerId": consumer]) { (_: Result<[String: Any], String>) -> Void in }
                                        if kind == "video", let video = slot.receiver.track as? LKRTCVideoTrack { self.onRemote?(peer, video) }
                                    }
                                })
                            }
                        }
                    })
                }
            })
        }
    }

    private static func offerSection(mid: String, kind: String, parameters: [String: Any], trackId: String) -> SfuTransport.Section? {
        guard let codecs = parameters["codecs"] as? [[String: Any]], !codecs.isEmpty,
              let encoding = (parameters["encodings"] as? [[String: Any]])?.first else { return nil }
        let rtcp = parameters["rtcp"] as? [String: Any] ?? [:]
        let cname = rtcp["cname"] as? String ?? ""
        var body: [String] = []
        var payloads: [String] = []
        for codec in codecs {
            guard let pt = (codec["payloadType"] as? NSNumber)?.intValue, let mime = codec["mimeType"] as? String,
                  let rate = (codec["clockRate"] as? NSNumber)?.intValue, let slash = mime.firstIndex(of: "/") else { continue }
            let name = String(mime[mime.index(after: slash)...])
            let channels = (codec["channels"] as? NSNumber)?.intValue ?? 1
            body.append("a=rtpmap:\(pt) \(name)/\(rate)" + (channels > 1 ? "/\(channels)" : ""))
            payloads.append(String(pt))
        }
        for codec in codecs {
            guard let pt = (codec["payloadType"] as? NSNumber)?.intValue else { continue }
            let params = codec["parameters"] as? [String: Any] ?? [:]
            if !params.isEmpty { body.append("a=fmtp:\(pt) " + SdpText.parametersText(params)) }
            for fb in codec["rtcpFeedback"] as? [[String: Any]] ?? [] {
                guard let type = fb["type"] as? String else { continue }
                let parameter = fb["parameter"] as? String ?? ""
                body.append("a=rtcp-fb:\(pt) \(type)" + (parameter.isEmpty ? "" : " " + parameter))
            }
        }
        for ext in parameters["headerExtensions"] as? [[String: Any]] ?? [] {
            guard let uri = ext["uri"] as? String, let id = (ext["id"] as? NSNumber)?.intValue else { continue }
            body.append("a=extmap:\(id) \(uri)")
        }
        body.append("a=extmap-allow-mixed")
        body.append("a=msid:\(cname) \(trackId)")
        body.append("a=sendonly")
        if let ssrc = (encoding["ssrc"] as? NSNumber)?.int64Value {
            if !cname.isEmpty { body.append("a=ssrc:\(ssrc) cname:\(cname)") }
            if let rtx = ((encoding["rtx"] as? [String: Any])?["ssrc"] as? NSNumber)?.int64Value {
                if !cname.isEmpty { body.append("a=ssrc:\(rtx) cname:\(cname)") }
                body.append("a=ssrc-group:FID \(ssrc) \(rtx)")
            }
        }
        return SfuTransport.Section(mid: mid, kind: kind, body: body, payloads: payloads.joined(separator: " "))
    }

    private static func stereoAnswer(_ sdp: String, mid: String, parameters: [String: Any]) -> String {
        guard let codecs = parameters["codecs"] as? [[String: Any]],
              let opus = codecs.first(where: { (codec: [String: Any]) -> Bool in (codec["mimeType"] as? String)?.lowercased() == "audio/opus" }),
              let pt = (opus["payloadType"] as? NSNumber)?.intValue,
              ((opus["parameters"] as? [String: Any])?["sprop-stereo"] as? NSNumber)?.intValue == 1 else { return sdp }
        let eol = sdp.contains("\r\n") ? "\r\n" : "\n"
        var lines = sdp.components(separatedBy: eol)
        var inside = false
        var at: Int?
        var mapAt: Int?
        for (index, line) in lines.enumerated() {
            if line.hasPrefix("m=") { inside = false }
            if line == "a=mid:" + mid { inside = true }
            if line.hasPrefix("a=fmtp:\(pt) ") { at = at ?? index }
            if line.hasPrefix("a=rtpmap:\(pt) ") { mapAt = mapAt ?? index }
            _ = inside
        }
        if let at {
            if !lines[at].contains("stereo=1") { lines[at] += ";stereo=1" }
        } else if let mapAt {
            lines.insert("a=fmtp:\(pt) stereo=1", at: mapAt + 1)
        }
        return lines.joined(separator: eol)
    }

    private func closeSection(_ transport: SfuTransport, mid: String) {
        guard let index = transport.sections.firstIndex(where: { (item: SfuTransport.Section) -> Bool in item.mid == mid }) else { return }
        // The first section carries the shared transport: it is only made inactive, never closed.
        if index == 0 {
            if let last = transport.sections[0].body.lastIndex(where: { (line: String) -> Bool in line == "a=sendonly" }) { transport.sections[0].body[last] = "a=inactive" }
        } else {
            transport.sections[index].closed = true
        }
    }

    private func dropConsumer(_ id: String) {
        guard let item = consumers.removeValue(forKey: id), let transport = recv else { return }
        item.cryptor.enabled = false
        transport.serial { [weak self] (finish: @escaping () -> Void) -> Void in
            guard let self, !self.closed, let connection = transport.connection else { return finish() }
            self.closeSection(transport, mid: item.mid)
            let offer = LKRTCSessionDescription(type: .offer, sdp: transport.remoteSdp())
            connection.setRemoteDescription(offer, completionHandler: { (error: Error?) -> Void in
                guard error == nil else { return finish() }
                let constraints = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
                connection.answer(for: constraints, completionHandler: { (made: LKRTCSessionDescription?, _: Error?) -> Void in
                    guard let made else { return finish() }
                    connection.setLocalDescription(made, completionHandler: { (_: Error?) -> Void in finish() })
                })
            })
        }
        if item.kind == "video", !consumers.values.contains(where: { (other: (peer: String, kind: String, mid: String, cryptor: LKRTCFrameCryptor, track: LKRTCMediaStreamTrack?)) -> Bool in other.peer == item.peer && other.kind == "video" }) {
            onRemote?(item.peer, nil)
        }
    }

    /// Somebody left: their picture goes (their keys are replaced at the next share; the provider goes with the session).
    func forget(_ peer: String) {
        for (id, item) in consumers where item.peer == peer { dropConsumer(id) }
    }

    func close() {
        closed = true
        for waiting in pending.values {
            waiting.timer.invalidate()
            waiting.done(.failure("closed"))
        }
        pending = [:]
        for item in consumers.values { item.cryptor.enabled = false }
        consumers = [:]
        sealer?.enabled = false
        sealer = nil
        sendSlot?.sender.track = nil
        sendSlot = nil
        recv?.close()
        sendTransport?.close()
        recv = nil
        sendTransport = nil
        onRemote = nil
    }
}
