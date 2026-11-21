import AVFoundation
import LiveKitWebRTC
import UIKit

/// The media of one call: the microphone, the camera, and the connection between the two phones (WebRTC —
/// LiveKit's build of milestone 150, the very one the reference app links through react-native-webrtc; its
/// classes carry the `LK` prefix). The picture and the sound go phone to phone, encrypted by the connection's own
/// keys (DTLS-SRTP); a relay, when one is needed, forwards ciphertext.
///
/// This is the only file that knows WebRTC. It decides nothing: the engine (CallEngine.swift) tells it what to
/// do and hears what happened, always on the main queue.
final class CallMedia: NSObject, LKRTCPeerConnectionDelegate {
    /// One factory for the app's life: the audio module of the reference (the audio-engine one, with the phone's
    /// own echo cancellation, noise suppression and gain), the default video codecs.
    private static let factory: LKRTCPeerConnectionFactory = {
        let encoder = LKRTCDefaultVideoEncoderFactory()
        let decoder = LKRTCDefaultVideoDecoderFactory()
        return LKRTCPeerConnectionFactory(audioDeviceModuleType: .audioEngine, bypassVoiceProcessing: false, encoderFactory: encoder, decoderFactory: decoder, audioProcessingModule: nil)
    }()

    private var connection: LKRTCPeerConnection?
    private let streamId = UUID().uuidString.lowercased()
    private var audioTrack: LKRTCAudioTrack?
    private var videoSource: LKRTCVideoSource?
    private var capturer: LKRTCCameraVideoCapturer?
    private var frontCamera = true
    private var lastState = ""
    private var closed = false
    fileprivate var localVideoTrack: LKRTCVideoTrack?
    fileprivate var remoteVideoTrack: LKRTCVideoTrack?

    /// A local address was found (the candidate line, e.g. «… typ relay …»).
    var onCandidate: ((String) -> Void)?
    /// The gathering of addresses moved on (see `gatheringComplete`).
    var onGathering: (() -> Void)?
    /// The connection's state: "new", "connecting", "connected", "disconnected", "failed" or "closed".
    var onState: ((String) -> Void)?
    /// The other side's picture appeared.
    var onRemoteVideo: (() -> Void)?

