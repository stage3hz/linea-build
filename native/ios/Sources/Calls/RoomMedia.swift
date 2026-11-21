import AVFoundation
import LiveKitWebRTC
import UIKit

/// The microphone of the room this phone is in: one track, shared by the connections to everyone inside.
/// The phone's own echo cancellation, noise suppression and gain, as in a one-to-one call (CallMedia.swift).
final class RoomMicrophone {
    fileprivate let track: LKRTCAudioTrack
    fileprivate let streamId = UUID().uuidString.lowercased()

    /// The microphone is opened here: the permission was asked before.
    init() {
        let processing = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: ["googAutoGainControl": "true", "googNoiseSuppression": "true", "googEchoCancellation": "true"])
        let source = CallMedia.factory.audioSource(with: processing)
        track = CallMedia.factory.audioTrack(with: source, trackId: UUID().uuidString.lowercased())
    }

    func set(on: Bool) { track.isEnabled = on }
}

/// The connection to one person inside a room (a room is a full mesh: every two people have their own connection,
/// encrypted by its own keys — DTLS-SRTP; a relay, when one is needed, forwards ciphertext). Voice only: the
/// reference's room carries no camera. Next to the voice runs a small text channel (`screen-control`, the name the
/// reference gives it) that carries «music for everyone».
///
/// Until the engine has checked the connection end to end (RoomVoice.swift), this phone's microphone is not put
/// into it and what arrives over it is not played.
///
/// With CallMedia.swift, the only code that knows WebRTC. It decides nothing; everything is told on the main queue.
final class RoomPeerMedia: NSObject, LKRTCPeerConnectionDelegate, LKRTCDataChannelDelegate {
    private var connection: LKRTCPeerConnection?
    private let microphone: RoomMicrophone
    private var micSender: LKRTCRtpSender?
    private var channel: LKRTCDataChannel?
    private var audible = false
    private var lastState = ""
    private var closed = false
    private var gatherDone: ((String) -> Void)?
    private var gatherTimer: Timer?

    /// The connection's state: "new", "connecting", "connected", "disconnected", "failed" or "closed".
    var onState: ((String) -> Void)?
    /// A text arrived over the peer-to-peer channel.
    var onMessage: ((String) -> Void)?
    /// The peer-to-peer channel opened.
    var onChannelOpen: (() -> Void)?
    // ScreenShare: the slot of a shared screen (Sources/ScreenShare): what this phone sends there, and the person's
    // picture that arrives over the connection (it shows only while their channel says they share).
    private var screenSender: LKRTCRtpSender?
    var onVideo: ((LKRTCVideoTrack) -> Void)?

    /// `iceServers`: the server's answer to `GET /calls/ice`. `initiator`: this phone walked in and calls the
    /// person who was already inside (it also opens the text channel). nil when the connection cannot be made.
    init?(iceServers: [[String: Any]], microphone: RoomMicrophone, initiator: Bool) {
        self.microphone = microphone
        super.init()
        let config = LKRTCConfiguration()
        var servers: [LKRTCIceServer] = []
        for server in iceServers {
            var urls: [String] = []
            if let list = server["urls"] as? [String] { urls = list } else if let one = server["urls"] as? String { urls = [one] }
            if urls.isEmpty { continue }
            servers.append(LKRTCIceServer(urlStrings: urls, username: server["username"] as? String, credential: server["credential"] as? String))
        }
        config.iceServers = servers
        config.bundlePolicy = .maxBundle
        config.sdpSemantics = .unifiedPlan
        let none = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let made = CallMedia.factory.peerConnection(with: config, constraints: none, delegate: self) else { return nil }
        connection = made
        // ScreenShare: as the reference, the newcomer reserves a video slot before the first offer (a screen that is
        // started or stopped only swaps its picture, nothing is negotiated again). The answering side takes the slot
        // the offer brings (`takeScreenSlot`).
        if initiator {
            let slot = LKRTCRtpTransceiverInit()
            slot.direction = .sendRecv
            screenSender = made.addTransceiver(of: .video, init: slot)?.sender
        }
        // The microphone's place is agreed now, but the sound goes in only once the connection is checked.
        let sender = made.add(microphone.track, streamIds: [microphone.streamId])
        sender?.track = nil
        micSender = sender
        // ScreenShare: after the microphone, the slot of a shared computer's sound (the reference's second audio
        // section: a computer sends its sound there; this phone only listens to it).
        if initiator {
            let sound = LKRTCRtpTransceiverInit()
            sound.direction = .sendRecv
            _ = made.addTransceiver(of: .audio, init: sound)
        }
        if initiator, let opened = made.dataChannel(forLabel: "screen-control", configuration: LKRTCDataChannelConfiguration()) {
            opened.delegate = self
            channel = opened
        }
    }

    // MARK: What is let through

    /// The connection is checked (or no longer is): this phone's microphone goes into it, or is taken out.
    func setMicrophone(live: Bool) { micSender?.track = live ? microphone.track : nil }

