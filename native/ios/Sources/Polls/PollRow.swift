import UIKit

/// A poll inside a message (the reference's PollBubble.tsx): the question, «Опрос» or «Опрос · несколько
/// ответов», the options — before voting a circle (or a square when several answers are allowed), after voting
/// the share in per cent, a bar and a tick at what this person chose — «Голосовать» for several answers, and at
/// the bottom how many voted with «Отменить голос».
///
/// The poll itself is `meta.poll` inside the encrypted message; a vote is an encrypted action (`meta.action`
/// `{type: "vote", target, options}`) and the results are folded by the shared core (`foldChat` gives `poll`
/// `{counts, mine, voters}`), exactly as on the other phone.
struct MsgPoll: Equatable {
    let question: String
    let options: [String]
    let multiple: Bool
    let counts: [Int]
    let mine: [Int]
    let voters: Int
    /// Options ticked but not sent yet (several answers).
    let draft: [Int]
    /// Nothing can be chosen (a message on its way out, the multi-select).
    let disabled: Bool

    var voted: Bool { !mine.isEmpty }
    var total: Int { counts.reduce(0, +) }

    /// The poll of a row (`row["poll"]`, made by `PollRows.fields`), or nil.
    static func parse(_ value: Any?) -> MsgPoll? {
        guard let map = value as? [String: Any], let question = map["question"] as? String, let options = map["options"] as? [String], !options.isEmpty else { return nil }
        func ints(_ key: String) -> [Int] { (map[key] as? [NSNumber] ?? []).map { $0.intValue } }
        return MsgPoll(question: question, options: options, multiple: map["multiple"] as? Bool ?? false, counts: ints("counts"), mine: ints("mine"),
                       voters: (map["voters"] as? NSNumber)?.intValue ?? 0, draft: ints("draft"), disabled: map["disabled"] as? Bool ?? false)
    }

    /// «1 голос», «3 голоса», «7 голосов».
    static func votes(_ n: Int) -> String {
        if n % 10 == 1 && n % 100 != 11 { return "голос" }
        if n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) { return "голоса" }
        return "голосов"
    }

    var spoken: String {
        var words = [question, multiple ? "Опрос · несколько ответов" : "Опрос"]
        for (index, option) in options.enumerated() {
            let count = index < counts.count ? counts[index] : 0
            words.append(voted ? option + ", " + String(total > 0 ? Int((Double(count) / Double(total) * 100).rounded()) : 0) + "%" : option)
        }
        words.append(voters > 0 ? "\(voters) \(MsgPoll.votes(voters))" : "Пока нет голосов")
        return words.joined(separator: ". ")
    }
}

private let pollQuestionFont = UIFont.systemFont(ofSize: 15, weight: .bold)
private let pollNoteFont = UIFont.systemFont(ofSize: 11)
private let pollOptionFont = UIFont.systemFont(ofSize: 14)
private let pollShareFont = UIFont.systemFont(ofSize: 13, weight: .bold)
private let pollVoteFont = UIFont.systemFont(ofSize: 14, weight: .bold)
private let pollRetractFont = UIFont.systemFont(ofSize: 12)

private func pollTextHeight(_ text: String, _ font: UIFont, _ width: CGFloat, lineHeight: CGFloat = 0) -> CGFloat {
    if text.isEmpty { return 0 }
    let style = NSMutableParagraphStyle()
    style.lineBreakMode = .byWordWrapping
    if lineHeight > 0 {
        style.minimumLineHeight = lineHeight
        style.maximumLineHeight = lineHeight
    }
    let box = NSAttributedString(string: text, attributes: [.font: font, .paragraphStyle: style])
        .boundingRect(with: CGSize(width: max(1, width), height: 2000), options: [.usesLineFragmentOrigin], context: nil)
    return ceil(box.height)
}

/// Where the parts of a poll go, for the width it is shown at; frames from the poll's own corner.
struct MsgPollLayout: Equatable {
    var size = CGSize.zero
    var questionHeight: CGFloat = 0
    var optionRows: [CGRect] = []
    var optionTextHeights: [CGFloat] = []
    var voteRow = CGRect.zero
    var footer = CGRect.zero
    var retract = CGRect.zero

