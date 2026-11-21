import Foundation

/// The shared core's part about files attached to encrypted messages (native/core/src/e2ee/files.rs), as Swift
/// sees it: the key of a new file, sealing before the upload, opening after the download, the object that
/// travels inside the message. Nothing here is logged; keys and file bytes only pass through.
enum FileCore {
    /// Why a step on a file did not give its answer: the words for the person.
    struct Failure: Error {
        let words: String
    }

    private static func take(_ pointer: UnsafeMutablePointer<CChar>?) -> String? {
        guard let pointer else { return nil }
        defer { invizent_string_free(pointer) }
        return String(cString: pointer)
    }

    /// One of the core's file functions by name (see `invizent_file_call`); nil when it has no answer.
    static func call(_ name: String, _ args: [Any] = []) -> Any? {
        guard let argsText = Core.text(args) else { return nil }
        let answer: String? = name.withCString { name in argsText.withCString { take(invizent_file_call(name, $0)) } }
        let value = Core.value(answer)
        return value is NSNull ? nil : value
    }

    private enum Step { case seal, open, cleanJpeg }

    /// Hands bytes (and a JSON value) to the core and takes its bytes back.
    private static func run(_ step: Step, _ input: Data, json: Any?) -> Result<Data, Failure> {
        let failed = Failure(words: "Не удалось обработать файл.")
        var jsonText = ""
        if let json {
            guard let text = Core.text(json) else { return .failure(failed) }
            jsonText = text
        }
        var out = InvizentBytes(data: nil, len: 0)
        let words: String? = input.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> String? in
            let bytes = raw.bindMemory(to: UInt8.self).baseAddress
            return jsonText.withCString { (text: UnsafePointer<CChar>) -> String? in
                switch step {
                case .seal: return take(invizent_file_seal(bytes, input.count, text, &out))
                case .open: return take(invizent_file_open(bytes, input.count, text, &out))
                case .cleanJpeg: return take(invizent_file_clean_jpeg(bytes, input.count, &out))
                }
            }
        }
        defer { invizent_file_bytes_free(out) }
        if let words { return .failure(Failure(words: words)) }
        guard let data = out.data else { return .success(Data()) }
        return .success(Data(bytes: data, count: out.len))
    }

    /// Seals a file's bytes with the key `call("newEncryption")` gave: the ciphertext with its tag.
    static func seal(_ plain: Data, encryption: [String: Any]) -> Result<Data, Failure> {
        run(.seal, plain, json: encryption)
    }

    /// Opens a downloaded file with the key from its message; a wrong size or one changed byte is refused.
    static func open(_ cipher: Data, attachment: [String: Any]) -> Result<Data, Failure> {
        run(.open, cipher, json: attachment)
    }

    /// A JPEG as the reference's gate lets it out: the picture only.
    static func cleanJpeg(_ jpeg: Data) -> Result<Data, Failure> {
        run(.cleanJpeg, jpeg, json: nil)
    }

    /// How an attachment is shown and whether it can be opened here.
    struct Description {
        let kind: String
        let fileName: String
        let sizeText: String
        let cipherSize: Int?
        let refusal: String?
    }

    static func describe(_ attachment: [String: Any]) -> Description {
        // The small picture is not needed for this, and it is the biggest part of the object.
        var bare = attachment
        bare["preview"] = nil
        let made = call("describe", [bare]) as? [String: Any] ?? [:]
        return Description(kind: made["kind"] as? String ?? "file", fileName: made["fileName"] as? String ?? "file", sizeText: made["sizeText"] as? String ?? "",
                           cipherSize: (made["cipherSize"] as? NSNumber)?.intValue, refusal: made["refusal"] as? String)
    }

    static func sizeText(_ bytes: Int) -> String {
        call("sizeText", [max(0, bytes)]) as? String ?? ""
    }
}