    /// `iceServers`: the server's answer to `GET /calls/ice` (`urls` — a text or a list, `username`, `credential`).
    /// The microphone is opened here, and the camera for a video call: the permissions were asked before.
    /// nil when the connection cannot be made.
    init?(iceServers: [[String: Any]], video: Bool) {
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
        // Noise suppression, echo cancellation and automatic gain: the phone's own audio processing.
        let processing = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: ["googAutoGainControl": "true", "googNoiseSuppression": "true", "googEchoCancellation": "true"])
        let source = CallMedia.factory.audioSource(with: processing)
        let track = CallMedia.factory.audioTrack(with: source, trackId: UUID().uuidString.lowercased())
        audioTrack = track
        _ = made.add(track, streamIds: [streamId])
        if video { addCamera() }
    }

    // MARK: The camera

    var hasCamera: Bool { localVideoTrack != nil }

    /// Adds this phone's camera to the call (at the start of a video call, or when «Видео» is switched on during
    /// an audio call — a new offer has to follow then).
    func addCamera() {
        guard let connection, localVideoTrack == nil else { return }
        let source = CallMedia.factory.videoSource()
        let track = CallMedia.factory.videoTrack(with: source, trackId: UUID().uuidString.lowercased())
        videoSource = source
        localVideoTrack = track
        capturer = LKRTCCameraVideoCapturer(delegate: source)
        _ = connection.add(track, streamIds: [streamId])
        startCamera()
    }

    /// The front camera first; 640×480 at 30 frames a second, as the reference asks (or the nearest the camera has).
    private func startCamera() {
        guard let capturer else { return }
        let wanted: AVCaptureDevice.Position = frontCamera ? .front : .back
        let devices = LKRTCCameraVideoCapturer.captureDevices()
        guard let device = devices.first(where: { (item: AVCaptureDevice) -> Bool in item.position == wanted }) ?? devices.first else { return }
        var chosen: AVCaptureDevice.Format? = nil
        var best = Int.max
        for format in LKRTCCameraVideoCapturer.supportedFormats(for: device) {
            let size = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            let distance = abs(Int(size.width) - 640) + abs(Int(size.height) - 480)
            if distance < best {
                best = distance
                chosen = format
            }
        }
        guard let format = chosen else { return }
        var top = 30.0
        for range in format.videoSupportedFrameRateRanges { top = min(top, max(range.maxFrameRate, 1)) }
        capturer.startCapture(with: device, format: format, fps: Int(top))
    }

    func setCamera(on: Bool) { localVideoTrack?.isEnabled = on }

    /// The other camera of the phone.
    func flipCamera() {
        guard let capturer else { return }
        frontCamera.toggle()
        capturer.stopCapture { [weak self] in
            DispatchQueue.main.async { self?.startCamera() }
        }
    }

    var usesFrontCamera: Bool { frontCamera }

    func setMicrophone(on: Bool) { audioTrack?.isEnabled = on }

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

    var gatheringComplete: Bool { connection?.iceGatheringState == .complete }
    /// This phone's SDP as the connection holds it now (with the addresses gathered so far).
    var localSdp: String { connection?.localDescription?.sdp ?? "" }

    /// A new offer; `iceRestart`: with new addresses for the same call. nil when it cannot be made.
    func makeOffer(iceRestart: Bool, done: @escaping (String?) -> Void) {
        guard let connection else { return done(nil) }
        let mandatory: [String: String] = iceRestart ? ["IceRestart": "true"] : [:]
        let constraints = LKRTCMediaConstraints(mandatoryConstraints: mandatory, optionalConstraints: nil)
        connection.offer(for: constraints, completionHandler: { (description: LKRTCSessionDescription?, _: Error?) -> Void in
            let sdp = description?.sdp
            DispatchQueue.main.async { done(sdp) }
        })
    }

    func makeAnswer(done: @escaping (String?) -> Void) {
        guard let connection else { return done(nil) }
        let constraints = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        connection.answer(for: constraints, completionHandler: { (description: LKRTCSessionDescription?, _: Error?) -> Void in
            let sdp = description?.sdp
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
        connection.setLocalDescription(CallMedia.sessionDescription(kind, sdp), completionHandler: { (error: Error?) -> Void in
            let fine = error == nil
            DispatchQueue.main.async { done(fine) }
        })
    }

    func setRemote(_ kind: String, sdp: String, done: @escaping (Bool) -> Void) {
        guard let connection else { return done(false) }
        connection.setRemoteDescription(CallMedia.sessionDescription(kind, sdp), completionHandler: { (error: Error?) -> Void in
            let fine = error == nil
            DispatchQueue.main.async { done(fine) }
        })
    }

    // MARK: The link

    /// Caps what a sender may send ("audio" or "video"), bits per second; nil lifts the cap.
    func cap(_ kind: String, bitrate: Double?) {
        guard let connection else { return }
        for sender in connection.senders where sender.track?.kind == kind {
            let parameters = sender.parameters
            guard let encoding = parameters.encodings.first else { continue }
            if let bitrate { encoding.maxBitrateBps = NSNumber(value: Int(bitrate)) } else { encoding.maxBitrateBps = nil }
            sender.parameters = parameters
        }
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

    /// Tells the state when it is not the one told last. Also asked once a second by the engine, so a change is
    /// never missed.
    func tellState() {
        guard let connection, !closed else { return }
        let state = CallMedia.words(connection.connectionState)
        if state == lastState { return }
        lastState = state
        onState?(state)
    }

    /// The call is over: the camera and the microphone are released, the connection closed. Nothing is told after it.
    func close() {
        closed = true
        onCandidate = nil
        onGathering = nil
        onState = nil
        onRemoteVideo = nil
        capturer?.stopCapture()
        capturer = nil
        localVideoTrack = nil
        remoteVideoTrack = nil
        videoSource = nil
        audioTrack = nil
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
        DispatchQueue.main.async { [weak self] in self?.onGathering?() }
    }
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didGenerate candidate: LKRTCIceCandidate) {
        let line = candidate.sdp
        DispatchQueue.main.async { [weak self] in
            self?.onCandidate?(line)
            self?.onGathering?()
        }
    }
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove candidates: [LKRTCIceCandidate]) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didOpen dataChannel: LKRTCDataChannel) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCPeerConnectionState) {
        DispatchQueue.main.async { [weak self] in self?.tellState() }
    }
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didAdd rtpReceiver: LKRTCRtpReceiver, streams mediaStreams: [LKRTCMediaStream]) {
        guard let track = rtpReceiver.track as? LKRTCVideoTrack else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.closed else { return }
            self.remoteVideoTrack = track
            self.onRemoteVideo?()
        }
    }
}

/// A picture of the call on the screen: the other side's (full screen) or this phone's own (the small one,
/// mirrored for the front camera). Draws nothing until it is given a call's media.
final class CallVideoView: UIView {
    private var surface: LKRTCMTLVideoView?
    private var track: LKRTCVideoTrack?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        clipsToBounds = true
    }

    required init?(coder: NSCoder) { return nil }

    private func show(_ next: LKRTCVideoTrack?) {
        if track === next { return }
        if let track, let surface { track.remove(surface) }
        track = next
        guard let next else {
            surface?.removeFromSuperview()
            surface = nil
            return
        }
        let made = surface ?? LKRTCMTLVideoView(frame: bounds)
        if surface == nil {
            made.videoContentMode = .scaleAspectFill
            made.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            addSubview(made)
            surface = made
        }
        next.add(made)
    }

    /// The other side's picture of this call (nil: nothing).
    func showRemote(of media: CallMedia?) { show(media?.remoteVideoTrack) }

    /// This phone's own camera; the front one is shown as in a mirror.
    func showLocal(of media: CallMedia?) {
        show(media?.localVideoTrack)
        let mirrored = media?.usesFrontCamera ?? true
        surface?.transform = mirrored ? CGAffineTransform(scaleX: -1, y: 1) : .identity
    }
}
