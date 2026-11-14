import ExpoModulesCore
import Foundation

/// App-local experimental session control, NOT a fetch/WebSocket adapter or VPN.
/// By default the Go library is absent. Opt in at pod-install time; no startup
/// or network request occurs merely because Expo autolinks this module.
public final class TransportBModule: Module {
    private let worker = DispatchQueue(label: "com.invizent.transport-b.session")
    private var generation: UInt64 = 0
    private var sessionID = ""
    private var sessionState = "idle"
    private var timer: DispatchWorkItem?
    #if INVIZENT_TRANSPORT_B
    private var joiner: StageBProofJoiner?
    #endif

    public func definition() -> ModuleDefinition {
        Name("LineaTransportB")
        Events("transportState")
        Function("capabilities") { () -> [String: Any] in
            #if INVIZENT_TRANSPORT_B
            return ["protocol": 1, "nativeSession": true, "appRouting": false]
            #else
            return ["protocol": 1, "nativeSession": false, "appRouting": false]
            #endif
        }
        AsyncFunction("status") { () -> [String: Any] in
            return self.snapshot()
        }.runOnQueue(worker)
        AsyncFunction("startSession") { (id: String, link: String) in
            try self.start(id: id, link: link)
        }.runOnQueue(worker)
        AsyncFunction("stopSession") { (id: String) in
            // Cancellation from a previous attempt cannot stop a new one.
            if self.sessionID == id { self.stopCurrent() }
        }.runOnQueue(worker)
        OnDestroy { [weak self] in
            guard let self else { return }
            self.worker.async { self.stopCurrent(emit: false) }
        }
    }

    private func snapshot() -> [String: Any] {
        return ["sessionId": sessionID, "state": sessionState]
    }

    private func reject(_ message: String) -> NSError {
        return NSError(domain: "LineaTransportB", code: 1,
                       userInfo: [NSLocalizedDescriptionKey: message])
    }

    private func start(id: String, link: String) throws {
        #if INVIZENT_TRANSPORT_B
        guard id.range(of: #"^[A-Za-z0-9_-]{8,96}$"#, options: .regularExpression) != nil,
              link.range(of: #"^wbstream://[A-Za-z0-9_-]{6,160}$"#, options: .regularExpression) != nil else {
            throw reject("Invalid transport session parameters")
        }
        guard joiner == nil else { throw reject("Stop the previous transport session first") }
        generation &+= 1
        let epoch = generation
        sessionID = id
        sessionState = "starting"
        let next = StageBProofJoiner()
        // Set exactly once before starting Go. Never forward raw Go diagnostics.
        next.callback.statusHandler = { [weak self] status in
            guard let self else { return }
            self.worker.async {
                guard self.generation == epoch, self.joiner != nil else { return }
                self.receive(status)
            }
        }
        joiner = next
        sendEvent("transportState", snapshot())
        do { try next.start(joinLink: link) }
        catch {
            fail("native_error")
            throw reject("Transport session could not start")
        }
        let deadline = DispatchWorkItem { [weak self] in
            guard let self, self.generation == epoch, self.sessionState == "starting" else { return }
            self.fail("startup_timeout")
        }
        timer = deadline
        worker.asyncAfter(deadline: .now() + 45, execute: deadline)
        #else
        throw reject("Native transport session is not included in this build")
        #endif
    }

    private func receive(_ status: String) {
        // Constants are pinned to upstream relay/common/status.go. Unknown status
        // strings are ignored rather than exposed (they may contain bearer URLs).
        if status == "TUNNEL_CONNECTED" {
            timer?.cancel()
            timer = nil
            sessionState = "sessionConnected"
            sendEvent("transportState", snapshot())
        } else if status == "TUNNEL_LOST" || status == "RECONNECTING" {
            fail("session_lost")
        } else if status == "ERROR" || status.hasPrefix("ERROR:") {
            fail("native_error")
        }
    }

    private func fail(_ code: String) {
        stopCurrent(emit: false)
        sessionState = "failed"
        var event = snapshot()
        event["error"] = code
        sendEvent("transportState", event)
    }

    private func stopCurrent(emit: Bool = true) {
        generation &+= 1
        timer?.cancel()
        timer = nil
        #if INVIZENT_TRANSPORT_B
        if let active = joiner {
            joiner = nil
            active.stop()
        }
        #endif
        sessionState = "idle"
        if emit { sendEvent("transportState", snapshot()) }
    }
}
