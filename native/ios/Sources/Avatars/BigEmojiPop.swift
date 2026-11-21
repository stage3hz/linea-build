import UIKit

/// The big emoji of a message (1–3 emoji alone) as the reference's iPhone shows them: MessageRow.tsx renders each
/// as `AnimatedEmoji mode="once"`, i.e. the Apple glyph popping in from 0.6 with the spring of
/// Avatars/AnimatedEmoji.swift, once, each time the row appears. The list draws a whole row in one pass
/// (Chat/MessageList.swift), so for the pop the glyphs are left out of the row's drawing and a picture of them,
/// drawn the same way, springs in over the same place; when it has settled the row draws them again itself.
/// Plays while animations and «Анимированные стикеры» (Motion.feature("stickers")) are on.
enum BigEmojiPop {
    /// The picture of the glyphs while they pop; it remembers the row it belongs to.
    final class PopView: UIImageView {
        var key = ""
    }

    /// A cell was given a row (MsgRowCell.show).
    static func shown(_ cell: MsgRowCell, _ row: MsgRow) {
        let canvas = cell.canvas
        let current = canvas.subviews.compactMap { $0 as? PopView }.first
        guard row.bigEmoji > 0, row.kind == 0, Motion.enabled, Motion.feature("stickers") else {
            current?.removeFromSuperview()
            canvas.hideBody = false
            popped[ObjectIdentifier(cell)] = nil
            return
        }
        // Once per appearance: the same row shown again in the same cell (a tick, a reaction) does not pop again.
        if current?.key == row.key { return }
        if let lastKey = popped[ObjectIdentifier(cell)], lastKey == row.key { return }
        popped[ObjectIdentifier(cell)] = row.key
        canvas.hideBody = true
        let key = row.key
        // The cell gets its final size after it is handed out: the place of the glyphs is known on the next turn.
        DispatchQueue.main.async { [weak cell] in
            guard let cell else { return }
            let canvas = cell.canvas
            guard canvas.row?.key == key else { return }
            canvas.setNeedsDisplay()
            canvas.layer.displayIfNeeded()
            let box = canvas.drawnBodyBox
            guard box.width > 0, box.height > 0, let text = canvas.row?.text else {
                canvas.hideBody = false
                canvas.setNeedsDisplay()
                return
            }
            let style = NSMutableParagraphStyle()
            style.lineBreakMode = .byWordWrapping
            style.lineSpacing = 2
            let words = NSAttributedString(string: text, attributes: [.font: UIFont.systemFont(ofSize: canvas.fontSize), .foregroundColor: canvas.palette.text, .paragraphStyle: style])
            let picture = UIGraphicsImageRenderer(size: box.size).image { (_: UIGraphicsImageRendererContext) -> Void in
                words.draw(with: CGRect(origin: .zero, size: box.size), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
            }
            let pop = PopView(image: picture)
            pop.key = key
            pop.frame = box
            // The glyphs turn around their own middle, not the middle of the whole line.
            let glyphs = words.boundingRect(with: CGSize(width: box.width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin], context: nil)
            let anchorX = min(1, max(0, glyphs.width / 2 / max(1, box.width)))
            pop.layer.anchorPoint = CGPoint(x: anchorX, y: 0.5)
            pop.frame = box
            canvas.addSubview(pop)
            let spring = CASpringAnimation(keyPath: "transform.scale")
            spring.mass = 1
            spring.stiffness = AnimatedEmojiView.popStiffness
            spring.damping = AnimatedEmojiView.popDamping
            spring.fromValue = 0.6
            spring.toValue = 1
            spring.duration = spring.settlingDuration
            CATransaction.begin()
            CATransaction.setCompletionBlock { [weak pop, weak canvas] in
                guard let pop, let canvas, pop.superview === canvas else { return }
                pop.removeFromSuperview()
                if canvas.row?.key == key {
                    canvas.hideBody = false
                    canvas.setNeedsDisplay()
                }
            }
            pop.layer.add(spring, forKey: "pop")
            CATransaction.commit()
        }
    }

    /// The row each cell popped last (a cell is reused for another row: that one pops when it appears).
    private static var popped: [ObjectIdentifier: String] = [:]
}
