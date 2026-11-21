import UIKit

/// The rules of formatting in the field (the reference's format/entities.ts and format/markdown.ts, run by the
/// shared core so both phones format alike): an entity is `{type, offset, length, url?, language?}` with offsets
/// in UTF-16 units, as the reference counts them. It travels inside the encrypted message, never to the server.
enum ComposeRules {
    /// The toolbar's labels, in the reference's order (ENTITY_LABELS).
    static let labels: [String: String] = ["bold": "Жирный", "italic": "Курсив", "underline": "Подчёркнутый", "strikethrough": "Зачёркнутый", "code": "Моноширинный",
                                           "pre": "Моноширинный блок", "spoiler": "Спойлер", "quote": "Цитата", "text_link": "Ссылка"]

    /// Adds `type` over the selection, or takes it off when the whole selection has it (`toggleEntity`).
    static func toggle(_ entities: [[String: Any]], text: String, start: Int, end: Int, type: String, url: String? = nil) -> [[String: Any]] {
        let args: [Any] = [entities, text, start, end, type, url ?? NSNull()]
        return Core.view("composeToggle", args) as? [[String: Any]] ?? entities
    }

    /// «Очистить форматирование» over the selection (`clearFormatting`).
    static func clear(_ entities: [[String: Any]], text: String, start: Int, end: Int) -> [[String: Any]] {
        Core.view("composeClear", [entities, text, start, end]) as? [[String: Any]] ?? entities
    }

    /// The types every character of the selection carries (`activeTypes`).
    static func active(_ entities: [[String: Any]], start: Int, end: Int) -> Set<String> {
        Set(Core.view("composeActive", [entities, start, end]) as? [String] ?? [])
    }

    /// Keeps the entities in place while the person types (`shiftEntities`).
    static func shift(_ entities: [[String: Any]], old: String, new: String) -> [[String: Any]] {
        if entities.isEmpty { return [] }
        return Core.view("composeShift", [entities, old, new]) as? [[String: Any]] ?? []
    }

    /// What goes out: the typed shortcuts (**жирный**, __курсив__…) turned into entities, the text trimmed, the
    /// entities cut to it — nil entities when there is nothing to say (the reference's ChatScreen `composed`).
    static func compose(_ text: String, entities: [[String: Any]]) -> (text: String, entities: [[String: Any]]?) {
        guard let made = Core.view("composeOut", [text, entities]) as? [String: Any], let out = made["text"] as? String else {
            return (text.trimmingCharacters(in: .whitespacesAndNewlines), nil)
        }
        let list = made["entities"] as? [[String: Any]]
        return (out, (list?.isEmpty ?? true) ? nil : list)
    }

    /// Only http(s) addresses, at most 2048 units (`validLinkUrl`); «https://» is added when no scheme was typed.
    static func linkAddress(_ typed: String) -> String? {
        let trimmed = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        let hasScheme = trimmed.range(of: "^[a-zA-Z][a-zA-Z0-9+.-]*:", options: .regularExpression) != nil
        let url = hasScheme ? trimmed : "https://" + trimmed
        guard (url as NSString).length <= 2048, url.range(of: "^https?://\\S+$", options: [.regularExpression, .caseInsensitive]) != nil else { return nil }
        return url
    }
}

/// The formatting bar above the field (the reference's FormatToolbar.tsx): shown while text is selected; a tap
/// puts the style on the selection or takes it off; «Ссылка» asks for an address.
final class FormatBar: UIView {
    static let height: CGFloat = 44
    private static let items: [(type: String, label: String)] = [("bold", "Ж"), ("italic", "К"), ("underline", "Ч"), ("strikethrough", "З"), ("code", "</>"), ("spoiler", "▒"), ("quote", "❝"), ("text_link", "🔗")]

    /// A style was chosen ("clear": take every style off the selection).
    var onAction: ((String) -> Void)?
    /// «Ссылка» was chosen: the address is to be asked for.
    var onLink: (() -> Void)?

    private let surface = UIVisualEffectView(effect: nil)
    private let scroll = UIScrollView()
    private var buttons: [UIButton] = []
    private let clearButton = UIButton(type: .system)

    override init(frame: CGRect) {
        super.init(frame: frame)
        surface.layer.cornerRadius = 22
        surface.layer.cornerCurve = .continuous
        surface.clipsToBounds = true
        addSubview(surface)
        scroll.showsHorizontalScrollIndicator = false
        surface.contentView.addSubview(scroll)
        for (index, item) in FormatBar.items.enumerated() {
            let button = UIButton(type: .custom)
            button.tag = index
            button.layer.cornerRadius = 10
            button.layer.cornerCurve = .continuous
            button.setAttributedTitle(FormatBar.title(item.type, item.label, on: false), for: .normal)
            button.accessibilityLabel = ComposeRules.labels[item.type]
            button.addTarget(self, action: #selector(pressed(_:)), for: .touchUpInside)
            scroll.addSubview(button)
            buttons.append(button)
        }
        clearButton.setImage(chatSymbol("xmark.circle", 18), for: .normal)
        clearButton.tintColor = Theme.muted
        clearButton.accessibilityLabel = "Очистить форматирование"
        clearButton.addTarget(self, action: #selector(clearNow), for: .touchUpInside)
        scroll.addSubview(clearButton)
    }

    required init?(coder: NSCoder) { return nil }

    private static func title(_ type: String, _ label: String, on: Bool) -> NSAttributedString {
        var attributes: [NSAttributedString.Key: Any] = [.foregroundColor: on ? Theme.onAccent : Theme.text, .font: UIFont.systemFont(ofSize: 15)]
        switch type {
        case "bold": attributes[.font] = UIFont.systemFont(ofSize: 15, weight: .heavy)
        case "italic": attributes[.font] = UIFont.italicSystemFont(ofSize: 15)
        case "underline": attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
        case "strikethrough": attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
        case "code": attributes[.font] = UIFont.monospacedSystemFont(ofSize: 14, weight: .regular)
        default: break
        }
        return NSAttributedString(string: label, attributes: attributes)
    }

    /// Lights the styles the selection already has.
    func show(active: Set<String>) {
        if surface.effect == nil { surface.effect = chatGlass() }
        for (index, button) in buttons.enumerated() {
            let item = FormatBar.items[index]
            let on = active.contains(item.type)
            button.backgroundColor = on ? Theme.accent : Theme.veil(0.07)
            button.setAttributedTitle(FormatBar.title(item.type, item.label, on: on), for: .normal)
            button.isSelected = on
        }
    }

    @objc private func pressed(_ sender: UIButton) {
        guard sender.tag < FormatBar.items.count else { return }
        let type = FormatBar.items[sender.tag].type
        if type == "text_link" { onLink?() } else { onAction?(type) }
    }

    @objc private func clearNow() { onAction?("clear") }

    override func layoutSubviews() {
        super.layoutSubviews()
        surface.frame = bounds
        scroll.frame = surface.bounds
        var x: CGFloat = 8
        for (index, button) in buttons.enumerated() {
            let wide: CGFloat = FormatBar.items[index].label.count > 1 ? 46 : 38
            button.frame = CGRect(x: x, y: (bounds.height - 32) / 2, width: wide, height: 32)
            x += wide + 6
        }
        clearButton.frame = CGRect(x: x, y: (bounds.height - 32) / 2, width: 36, height: 32)
        x += 36 + 8
        scroll.contentSize = CGSize(width: x, height: bounds.height)
    }
}
