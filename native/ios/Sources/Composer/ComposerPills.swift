import UIKit

/// Composer: the reference's row under a chat (mobile/src/ChatScreen.tsx, the composer's row: gap 8) — a round
/// glass paperclip (40 pt), the field in a glass pill (radius 20, at least 40 pt tall, the emoji button inside on
/// its right), and a round glass microphone (40 pt); the send button (an accent circle of 40 pt) takes the
/// microphone's place while there is something to send. These are only the glass shapes, drawn under the
/// composer's own buttons and field; touches go through them.
final class ComposerPills {
    static let side: CGFloat = 40
    static let gap: CGFloat = 8

    private let clip = GlassPill(interactive: false)
    private let field = GlassPill(interactive: false)
    private let microphone = GlassPill(interactive: false)

    /// Puts the three shapes under everything else of the composer (`holder`: its content view).
    func install(in holder: UIView) {
        for pill in [microphone, field, clip] {
            pill.isUserInteractionEnabled = false
            holder.insertSubview(pill, at: 0)
        }
    }

    /// The field's pill: from the paperclip's gap to the microphone's gap.
    static func fieldPill(width: CGFloat, height: CGFloat) -> CGRect {
        CGRect(x: side + gap, y: 0, width: max(0, width - 2 * (side + gap)), height: height)
    }

    /// `microphone`: the round glass of the record button is shown (not while the send button stands there).
    func place(width: CGFloat, height: CGFloat, microphone shown: Bool, hidden: Bool) {
        clip.frame = CGRect(x: 0, y: height - ComposerPills.side, width: ComposerPills.side, height: ComposerPills.side)
        clip.shape(radius: ComposerPills.side / 2)
        field.frame = ComposerPills.fieldPill(width: width, height: height)
        field.shape(radius: 20)
        microphone.frame = CGRect(x: width - ComposerPills.side, y: height - ComposerPills.side, width: ComposerPills.side, height: ComposerPills.side)
        microphone.shape(radius: ComposerPills.side / 2)
        microphone.isHidden = hidden || !shown
        clip.isHidden = hidden
        field.isHidden = hidden
    }
}