    /// Whether what arrives over this connection is played.
    func setAudible(_ on: Bool) {
        audible = on
        guard let connection else { return }
        for receiver in connection.receivers where receiver.track?.kind == "audio" { receiver.track?.isEnabled = on }
    }

    // ScreenShare: this phone's screen goes into the connection (nil: out of it), with the quality's cap.
    func setScreen(_ track: LKRTCVideoTrack?, maxBitrate: Int?) {
        guard let sender = screenSender else { return }
        sender.track = track
        guard track != nil, let maxBitrate else { return }
        let parameters = sender.parameters
        guard let encoding = parameters.encodings.first else { return }
        encoding.maxBitrateBps = NSNumber(value: maxBitrate)
        encoding.maxFramerate = NSNumber(value: 60)
        sender.parameters = parameters
    }

    // ScreenShare: the answering side takes the video slot of the offer as its own, and may send its screen there.
    private func takeScreenSlot() {
        guard screenSender == nil, let connection else { return }
        for transceiver in connection.transceivers where transceiver.mediaType == .video && !transceiver.mid.isEmpty {
            transceiver.setDirection(.sendRecv, error: nil)
            screenSender = transceiver.sender
            return
        }
    }

    /// Sends a text over the peer-to-peer channel; false when the channel is not open.
    func send(_ text: String) -> Bool {
        guard let channel, channel.readyState == .open, let data = text.data(using: .utf8) else { return false }
        return channel.sendData(LKRTCDataBuffer(data: data, isBinary: false))
    }

    // MARK: Offers and answers

    var signalingState: String {
        guard let connection else { return "closed" }
        switch connection.signalingState {
        case .stable: return "stable"
        case .haveLocalOffer: return "have-local-offer"
        case .haveLocalPrAnswer: return "have-local-pranswer"
        case .haveRemoteOffer: return "have-remote-offer"
        case .haveRemotePrAnswer: return "have-remote-pranswer"
        case .closed: return "closed"
        @unknown default: return "closed"
        }
    }

    /// This phone's SDP as the connection holds it now (with the addresses gathered so far).
    var localSdp: String { connection?.localDescription?.sdp ?? "" }

    /// A new offer; `iceRestart`: with new addresses for the same connection. nil when it cannot be made.
    func makeOffer(iceRestart: Bool, done: @escaping (String?) -> Void) {
        guard let connection else { return done(nil) }
        let mandatory: [String: String] = iceRestart ? ["IceRestart": "true"] : [:]
        let constraints = LKRTCMediaConstraints(mandatoryConstraints: mandatory, optionalConstraints: nil)
        connection.offer(for: constraints, completionHandler: { (description: LKRTCSessionDescription?, _: Error?) -> Void in
            let sdp = (description?.sdp).map { (made: String) -> String in ScreenShareModel.stereoScreenAudio(made) } // ScreenShare: stereo for a computer's sound
            DispatchQueue.main.async { done(sdp) }
        })
    }

    func makeAnswer(done: @escaping (String?) -> Void) {
        guard let connection else { return done(nil) }
        let constraints = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        connection.answer(for: constraints, completionHandler: { (description: LKRTCSessionDescription?, _: Error?) -> Void in
            let sdp = (description?.sdp).map { (made: String) -> String in ScreenShareModel.stereoScreenAudio(made) } // ScreenShare: stereo for a computer's sound
            DispatchQueue.main.async { done(sdp) }
        })
    }

    private static func sessionDescription(_ kind: String, _ sdp: String) -> LKRTCSessionDescription {
        let type: LKRTCSdpType = kind == "offer" ? .offer : kind == "answer" ? .answer : .rollback
        return LKRTCSessionDescription(type: type, sdp: sdp)
    }

    /// `kind`: "offer", "answer" or "rollback" (takes this phone's pending offer back). `done`: whether it was taken.
    func setLocal(_ kind: String, sdp: String, done: @escaping (Bool) -> Void) {
        guard let connection else { return done(false) }
        connection.setLocalDescription(RoomPeerMedia.sessionDescription(kind, sdp), completionHandler: { (error: Error?) -> Void in
            let fine = error == nil
            DispatchQueue.main.async { done(fine) }
        })
    }

    func setRemote(_ kind: String, sdp: String, done: @escaping (Bool) -> Void) {
        guard let connection else { return done(false) }
        connection.setRemoteDescription(RoomPeerMedia.sessionDescription(kind, sdp), completionHandler: { (error: Error?) -> Void in
            let fine = error == nil
            DispatchQueue.main.async { [weak self] in
                if fine && kind == "offer" { self?.takeScreenSlot() } // ScreenShare: before the answer is made
                done(fine)
            }
        })
    }

    // MARK: The addresses (non-trickle ICE: they travel once, inside the offer or the answer)

