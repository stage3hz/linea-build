import ExpoModulesCore
import Foundation

/// Experimental session-scoped HTTPS/WSS. Never a device VPN or global proxy.
/// By default the Go library is absent. Opt in at pod-install time; no startup
/// or network request occurs merely because Expo autolinks this module.
public final class TransportBModule: Module {
    private let worker = DispatchQueue(label: "com.invizent.transport-b.session")
    private var generation: UInt64 = 0
    private var sessionID = ""
    private var sessionState = "idle"
    private var timer: DispatchWorkItem?
    private var networking: AnyObject?
    private var networkTasks: [String: Task<Void, Never>] = [:]
    private var socketWrites = 0
    private let origins: Set<String> = ["https://api.invizent.com", "https://141-133-194-51.nip.io", "https://invizent-api.invizent-8165e2.workers.dev"]
    #if INVIZENT_TRANSPORT_B
    private var joiner: StageBProofJoiner?
    #endif

    public func definition() -> ModuleDefinition {
        Name("LineaTransportB")
        Events("transportState", "transportSocket")
        Function("capabilities") { () -> [String: Any] in
            #if INVIZENT_TRANSPORT_B
            if #available(iOS 17.0, *) {
                return ["protocol": 1, "nativeSession": true, "appRouting": false, "networkProtocol": 1, "sessionNetworking": true]
            }
            return ["protocol": 1, "nativeSession": true, "appRouting": false, "sessionNetworking": false]
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
        AsyncFunction("request") { (id: String, requestID: String, url: String, method: String, headers: [String: String], body: String?, timeout: Double, promise: Promise) in
            guard #available(iOS 17.0, *) else { promise.reject("unavailable", "Session networking requires iOS 17"); return }
            do {
                let route = try self.network(id)
                guard self.validID(requestID), self.networkTasks[requestID] == nil, self.networkTasks.count < 16,
                      (body?.utf8.count ?? 0) <= 1_398_104 else { throw self.reject("Invalid request") }
                let data: Data?
                if let body { guard let decoded = Data(base64Encoded: body) else { throw self.reject("Invalid body") }; data = decoded } else { data = nil }
                let epoch = self.generation
                let task = Task {
                    do {
                        let reply = try await route.request(id: requestID, address: url, method: method, headers: headers, body: data, timeout: timeout)
                        self.worker.async {
                            guard self.generation == epoch else { promise.reject("cancelled", "Session ended"); return }
                            self.networkTasks.removeValue(forKey: requestID)
                            promise.resolve(["status": reply.status, "headers": reply.headers, "body": reply.body.base64EncodedString()])
                        }
                    } catch {
                        self.worker.async {
                            if self.generation == epoch { self.networkTasks.removeValue(forKey: requestID) }
                            promise.reject("network_error", "Session request failed")
                        }
                    }
                }
                self.networkTasks[requestID] = task
            } catch { promise.reject("unavailable", "Session request is unavailable") }
        }.runOnQueue(worker)
        AsyncFunction("cancelRequest") { (id: String, requestID: String) in
            if self.sessionID == id { self.networkTasks[requestID]?.cancel() }
        }.runOnQueue(worker)
        AsyncFunction("socketOpen") { (id: String, socketID: String, url: String) in
            guard #available(iOS 17.0, *) else { throw self.reject("Session networking unavailable") }
            guard self.validID(socketID) else { throw self.reject("Invalid socket") }
            let epoch = self.generation
            try self.network(id).openSocket(id: socketID, address: url) { kind, text, code in
                self.worker.async {
                    guard self.generation == epoch, self.sessionID == id else { return }
                    var event: [String: Any] = ["sessionId": id, "socketId": socketID, "kind": kind]
                    if let text { event["text"] = text }
                    if let code { event["code"] = code }
                    self.sendEvent("transportSocket", event)
                }
            }
        }.runOnQueue(worker)
        AsyncFunction("socketSend") { (id: String, socketID: String, text: String, promise: Promise) in
            guard #available(iOS 17.0, *) else { promise.reject("unavailable", "Session networking unavailable"); return }
            do {
                let route = try self.network(id)
                guard self.socketWrites < 16 else { throw self.reject("Socket send queue is full") }
                self.socketWrites += 1
                let epoch = self.generation
                Task {
                    do {
                        try await route.sendSocket(id: socketID, text: text)
                        self.worker.async {
                            guard self.generation == epoch else { promise.reject("cancelled", "Session ended"); return }
                            self.socketWrites -= 1; promise.resolve(nil)
                        }
                    } catch {
                        self.worker.async {
                            if self.generation == epoch { self.socketWrites -= 1 }
                            promise.reject("network_error", "Socket send failed")
                        }
                    }
                }
            } catch { promise.reject("unavailable", "Socket is unavailable") }
        }.runOnQueue(worker)
        AsyncFunction("socketClose") { (id: String, socketID: String) in
            guard #available(iOS 17.0, *), self.sessionID == id else { return }
            (self.networking as? TransportBURLSession)?.closeSocket(id: socketID)
        }.runOnQueue(worker)
        OnDestroy { [weak self] in
            guard let self else { return }
            self.worker.async { self.stopCurrent(emit: false) }
        }
    }

    private func validID(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9_-]{8,128}$", options: .regularExpression) != nil
    }

    @available(iOS 17.0, *)
    private func network(_ id: String) throws -> TransportBURLSession {
        guard sessionID == id, sessionState == "sessionConnected", let route = networking as? TransportBURLSession else {
            throw reject("Session route unavailable")
        }
        return route
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
              StageBJoinParameters(joinLink: link) != nil else {
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
        do {
            let endpoint = try next.start(joinLink: link)
            if #available(iOS 17.0, *) {
                networking = try TransportBURLSession(port: endpoint.port, username: endpoint.username, password: endpoint.password, origins: origins)
            }
        }
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
        networkTasks.values.forEach { $0.cancel() }
        networkTasks.removeAll(); socketWrites = 0
        if #available(iOS 17.0, *) { (networking as? TransportBURLSession)?.close() }
        networking = nil
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