    static func make(_ poll: MsgPoll, width inner: CGFloat) -> MsgPollLayout {
        var layout = MsgPollLayout()
        // minWidth 230, maxWidth 290 — within the room the message has.
        let width = min(inner, 290)
        var y: CGFloat = 2
        layout.questionHeight = pollTextHeight(poll.question, pollQuestionFont, width, lineHeight: 20)
        y += layout.questionHeight + 8
        y += 14 + 8
        let textWidth = width - 20 - 8 - 8 - 17
        for option in poll.options {
            let textHeight = max(18, pollTextHeight(option, pollOptionFont, textWidth))
            var rowHeight = 4 + max(20, textHeight) + 4
            if poll.voted { rowHeight += 4 + 4 }
            layout.optionRows.append(CGRect(x: 0, y: y, width: width, height: rowHeight))
            layout.optionTextHeights.append(textHeight)
            y += rowHeight + 8
        }
        if poll.multiple && !poll.voted {
            layout.voteRow = CGRect(x: 0, y: y, width: width, height: 8 + 18 + 8)
            y += layout.voteRow.height + 8
        }
        layout.footer = CGRect(x: 0, y: y, width: width, height: 16)
        if poll.voted && !poll.disabled {
            let words = ceil(NSAttributedString(string: "Отменить голос", attributes: [.font: pollRetractFont]).size().width)
            layout.retract = CGRect(x: width - words - 8, y: y - 8, width: words + 16, height: 32)
        }
        y += 16 + 2
        layout.size = CGSize(width: max(min(inner, 230), width), height: y)
        return layout
    }

    /// The part of the poll under a point (from the poll's corner): "option:<n>", "vote" or "retract".
    func part(at point: CGPoint, poll: MsgPoll) -> String? {
        if poll.disabled { return nil }
        if retract != .zero, retract.contains(point) { return "retract" }
        if voteRow != .zero, voteRow.contains(point) { return "vote" }
        for (index, row) in optionRows.enumerated() where row.contains(point) { return "option:\(index)" }
        return nil
    }

