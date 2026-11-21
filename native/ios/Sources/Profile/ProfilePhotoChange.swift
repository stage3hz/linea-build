import AVFoundation
import ImageIO
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// Changing the profile's photo and banner (the reference's ProfileScreen.tsx `pickMedia`, `applyAvatar`,
/// `removeMedia` and PlatinaStudio.tsx `upload`): a tap on the avatar or the banner asks «Фото или GIF», «Видео до 10
/// секунд» (Platina), «Убрать». A still photo of the avatar goes through the round cropper; a GIF stays animated; a
/// video (and any banner) is a Platina decoration. A banner photo is shown on the profile first and uploaded after
/// «Установить баннер». Photos are decoded and written anew (no metadata); videos are encoded anew without metadata
/// (Video/VideoPrepare.swift). The pickers need no permission: they show only what the person picks.
final class ProfilePhotoChange: NSObject, PHPickerViewControllerDelegate, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    private let messenger: Messenger
    private weak var host: UIViewController?
    private var kind = "avatar"
    private(set) var busy = false
    /// Busy started or ended (a spinner, «Загружаем…»).
    var onBusy: ((Bool) -> Void)?
    /// Words for the person: (words, isError).
    var onNotice: ((String, Bool) -> Void)?

    private static let avatarEdge = 1024
    private static let profileLimit = 4 * 1024 * 1024
    private static let videoLimit = 8 * 1024 * 1024

    init(messenger: Messenger, host: UIViewController) {
        self.messenger = messenger
        self.host = host
        super.init()
    }

    private var platina: Bool { return PlatinaState.shared.active }

    private func say(_ words: String, error: Bool) {
        if let onNotice { return onNotice(words, error) }
        guard let host, !words.isEmpty else { return }
        let alert = UIAlertController(title: nil, message: words, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Понятно", style: .default, handler: nil))
        host.present(alert, animated: true, completion: nil)
    }

    private func setBusy(_ value: Bool) {
        busy = value
        onBusy?(value)
    }

    /// The sheet of a tap on the avatar ("avatar") or the banner ("banner").
    func ask(kind: String) {
        guard let host, !busy else { return }
        self.kind = kind
        let own = PersonLook(messenger.ownProfile)
        let hasAvatar = !((messenger.ownProfile["avatarId"] as? String) ?? "").isEmpty || !own.avatarVideoId.isEmpty
        let has = kind == "avatar" ? hasAvatar : (!own.bannerId.isEmpty || !own.bannerPreset.isEmpty)
        let note = platina ? nil : (kind == "banner" ? "Баннер и видео доступны с Platina." : "Видео-аватар доступен с Platina.")
        let sheet = UIAlertController(title: kind == "banner" ? "Баннер профиля" : "Фото профиля", message: note, preferredStyle: .actionSheet)
        let photo = UIAlertAction(title: kind == "banner" ? "Фото или GIF" : "Выбрать фото или GIF", style: .default) { [weak self] (_: UIAlertAction) -> Void in self?.pickPhoto() }
        photo.isEnabled = kind == "avatar" || platina
        sheet.addAction(photo)
        let video = UIAlertAction(title: "Видео до 10 секунд", style: .default) { [weak self] (_: UIAlertAction) -> Void in self?.pickVideo() }
        video.isEnabled = platina
        sheet.addAction(video)
        if has {
            sheet.addAction(UIAlertAction(title: "Убрать", style: .destructive) { [weak self] (_: UIAlertAction) -> Void in self?.remove() })
        }
        sheet.addAction(UIAlertAction(title: "Отмена", style: .cancel, handler: nil))
        host.present(sheet, animated: true, completion: nil)
    }

    func pickVideoAvatar() {
        kind = "avatar"
        pickVideo()
    }

    // MARK: Photos and GIFs

    private func pickPhoto() {
        guard let host else { return }
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 1
        config.preferredAssetRepresentationMode = .compatible
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        host.present(picker, animated: true, completion: nil)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true, completion: nil)
        guard let provider = results.first?.itemProvider else { return }
        if provider.hasItemConformingToTypeIdentifier(UTType.gif.identifier) {
            provider.loadDataRepresentation(forTypeIdentifier: UTType.gif.identifier) { [weak self] (data: Data?, _: Error?) -> Void in
                DispatchQueue.main.async {
                    guard let self else { return }
                    guard let data else { return self.say("Не удалось выбрать файл.", error: true) }
                    self.takeGif(data)
                }
            }
            return
        }
        provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { [weak self] (url: URL?, _: Error?) -> Void in
            // The file is only there during this call: it is decoded here, off the main queue.
            let picture = url.flatMap { ProfilePhotoChange.decode($0) }
            DispatchQueue.main.async {
                guard let self else { return }
                guard let picture else { return self.say("Не удалось выбрать фото.", error: true) }
                self.takePhoto(picture)
            }
        }
    }

    /// The picture upright, at most 4096 px across (HEIC included), as a fresh bitmap.
    static func decode(_ url: URL) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 4096]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }

    private func takePhoto(_ picture: UIImage) {
        guard let host else { return }
        if kind == "banner" {
            let preview = BannerPreviewViewController(messenger: messenger, picture: picture)
            preview.onSet = { [weak self] in self?.uploadBanner(picture) }
            preview.onAgain = { [weak self] in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { self?.pickPhoto() }
            }
            host.present(preview, animated: true, completion: nil)
            return
        }
        let cropper = AvatarCropperViewController(picture: picture)
        cropper.onDone = { [weak self] (crop: CGRect) -> Void in self?.applyAvatar(picture, crop: crop) }
        host.present(cropper, animated: true, completion: nil)
    }

    /// Crop to the circle's square, then an avatar-sized JPEG, as the reference (1024 px, quality 0.86).
    private func applyAvatar(_ picture: UIImage, crop: CGRect) {
        guard let source = picture.cgImage, let square = source.cropping(to: crop) else { return say("Не удалось сохранить фото.", error: true) }
        let edge = CGFloat(min(ProfilePhotoChange.avatarEdge, Int(crop.width)))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let small = UIGraphicsImageRenderer(size: CGSize(width: edge, height: edge), format: format).image { (_: UIGraphicsImageRendererContext) -> Void in
            UIImage(cgImage: square).draw(in: CGRect(x: 0, y: 0, width: edge, height: edge))
        }
        guard let jpeg = small.jpegData(compressionQuality: 0.86) else { return say("Не удалось сохранить фото.", error: true) }
        upload(jpeg, name: "avatar.jpg", mimeType: "image/jpeg", failure: "Не удалось сохранить фото.") { [weak self] (attachment: [String: Any]) -> Void in
            guard let self else { return }
            let type = attachment["mimeType"] as? String ?? "image/jpeg"
            let size = (attachment["size"] as? NSNumber)?.intValue ?? 0
            if !type.hasPrefix("image/") { return self.fail("Для профиля нужна фотография.") }
            if size > ProfilePhotoChange.profileLimit { return self.fail("После обработки фото больше 4 МБ. Выбери изображение меньшего размера.") }
            // Like Telegram: the new photo is applied at once (the name / bio draft stays a draft).
            self.patch(["avatarId": attachment["id"] as? String ?? ""], done: "Фото профиля обновлено.", failure: "Не удалось сохранить фото.")
        }
    }

    private func takeGif(_ data: Data) {
        if kind == "banner" {
            upload(data, name: "banner.gif", mimeType: "image/gif", failure: "Не удалось загрузить файл.") { [weak self] (attachment: [String: Any]) -> Void in
                self?.patch(["bannerId": attachment["id"] as? String ?? ""], done: "Баннер обновлён.", failure: "Не удалось загрузить файл.")
            }
            return
        }
        if data.count > ProfilePhotoChange.profileLimit { return say("GIF больше 4 МБ. Выбери покороче.", error: true) }
        upload(data, name: "avatar.gif", mimeType: "image/gif", failure: "Не удалось сохранить GIF.") { [weak self] (attachment: [String: Any]) -> Void in
            guard let self else { return }
            if ((attachment["size"] as? NSNumber)?.intValue ?? 0) > ProfilePhotoChange.profileLimit { return self.fail("GIF больше 4 МБ. Выбери покороче.") }
            self.patch(["avatarId": attachment["id"] as? String ?? ""], done: "Фото профиля обновлено.", failure: "Не удалось сохранить GIF.")
        }
    }

    /// A banner needs no more than ~1500 px across; this also keeps it under the profile limit.
    private func uploadBanner(_ picture: UIImage) {
        let width = min(1500, picture.size.width * picture.scale)
        let height = (picture.size.height / max(1, picture.size.width) * width).rounded()
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let small = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).image { (_: UIGraphicsImageRendererContext) -> Void in
            picture.draw(in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        guard let jpeg = small.jpegData(compressionQuality: 0.85) else { return say("Не удалось загрузить файл.", error: true) }
        upload(jpeg, name: "banner.jpg", mimeType: "image/jpeg", failure: "Не удалось загрузить файл.") { [weak self] (attachment: [String: Any]) -> Void in
            self?.patch(["bannerId": attachment["id"] as? String ?? ""], done: "Баннер обновлён.", failure: "Не удалось загрузить файл.")
        }
    }

    // MARK: Videos

    private func pickVideo() {
        guard let host, platina else { return }
        let picker = UIImagePickerController()
        picker.sourceType = .photoLibrary
        picker.mediaTypes = [UTType.movie.identifier]
        // The system's trimmer: up to 10 seconds, encoded at 960×540 as the reference asks.
        picker.allowsEditing = true
        picker.videoMaximumDuration = 10
        picker.videoExportPreset = AVAssetExportPreset960x540
        picker.delegate = self
        host.present(picker, animated: true, completion: nil)
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true, completion: nil)
    }

    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true, completion: nil)
        guard let url = info[.mediaURL] as? URL else { return say("Не удалось выбрать файл.", error: true) }
        let seconds = CMTimeGetSeconds(AVURLAsset(url: url).duration)
        if seconds.isFinite && seconds > 10.5 { return say("Видео — не длиннее 10 секунд.", error: true) }
        setBusy(true)
        VideoPrepare.prepare(source: url, small: true, started: { (_: AVAssetExportSession) -> Void in }, done: { [weak self] (result: Result<VideoPrepare.Prepared, FileCore.Failure>) -> Void in
            let bytes: Data? = (try? result.get()).flatMap { (prepared: VideoPrepare.Prepared) -> Data? in
                let data = try? Data(contentsOf: prepared.file)
                try? FileManager.default.removeItem(at: prepared.file)
                return data
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.setBusy(false)
                guard let bytes else { return self.say(VideoPrepare.failed, error: true) }
                if bytes.count > ProfilePhotoChange.videoLimit { return self.say("После обработки видео больше 8 МБ. Выбери ролик короче.", error: true) }
                let avatar = self.kind == "avatar"
                self.upload(bytes, name: "profile.mp4", mimeType: "video/mp4", failure: "Не удалось загрузить файл.") { [weak self] (attachment: [String: Any]) -> Void in
                    let id = attachment["id"] as? String ?? ""
                    self?.patch(avatar ? ["avatarVideoId": id] : ["bannerId": id], done: avatar ? "Анимированный аватар установлен." : "Баннер обновлён.", failure: "Не удалось загрузить файл.")
                }
            }
        })
    }

    // MARK: Sending

    private func fail(_ words: String) {
        setBusy(false)
        say(words, error: true)
    }

    private func upload(_ bytes: Data, name: String, mimeType: String, failure: String, then: @escaping ([String: Any]) -> Void) {
        setBusy(true)
        messenger.uploadProfileFile(bytes, name: name, mimeType: mimeType) { [weak self] (result: Result<[String: Any], ServerError>) -> Void in
            guard let self else { return }
            switch result {
            case .success(let attachment): then(attachment)
            case .failure(let error): self.fail(error.words.isEmpty ? failure : error.words)
            }
        }
    }

    private func patch(_ fields: [String: Any], done: String, failure: String) {
        setBusy(true)
        messenger.patchOwnProfile(fields) { [weak self] (result: Result<[String: Any], ServerError>) -> Void in
            guard let self else { return }
            self.setBusy(false)
            switch result {
            case .success: self.say(done, error: false)
            case .failure(let error): self.say(error.words.isEmpty ? failure : error.words, error: true)
            }
        }
    }

    private func remove() {
        let fields: [String: Any] = kind == "avatar" ? ["avatarId": NSNull(), "avatarVideoId": NSNull()] : ["bannerId": NSNull(), "bannerPreset": NSNull()]
        patch(fields, done: "", failure: "Не удалось убрать.")
    }
}

