import UIKit

/// The card of a link above the field while a message is being written: the page's site and title (and its
/// picture, small), with a cross that drops the card for this message.
final class LinkComposerCard: UIVisualEffectView {
    static let height: CGFloat = 56
    private let stripe = UIView()
    private let siteLabel = UILabel()
    private let titleLabel = UILabel()
    private let picture = UIImageView()
    private let closeButton = UIButton(type: .system)
    var onClose: (() -> Void)?

    init() {
        super.init(effect: nil)
        clipsToBounds = true
        layer.cornerRadius = 22
        layer.cornerCurve = .continuous
        stripe.backgroundColor = Theme.accent
        stripe.layer.cornerRadius = 1.5
        contentView.addSubview(stripe)
        siteLabel.font = .systemFont(ofSize: 12, weight: .bold)
        siteLabel.textColor = Theme.accent
        contentView.addSubview(siteLabel)
        titleLabel.font = .systemFont(ofSize: 13)
        titleLabel.textColor = Theme.muted
        contentView.addSubview(titleLabel)
        picture.contentMode = .scaleAspectFill
        picture.clipsToBounds = true
        picture.layer.cornerRadius = 8
        picture.layer.cornerCurve = .continuous
        picture.isHidden = true
        contentView.addSubview(picture)
        closeButton.setImage(chatSymbol("xmark", 14, .semibold), for: .normal)
        closeButton.tintColor = Theme.muted
        closeButton.accessibilityLabel = "Не прикладывать предпросмотр ссылки"
        closeButton.addTarget(self, action: #selector(closeNow), for: .touchUpInside)
        contentView.addSubview(closeButton)
        isAccessibilityElement = false
    }

    required init?(coder: NSCoder) { return nil }

    /// Shows a card as `encrypt` will take it.
    func show(_ card: [String: Any]) {
        if effect == nil { effect = chatGlass() }
        let shown = MsgLinkCard.parse(card)
        let site = shown?.site ?? ""
        let title = shown?.title ?? ""
        siteLabel.text = site
        // A page without a title of its own: its description stands in.
        titleLabel.text = title.isEmpty ? (shown?.about ?? "") : title
        let image = shown?.picture()
        picture.image = image
        picture.isHidden = image == nil
        siteLabel.accessibilityLabel = "Предпросмотр ссылки: " + site
        setNeedsLayout()
    }

    @objc private func closeNow() { onClose?() }

    override func layoutSubviews() {
        super.layoutSubviews()
        let height = bounds.height, width = bounds.width
        stripe.frame = CGRect(x: 16, y: 10, width: 3, height: height - 20)
        var right = width - 44
        closeButton.frame = CGRect(x: right, y: (height - 44) / 2, width: 44, height: 44)
        if !picture.isHidden {
            right -= 40
            picture.frame = CGRect(x: right, y: (height - 36) / 2, width: 36, height: 36)
            right -= 8
        }
        let textWidth = max(0, right - 28)
        siteLabel.frame = CGRect(x: 28, y: 11, width: textWidth, height: 16)
        titleLabel.frame = CGRect(x: 28, y: 28, width: textWidth, height: 17)
    }
}

/// The link of the message being written and its card: asks the fetcher for it when typing stops, shows it above
/// the field and hands it to the sending.
///
/// A page is fetched only for a link the person typed or pasted into this field themselves, and only while
/// «Предпросмотр ссылок» is on: not for a draft put back into the field, not for an edit, not for forwarded text.
/// Main queue only.
final class LinkComposer {
    /// How long typing must stop before a page is asked for.
    static let pause: TimeInterval = 0.6

    private let cardView = LinkComposerCard()
    private var waiting: DispatchWorkItem?
    private var ticket: LinkFetcher.Ticket?
    /// The link the work in hand (or the card shown) is for.
    private var link = ""
    /// The card ready to go with the message; nil: none (yet).
    private var card: [String: Any]?
    /// The link whose card the person dropped with the cross: not offered again for this message.
    private var dropped = ""
    /// The card appeared, changed or went: the screen places its views again.
    var onChanged: (() -> Void)?

    init() {
        cardView.isHidden = true
        cardView.onClose = { [weak self] in self?.drop() }
    }

    /// Adds the card to the chat's screen (it is placed by `place`).
    func install(in view: UIView) {
        view.addSubview(cardView)
        #if targetEnvironment(simulator)
        // -linkdemo composer: the card above the field, as after typing a link (no request is made).
        if UserDefaults.standard.string(forKey: "linkdemo") == "composer" {
            let sample = LinkDemo.composerCard()
            link = sample["url"] as? String ?? ""
            card = sample
            cardView.show(sample)
            cardView.isHidden = false
        }
        #endif
    }

    /// The field's text changed by the person's own typing or pasting. `active`: the field is for a new message
    /// (not an edit, not the comment of a forward).
    func typed(_ text: String, active: Bool) {
        waiting?.cancel()
        waiting = nil
        guard active, LinkSettings.on else {
            clear(keepDropped: active)
            return
        }
        // Nothing that could be a link: no need to wait to take the card away.
        if !text.lowercased().contains("https://") && !text.lowercased().contains("www.") {
            clear(keepDropped: false)
            return
        }
        let work = DispatchWorkItem { [weak self] in self?.look(text) }
        waiting = work
        DispatchQueue.main.asyncAfter(deadline: .now() + LinkComposer.pause, execute: work)
    }

    private func look(_ text: String) {
        waiting = nil
        guard LinkSettings.on, let found = LinkCore.candidate(text) else {
            clear(keepDropped: false)
            return
        }
        if found == dropped {
            clear(keepDropped: true)
            return
        }
        if found == link { return }
        clear(keepDropped: false)
        link = found
        ticket = LinkFetcher.shared.card(for: found) { [weak self] (made: [String: Any]?) -> Void in
            guard let self, self.link == found else { return }
            self.ticket = nil
            guard let made else { return }
            self.card = made
            self.cardView.show(made)
            self.cardView.isHidden = false
            self.onChanged?()
        }
    }

    /// The cross: this message goes without a card, whatever is typed after the link.
    private func drop() {
        dropped = link
        clear(keepDropped: true)
    }

    private func clear(keepDropped: Bool) {
        ticket?.cancel()
        ticket = nil
        link = ""
        card = nil
        if !keepDropped { dropped = "" }
        if !cardView.isHidden {
            cardView.isHidden = true
            onChanged?()
        }
    }

    /// The card to send with this text, if one is ready and still belongs to it; the composer is then empty again.
    func take(for text: String) -> [String: Any]? {
        waiting?.cancel()
        waiting = nil
        var ready: [String: Any]? = nil
        if let card, !link.isEmpty, LinkSettings.on, LinkCore.candidate(text) == link { ready = card }
        clear(keepDropped: false)
        return ready
    }

    /// The field was emptied or given to something else (an edit, a forward).
    func reset() {
        waiting?.cancel()
        waiting = nil
        clear(keepDropped: false)
    }

    /// Places the card above the composer (and above the bar of an answer, when there is one): `above` is the top
    /// of what already stands there. Gives the new top. `hidden`: the composer itself is not shown now.
    func place(composerFrame: CGRect, above: CGFloat, hidden: Bool) -> CGFloat {
        if hidden || cardView.isHidden {
            if hidden && !cardView.isHidden { cardView.alpha = 0 }
            return above
        }
        cardView.alpha = 1
        cardView.frame = CGRect(x: composerFrame.minX, y: above - 6 - LinkComposerCard.height, width: composerFrame.width, height: LinkComposerCard.height)
        return cardView.frame.minY
    }
}