    /// Calls back once with this phone's SDP when its addresses are inside, or after `timeout` with what there is.
    /// `fresh`: only a gathering that finishes from now on counts (after an ICE restart the connection still says
    /// «complete» from the round before). One wait at a time: a new one takes the place of the old.
    func whenGathered(fresh: Bool, timeout: TimeInterval, done: @escaping (String) -> Void) {
        cancelGathering()
        if !fresh, connection?.iceGatheringState == .complete { return done(localSdp) }
        gatherDone = done
        gatherTimer = Timer.scheduledTimer(withTimeInterval: timeout, repeats: false) { [weak self] (_: Timer) -> Void in self?.gatheringSettled() }
    }

    func cancelGathering() {
        gatherTimer?.invalidate()
        gatherTimer = nil
        gatherDone = nil
    }

    private func gatheringSettled() {
        guard let done = gatherDone else { return }
        cancelGathering()
        done(localSdp)
    }

    // MARK: The link

    /// Caps what the microphone may send, bits per second; nil lifts the cap.
    func capAudio(bitrate: Double?) {
        guard let sender = micSender else { return }
        let parameters = sender.parameters
        guard let encoding = parameters.encodings.first else { return }
        if let bitrate { encoding.maxBitrateBps = NSNumber(value: Int(bitrate)) } else { encoding.maxBitrateBps = nil }
        sender.parameters = parameters
    }

    /// The connection's own statistics as plain entries (`id`, `type` and the numbers, words and flags of each).
    func statistics(done: @escaping ([[String: Any]]) -> Void) {
        guard let connection else { return done([]) }
        connection.statistics(completionHandler: { (report: LKRTCStatisticsReport) -> Void in
            var list: [[String: Any]] = []
            for (_, entry) in report.statistics {
                var item: [String: Any] = [:]
                for (key, value) in entry.values {
                    if let number = value as? NSNumber {
                        if number.doubleValue.isFinite { item[key] = number }
                    } else if let words = value as? String {
                        item[key] = words
                    }
                }
                item["id"] = entry.id
                item["type"] = entry.type
                list.append(item)
            }
            DispatchQueue.main.async { done(list) }
        })
    }

    private static func words(_ state: LKRTCPeerConnectionState) -> String {
        switch state {
        case .new: return "new"
        case .connecting: return "connecting"
        case .connected: return "connected"
        case .disconnected: return "disconnected"
        case .failed: return "failed"
        case .closed: return "closed"
        @unknown default: return "closed"
        }
    }

    /// Tells the state when it is not the one told last. Also asked by the engine's own beat, so a change is
    /// never missed.
    func tellState() {
        guard let connection, !closed else { return }
        let state = RoomPeerMedia.words(connection.connectionState)
        if state == lastState { return }
        lastState = state
        onState?(state)
    }

    /// The person left, or this phone did: the connection is closed. Nothing is told after it.
    func close() {
        closed = true
        cancelGathering()
        onState = nil
        onMessage = nil
        onChannelOpen = nil
        onVideo = nil // ScreenShare
        screenSender = nil // ScreenShare
        channel?.delegate = nil
        channel?.close()
        channel = nil
        micSender = nil
        connection?.close()
        connection = nil
    }

    // MARK: LKRTCPeerConnectionDelegate (called on WebRTC's own thread)

    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange stateChanged: LKRTCSignalingState) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didAdd stream: LKRTCMediaStream) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove stream: LKRTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: LKRTCPeerConnection) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceConnectionState) {
        DispatchQueue.main.async { [weak self] in self?.tellState() }
    }
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceGatheringState) {
        let complete = newState == .complete
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.closed, complete else { return }
            self.gatheringSettled()
        }
    }
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didGenerate candidate: LKRTCIceCandidate) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove candidates: [LKRTCIceCandidate]) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didOpen dataChannel: LKRTCDataChannel) {
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.closed, dataChannel.label == "screen-control" else { return }
            self.channel?.delegate = nil
            dataChannel.delegate = self
            self.channel = dataChannel
            if dataChannel.readyState == .open { self.onChannelOpen?() }
        }
    }
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCPeerConnectionState) {
        DispatchQueue.main.async { [weak self] in self?.tellState() }
    }
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didAdd rtpReceiver: LKRTCRtpReceiver, streams mediaStreams: [LKRTCMediaStream]) {
        let video = rtpReceiver.track as? LKRTCVideoTrack // ScreenShare: the person's screen slot
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.closed else { return }
            // Whatever arrives is silent until the connection is checked.
            self.setAudible(self.audible)
            if let video { self.onVideo?(video) } // ScreenShare
        }
    }

    // MARK: LKRTCDataChannelDelegate (called on WebRTC's own thread)

    func dataChannelDidChangeState(_ dataChannel: LKRTCDataChannel) {
        let open = dataChannel.readyState == .open
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.closed, self.channel === dataChannel, open else { return }
            self.onChannelOpen?()
        }
    }

    func dataChannel(_ dataChannel: LKRTCDataChannel, didReceiveMessageWith buffer: LKRTCDataBuffer) {
        guard !buffer.isBinary, let text = String(data: buffer.data, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.closed, self.channel === dataChannel else { return }
            self.onMessage?(text)
        }
    }
}