/// «Так будет выглядеть профиль»: a banner photo on the profile's head before it is uploaded.
final class BannerPreviewViewController: UIViewController {
    private let messenger: Messenger?
    private let picture: UIImage
    var onSet: (() -> Void)?
    var onAgain: (() -> Void)?

    init(messenger: Messenger?, picture: UIImage) {
        self.messenger = messenger
        self.picture = picture
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        if let sheet = sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = true
            sheet.preferredCornerRadius = 28
        }
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        overrideUserInterfaceStyle = Theme.dark ? .dark : .light
        view.backgroundColor = Theme.page(UIColor(hex: 0x141516))
        let heading = UILabel()
        heading.attributedText = Theme.titleWords("Так будет выглядеть профиль", size: Theme.TypeSize.sheetTitle, color: Theme.text)
        heading.numberOfLines = 2
        let hero = ProfileHeroCard(frame: .zero)
        var person = Person(id: "", username: "", displayName: "", bio: "", birthday: "", avatarColor: 0x5E7BFF, avatarId: "")
        if let messenger, let own = Person(messenger.ownProfile) { person = own }
        hero.show(person, look: person.look, base: messenger?.server.endpoint ?? "", localPicture: picture)
        let set = SettingsButton(label: "Установить баннер")
        set.onPress = { [weak self] in
            let done = self?.onSet
            self?.dismiss(animated: true) { done?() }
        }
        let again = SettingsButton(label: "Выбрать другое", kind: .secondary)
        again.onPress = { [weak self] in
            let next = self?.onAgain
            self?.dismiss(animated: true) { next?() }
        }
        let stack = UIStackView(arrangedSubviews: [heading, hero, set, again])
        stack.axis = .vertical
        stack.spacing = 12
        stack.setCustomSpacing(16, after: heading)
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 28),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
        ])
    }
}
