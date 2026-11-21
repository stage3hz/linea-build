import UIKit

/// «Предпросмотр ссылок»: whether this phone fetches the page of a link the person writes, to send its card
/// along. Kept on this device only (the server knows nothing of it). When it is off nothing is ever fetched;
/// cards that arrive inside messages are still shown — they cost no request to anyone.
enum LinkSettings {
    private static let key = "linkPreviews.off"

    static var on: Bool {
        get { return !UserDefaults.standard.bool(forKey: key) }
        set {
            UserDefaults.standard.set(!newValue, forKey: key)
            if !newValue { LinkFetcher.shared.forget() }
        }
    }

    /// The switch for the privacy page of the settings.
    static func row() -> UIView {
        let row = SettingsSwitchRow(label: "Предпросмотр ссылок",
                                    words: "Когда ты пишешь ссылку, телефон сам загружает страницу и прикладывает её карточку к зашифрованному сообщению. Сервер ссылку не видит, а телефон собеседника на сайт не заходит. Если выключить, страницы не загружаются; карточки от собеседников показываются по-прежнему.",
                                    value: LinkSettings.on)
        row.onChange = { (value: Bool) -> Void in LinkSettings.on = value }
        return row
    }
}
