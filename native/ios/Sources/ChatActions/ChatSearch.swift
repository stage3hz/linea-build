import UIKit

/// «Поиск в этом чате» (the reference's ChatScreen.tsx search bar): a glass line under the header with the
/// words to look for, «Найдено: N» or «Ничего», and a cross that closes it. While it is open the chat shows only
/// the messages whose text (or file name) holds the words; the search runs over what this device has opened.
final class ChatSearchBar: UIVisualEffectView, UITextFieldDelegate {
    static let height: CGFloat = 46

    /// The words changed (already trimmed and lower-cased; empty: everything shows).
    var onChange: ((String) -> Void)?
    /// The cross was pressed.
    var onClose: (() -> Void)?

    private let mark = UIImageView()
    let input = UITextField()
    private let countLabel = UILabel()
    private let close = UIButton(type: .system)

    init() {
        super.init(effect: nil)
        layer.cornerRadius = 22
        layer.cornerCurve = .continuous
        clipsToBounds = true
        mark.image = chatSymbol("magnifyingglass", 16)
        mark.tintColor = Theme.muted
        mark.contentMode = .center
        contentView.addSubview(mark)
        input.font = .systemFont(ofSize: 15)
        input.textColor = Theme.text
        input.tintColor = Theme.accent
        input.attributedPlaceholder = NSAttributedString(string: "Поиск в этом чате", attributes: [.foregroundColor: Theme.muted])
        input.keyboardAppearance = Theme.dark ? .dark : .light
        input.returnKeyType = .search
        input.autocorrectionType = .no
        input.accessibilityLabel = "Поиск в этом чате"
        input.delegate = self
        input.addTarget(self, action: #selector(typed), for: .editingChanged)
        contentView.addSubview(input)
        countLabel.font = .systemFont(ofSize: 11)
        countLabel.textColor = Theme.muted
        countLabel.textAlignment = .right
        contentView.addSubview(countLabel)
        close.setImage(chatSymbol("xmark", 15, .semibold), for: .normal)
        close.tintColor = Theme.muted
        close.accessibilityLabel = "Закрыть поиск"
        close.addTarget(self, action: #selector(closeNow), for: .touchUpInside)
        contentView.addSubview(close)
    }

    required init?(coder: NSCoder) { return nil }

    /// The words as the list compares them (the reference: trimmed, lower case by the Russian rules).
    var needle: String {
        (input.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased(with: Locale(identifier: "ru_RU"))
    }

    func begin() {
        if effect == nil { effect = chatGlass() }
        input.text = ""
        countLabel.text = ""
        input.becomeFirstResponder()
    }

    /// «Найдено: N», or «Ничего» — only while there are words.
    func show(found: Int) {
        countLabel.text = needle.isEmpty ? "" : (found > 0 ? "Найдено: \(found)" : "Ничего")
        setNeedsLayout()
    }

    @objc private func typed() { onChange?(needle) }
    @objc private func closeNow() { onClose?() }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        textField.resignFirstResponder()
        return false
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = bounds.width, height = bounds.height
        mark.frame = CGRect(x: 14, y: 0, width: 18, height: height)
        close.frame = CGRect(x: width - 40, y: (height - 38) / 2, width: 34, height: 38)
        let countWidth = ceil(((countLabel.text ?? "") as NSString).size(withAttributes: [.font: countLabel.font ?? UIFont.systemFont(ofSize: 11)]).width)
        countLabel.frame = CGRect(x: close.frame.minX - countWidth - 4, y: 0, width: countWidth, height: height)
        input.frame = CGRect(x: 41, y: 0, width: max(0, countLabel.frame.minX - 41 - 6), height: height)
    }
}

extension ChatHistory {
    /// Whether a message holds the words of the search (its text, or the name of its file).
    static func matches(_ message: [String: Any], needle: String) -> Bool {
        if needle.isEmpty { return true }
        let ru = Locale(identifier: "ru_RU")
        if (message["text"] as? String ?? "").lowercased(with: ru).contains(needle) { return true }
        let name = (message["attachment"] as? [String: Any])?["name"] as? String ?? ""
        return name.lowercased(with: ru).contains(needle)
    }
}
