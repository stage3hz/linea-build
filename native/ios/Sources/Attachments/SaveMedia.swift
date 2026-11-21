import Photos
import UIKit

/// «Сохранить фото», «Сохранить видео», «Сохранить» of a message's menu (the reference's ChatScreen.tsx
/// `download`). A photo or a video is brought, opened on this device and added to the gallery — with the
/// add-only permission, asked the first time (the app never sees what else is in the gallery); any other file
/// goes to the system's share sheet («Сохранить в Файлы» and the rest). The decrypted copy is removed at once.
enum MediaSave {
    /// The words of the menu item for an attachment.
    static func label(_ attachment: [String: Any]) -> String {
        switch kind(attachment) {
        case "video": return "Сохранить видео"
        case "photo": return "Сохранить фото"
        default: return "Сохранить"
        }
    }

    /// "photo", "video" or "file" (a voice message and a round video are files here, as in the reference: a
    /// round video is a video).
    static func kind(_ attachment: [String: Any]) -> String {
        let about = FileCore.describe(attachment).kind
        if about == "photo" { return "photo" }
        let media = MediaRows.kind(attachment)
        if media == "video" || media == "note" || about == "video" { return "video" }
        return "file"
    }

    /// Brings the attachments one after another and saves them; `say` gets the words of the result.
    static func save(_ attachments: [[String: Any]], messenger: Messenger, from host: UIViewController, say: @escaping (String, Bool) -> Void) {
        guard let first = attachments.first else { return }
        let visual = attachments.allSatisfy { kind($0) != "file" }
        if !visual {
            share(first, messenger: messenger, from: host, say: say)
            return
        }
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { (status: PHAuthorizationStatus) -> Void in
            DispatchQueue.main.async {
                guard status == .authorized || status == .limited else {
                    say("Разреши доступ к фото и видео в настройках телефона.", true)
                    return
                }
                say("Сохраняется…", false)
                next(attachments, index: 0, saved: 0, messenger: messenger, say: say)
            }
        }
    }

    private static func next(_ attachments: [[String: Any]], index: Int, saved: Int, messenger: Messenger, say: @escaping (String, Bool) -> Void) {
        guard index < attachments.count else {
            if saved == attachments.count { say(saved > 1 ? "Сохранено в галерею: \(saved)" : "Сохранено в галерею", false) }
            return
        }
        let attachment = attachments[index]
        let fetch = MediaFetch()
        fetch.start(server: messenger.server, attachment: attachment, progress: { (_: Double) -> Void in }, done: { (result: Result<MediaFetch.Brought, FileCore.Failure>) -> Void in
            _ = fetch
            switch result {
            case .failure(let failure):
                say(failure.words, true)
            case .success(let brought):
                let video = kind(attachment) == "video"
                PHPhotoLibrary.shared().performChanges({
                    if video {
                        _ = PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: brought.file)
                    } else {
                        _ = PHAssetChangeRequest.creationRequestForAssetFromImage(atFileURL: brought.file)
                    }
                }, completionHandler: { (ok: Bool, _: Error?) -> Void in
                    DecryptedFiles.remove(brought.folder)
                    DispatchQueue.main.async {
                        if !ok {
                            say(video ? "Не удалось сохранить видео." : "Не удалось сохранить фото.", true)
                            return
                        }
                        next(attachments, index: index + 1, saved: saved + 1, messenger: messenger, say: say)
                    }
                })
            }
        })
    }

    /// Any other file: the system's share sheet with the opened copy, removed once the sheet is gone.
    private static func share(_ attachment: [String: Any], messenger: Messenger, from host: UIViewController, say: @escaping (String, Bool) -> Void) {
        let fetch = MediaFetch()
        fetch.start(server: messenger.server, attachment: attachment, progress: { (_: Double) -> Void in }, done: { [weak host] (result: Result<MediaFetch.Brought, FileCore.Failure>) -> Void in
            _ = fetch
            switch result {
            case .failure(let failure):
                say(failure.words, true)
            case .success(let brought):
                guard let host else {
                    DecryptedFiles.remove(brought.folder)
                    return
                }
                let sheet = UIActivityViewController(activityItems: [brought.file], applicationActivities: nil)
                sheet.completionWithItemsHandler = { (_: UIActivity.ActivityType?, _: Bool, _: [Any]?, _: Error?) -> Void in DecryptedFiles.remove(brought.folder) }
                sheet.popoverPresentationController?.sourceView = host.view
                host.present(sheet, animated: true)
            }
        })
    }
}
