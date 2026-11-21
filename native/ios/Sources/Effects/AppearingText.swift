import UIKit

/// Text whose words rise in one after another (the reference's `AppearingText`, effects.tsx → expokit
/// `AnimatedText variant="reveal"`, kit/ui/text-animation.tsx): word after word every 70 ms, each fades in over
/// 400 ms (ease-out cubic) while it rises from 0.6 of a line on a soft, critically damped settle over 720 ms. It plays
/// again when the text changes; with the app's animations off (Effects/Motion.swift) the text is simply there.
///
/// The text itself is an ordinary label (it gives the size and what VoiceOver reads); while the words play, the label
/// is hidden and a copy of each word stands exactly where the label puts it.
final class AppearingTextView: UIView {
    /// The text as it is laid out: a ready attributed string (font, colour, spacing, alignment).
    private(set) var words = NSAttributedString()
    private let label = UILabel()
    private let stage = UIView()
    private var pieces: [(view: UILabel, index: Int)] = []
    private var link: CADisplayLink?
    private var startedAt: CFTimeInterval = 0
    private var lineHeight: CGFloat = 20
    private var pendingPlay = false
    /// Milliseconds before the first word moves.
    var delay: Double = 0

    static let stagger: Double = 70

    override init(frame: CGRect) {
        super.init(frame: frame)
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        stage.isUserInteractionEnabled = false
        stage.isAccessibilityElement = false
        stage.accessibilityElementsHidden = true
        addSubview(stage)
        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: topAnchor), label.bottomAnchor.constraint(equalTo: bottomAnchor),
            label.leadingAnchor.constraint(equalTo: leadingAnchor), label.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
        label.setContentCompressionResistancePriority(.required, for: .vertical)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { link?.invalidate() }

    /// Shows `text` (plays the words in when it differs from what is shown).
    func show(_ text: NSAttributedString) {
        if text.isEqual(to: words) { return }
        words = text
        label.attributedText = text
        isAccessibilityElement = true
        accessibilityLabel = text.string
        label.isAccessibilityElement = false
        let paragraph = text.length > 0 ? text.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle : nil
        let font = text.length > 0 ? text.attribute(.font, at: 0, effectiveRange: nil) as? UIFont : nil
        lineHeight = max(paragraph?.maximumLineHeight ?? 0, font?.lineHeight ?? 20)
        stop()
        guard Motion.enabled, text.length > 0 else { return }
        pendingPlay = true
        label.alpha = 0
        setNeedsLayout()
    }

    /// The same, from plain words in one style.
    func show(_ text: String, font: UIFont, color: UIColor, lineHeight: CGFloat = 0, kern: CGFloat = 0, alignment: NSTextAlignment = .natural) {
        let paragraph = NSMutableParagraphStyle()
        if lineHeight > 0 {
            paragraph.minimumLineHeight = lineHeight
            paragraph.maximumLineHeight = lineHeight
        }
        paragraph.alignment = alignment
        var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color, .paragraphStyle: paragraph]
        if kern != 0 { attributes[.kern] = kern }
        show(NSAttributedString(string: text, attributes: attributes))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        stage.frame = bounds
        if pendingPlay && bounds.width > 0 {
            pendingPlay = false
            play()
        }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { stop() }
    }

    private func stop() {
        link?.invalidate()
        link = nil
        pieces.forEach { $0.view.removeFromSuperview() }
        pieces = []
        label.alpha = 1
    }

    /// Where each word stands in the label (TextKit laid out the same way as the label: same width, no padding).
    private func wordRects() -> [(range: NSRange, rect: CGRect)] {
        let storage = NSTextStorage(attributedString: words)
        let manager = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: bounds.width, height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.lineBreakMode = .byWordWrapping
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
        manager.ensureLayout(for: container)
        let used = manager.usedRect(for: container)
        let offsetY = max(0, (bounds.height - used.height) / 2)
        var out: [(range: NSRange, rect: CGRect)] = []
        let text = words.string as NSString
        var index = 0
        while index < text.length {
            let char = text.character(at: index)
            let space = CharacterSet.whitespacesAndNewlines.contains(Unicode.Scalar(char) ?? " ")
            if space {
                index += 1
                continue
            }
            var end = index
            while end < text.length {
                let next = text.character(at: end)
                if CharacterSet.whitespacesAndNewlines.contains(Unicode.Scalar(next) ?? " ") { break }
                end += 1
            }
            let range = NSRange(location: index, length: end - index)
            let glyphs = manager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
            var rect = manager.boundingRect(forGlyphRange: glyphs, in: container)
            // The whole line's height, so the word sits on the line exactly as the label sets it.
            let line = manager.lineFragmentRect(forGlyphAt: glyphs.location, effectiveRange: nil)
            rect.origin.y = line.minY + offsetY
            rect.size.height = line.height
            out.append((range, rect))
            index = end
        }
        return out
    }

    private func play() {
        stop()
        let rects = wordRects()
        guard !rects.isEmpty else { return }
        label.alpha = 0
        for (index, item) in rects.enumerated() {
            let piece = UILabel()
            let part = NSMutableAttributedString(attributedString: words.attributedSubstring(from: item.range))
            // A single word on its own line: no paragraph alignment to move it.
            part.removeAttribute(.paragraphStyle, range: NSRange(location: 0, length: part.length))
            if let style = words.attribute(.paragraphStyle, at: item.range.location, effectiveRange: nil) as? NSParagraphStyle, style.maximumLineHeight > 0 {
                let own = NSMutableParagraphStyle()
                own.minimumLineHeight = style.minimumLineHeight
                own.maximumLineHeight = style.maximumLineHeight
                part.addAttribute(.paragraphStyle, value: own, range: NSRange(location: 0, length: part.length))
            }
            piece.attributedText = part
            piece.frame = CGRect(x: item.rect.minX, y: item.rect.minY, width: ceil(item.rect.width) + 2, height: item.rect.height)
            piece.alpha = 0
            stage.addSubview(piece)
            pieces.append((piece, index))
        }
        startedAt = CACurrentMediaTime() + delay / 1000
        let made = CADisplayLink(target: self, selector: #selector(frame(_:)))
        made.add(to: .main, forMode: .common)
        link = made
        step(0)
    }

    @objc private func frame(_ link: CADisplayLink) {
        let ms = (CACurrentMediaTime() - startedAt) * 1000
        step(max(0, ms))
        let total = Double(max(0, pieces.count - 1)) * AppearingTextView.stagger + 720
        if ms >= total { stop() }
    }

    private func step(_ ms: Double) {
        let rise = lineHeight * 0.6
        for item in pieces {
            let start = Double(item.index) * AppearingTextView.stagger
            let fade = AppearingTextView.clamp((ms - start) / 400)
            let move = AppearingTextView.clamp((ms - start) / 720)
            item.view.alpha = CGFloat(AppearingTextView.easeOut(fade))
            item.view.transform = CGAffineTransform(translationX: 0, y: rise * CGFloat(1 - AppearingTextView.soft(move)))
        }
    }

    private static func clamp(_ t: Double) -> Double { return min(1, max(0, t)) }
    static func easeOut(_ t: Double) -> Double { return 1 - pow(1 - t, 3) }
    /// A soft, critically damped settle (no overshoot).
    static func soft(_ t: Double) -> Double { return t >= 1 ? 1 : 1 - exp(-7 * t) * (1 + 7 * t) }
}