    private func line(_ text: String, _ font: UIFont, _ color: UIColor, _ box: CGRect, lines: Bool, lineHeight: CGFloat = 0, center: Bool = false) {
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = lines ? .byWordWrapping : .byTruncatingTail
        if center { style.alignment = .center }
        if lineHeight > 0 {
            style.minimumLineHeight = lineHeight
            style.maximumLineHeight = lineHeight
        }
        NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: color, .paragraphStyle: style])
            .draw(with: box, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
    }

    private func symbol(_ name: String, _ size: CGFloat, _ color: UIColor, center: CGPoint) {
        guard let image = UIImage(systemName: name, withConfiguration: UIImage.SymbolConfiguration(pointSize: size, weight: .regular))?.withTintColor(color, renderingMode: .alwaysOriginal) else { return }
        image.draw(at: CGPoint(x: center.x - image.size.width / 2, y: center.y - image.size.height / 2))
    }

    func draw(_ poll: MsgPoll, in context: CGContext, at origin: CGPoint, palette: MsgPalette) {
        let width = size.width
        let x = origin.x
        var y = origin.y + 2
        line(poll.question, pollQuestionFont, palette.text, CGRect(x: x, y: y, width: width, height: questionHeight + 2), lines: true, lineHeight: 20)
        y += questionHeight + 8
        line(poll.multiple ? "Опрос · несколько ответов" : "Опрос", pollNoteFont, palette.muted, CGRect(x: x, y: y, width: width, height: 14), lines: false)
        let total = poll.total
        let track = Theme.dark ? UIColor(white: 1, alpha: 0.08) : UIColor(white: 0, alpha: 0.06)
        for (index, option) in poll.options.enumerated() where index < optionRows.count {
            let row = optionRows[index].offsetBy(dx: x, dy: origin.y)
            let textHeight = optionTextHeights[index]
            let count = index < poll.counts.count ? poll.counts[index] : 0
            let share = total > 0 ? Double(count) / Double(total) : 0
            let chosen = poll.mine.contains(index), picked = poll.draft.contains(index)
            let lineTop = row.minY + 4
            let lineHeight = max(20, textHeight)
            if poll.voted {
                line("\(Int((share * 100).rounded()))%", pollShareFont, palette.text, CGRect(x: row.minX, y: lineTop + (lineHeight - 17) / 2, width: 38, height: 17), lines: false)
            } else {
                let name = poll.multiple ? (picked ? "checkmark.square.fill" : "square") : "circle"
                symbol(name, 17, picked ? palette.accent : palette.muted, center: CGPoint(x: row.minX + 10, y: lineTop + lineHeight / 2))
            }
            let textLeft = row.minX + (poll.voted ? 46 : 28)
            let textRight = row.maxX - (chosen ? 25 : 0)
            line(option, pollOptionFont, palette.text, CGRect(x: textLeft, y: lineTop + (lineHeight - textHeight) / 2, width: textRight - textLeft, height: textHeight + 2), lines: true)
            if chosen { symbol("checkmark.circle.fill", 15, palette.accent, center: CGPoint(x: row.maxX - 9, y: lineTop + lineHeight / 2)) }
            if poll.voted {
                let barTop = lineTop + lineHeight + 4
                let barWidth = row.width - 46
                context.setFillColor(track.cgColor)
                context.addPath(UIBezierPath(roundedRect: CGRect(x: row.minX + 46, y: barTop, width: barWidth, height: 4), cornerRadius: 2).cgPath)
                context.fillPath()
                context.setFillColor((chosen ? palette.accent : palette.subtle).cgColor)
                context.addPath(UIBezierPath(roundedRect: CGRect(x: row.minX + 46, y: barTop, width: barWidth * CGFloat(max(0.02, share)), height: 4), cornerRadius: 2).cgPath)
                context.fillPath()
            }
        }
        if voteRow != .zero {
            let box = voteRow.offsetBy(dx: x, dy: origin.y)
            let ready = !poll.draft.isEmpty && !poll.disabled
            line("Голосовать", pollVoteFont, palette.accent.withAlphaComponent(ready ? 1 : 0.4), CGRect(x: box.minX, y: box.minY + 8, width: box.width, height: 18), lines: false, center: true)
        }
        let foot = footer.offsetBy(dx: x, dy: origin.y)
        line(poll.voters > 0 ? "\(poll.voters) \(MsgPoll.votes(poll.voters))" : "Пока нет голосов", pollNoteFont, palette.muted, CGRect(x: foot.minX, y: foot.minY + 1, width: foot.width * 0.6, height: 14), lines: false)
        if retract != .zero {
            let words = NSAttributedString(string: "Отменить голос", attributes: [.font: pollRetractFont, .foregroundColor: palette.accent])
            let size = words.size()
            words.draw(at: CGPoint(x: foot.maxX - size.width, y: foot.minY + (16 - size.height) / 2))
        }
    }
}

/// The poll fields of a row of the chat (made off the main queue by ChatHistory).
enum PollRows {
    /// `meta.poll` with the folded results (`message["poll"]`), the options ticked so far and whether it can be used.
    static func fields(_ message: [String: Any], draft: [Int], disabled: Bool) -> [String: Any]? {
        guard let poll = (message["meta"] as? [String: Any])?["poll"] as? [String: Any], let question = poll["question"] as? String, let options = poll["options"] as? [String] else { return nil }
        let results = message["poll"] as? [String: Any]
        return ["question": question, "options": options, "multiple": poll["multiple"] as? Bool ?? false,
                "counts": results?["counts"] as? [NSNumber] ?? [], "mine": results?["mine"] as? [NSNumber] ?? [],
                "voters": results?["voters"] as? NSNumber ?? NSNumber(value: 0), "draft": draft, "disabled": disabled]
    }
}
