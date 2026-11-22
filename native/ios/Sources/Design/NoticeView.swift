import UIKit

/// The reference's `Notice` (components.tsx): glass of radius 18 (under the danger tint when it is an error), the
/// `alert-circle-outline` or `information-circle-outline` (19, danger / accent), the words (13 on 19, danger / text),
/// 14 inside, 10 between; with `retry`, the words of the action (12, bold, accent) at the end.
final class NoticeView: UIView {
    private let pill = GlassPill(interactive: false)
    private let tint = UIView()
    private let icon = UIImageView()
    private let words = UILabel()
    private let action = UIButton(type: .custom)
    private var retry: (() -> Void)?
    private var laidHeight: CGFloat = 0

    init(text: String, error: Bool, actionWords: String = "Повторить", retry: (() -> Void)? = nil) {
        self.retry = retry
        super.init(frame: .zero)
        pill.shape(radius: 18)
        pill.isUserInteractionEnabled = false
        addSubview(pill)
        tint.layer.cornerRadius = 18
        tint.layer.cornerCurve = .continuous
        tint.isUserInteractionEnabled = false
        tint.backgroundColor = ThemeStore.look.dangerBg
        tint.isHidden = !error
        addSubview(tint)
        icon.image = IonIcon.image(error ? "alert-circle-outline" : "information-circle-outline", size: 19)
        icon.tintColor = error ? Theme.danger : Theme.accent
        addSubview(icon)
        let style = NSMutableParagraphStyle()
        style.minimumLineHeight = 19
        style.maximumLineHeight = 19
        words.attributedText = NSAttributedString(string: text, attributes: [.font: UIFont.systemFont(ofSize: 13), .foregroundColor: error ? Theme.danger : Theme.text, .paragraphStyle: style])
        words.numberOfLines = 0
        addSubview(words)
        action.setAttributedTitle(NSAttributedString(string: actionWords, attributes: [.font: UIFont.systemFont(ofSize: 12, weight: .bold), .foregroundColor: Theme.accent]), for: .normal)
        action.isHidden = retry == nil
        action.addTarget(self, action: #selector(retried), for: .touchUpInside)
        addSubview(action)
        accessibilityTraits = .staticText
        accessibilityLabel = text
    }

    required init?(coder: NSCoder) { return nil }

    @objc private func retried() { retry?() }

    private var actionWidth: CGFloat { action.isHidden ? 0 : ceil(action.sizeThatFits(CGSize(width: 200, height: 28)).width) + 10 }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        let room = max(10, size.width - 28 - 19 - 10 - actionWidth)
        let tall = max(19, ceil(words.sizeThatFits(CGSize(width: room, height: 2000)).height))
        return CGSize(width: size.width, height: tall + 28)
    }

    override var intrinsicContentSize: CGSize {
        let width = bounds.width > 0 ? bounds.width : UIScreen.main.bounds.width - 36
        return CGSize(width: UIView.noIntrinsicMetric, height: sizeThatFits(CGSize(width: width, height: 0)).height)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        pill.frame = bounds
        tint.frame = bounds
        icon.frame = CGRect(x: 14, y: 14, width: 19, height: 19)
        let room = max(10, bounds.width - 28 - 19 - 10 - actionWidth)
        words.frame = CGRect(x: 43, y: 14, width: room, height: bounds.height - 28)
        action.frame = CGRect(x: bounds.width - 14 - actionWidth + 10, y: 14 - 4.5, width: actionWidth - 10, height: 28)
        // The height follows the width it was given (once known).
        let tall = sizeThatFits(bounds.size).height
        if abs(tall - laidHeight) > 0.5 { laidHeight = tall; invalidateIntrinsicContentSize() }
    }
}
