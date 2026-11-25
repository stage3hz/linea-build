import CoreGraphics

/// How the sign-in screen fits on the screen without scrolling (the same rules as Android auth/AuthFit.kt).
///
/// Two arrangements, and the screen moves between them once, together with the keyboard:
/// - full (no keyboard): the wordmark, the step's title and description (in the middle), the glass card, the three
///   trust chips under it (AuthScreen.tsx:317-362);
/// - compact (the keyboard is up): the step's title at the top and the card right under it, down to the keyboard,
///   with «Продолжить» at the card's bottom, just above the keyboard; the wordmark, the description, the chips and the
///   theme pill step aside.
/// What does not fit leaves in a fixed order (the hint under the field stays longest), so the title, the field with its
/// caption, what went wrong and the button are always above the keyboard. The parts above the fields (the progress and
/// the switch) are chosen without looking at the messages, so a message that appears never moves a field.
/// Sizes in points. Pure: no views.
enum AuthFit {
    /// The row of the theme pill stands above the page: the page starts this far under the status bar.
    static let pillRow: CGFloat = 58
    /// The room above the wordmark when everything fits (at most).
    static let topGap: CGFloat = 64
    /// Under the card, above the bottom edge or the keyboard, in the full arrangement.
    static let edge: CGFloat = 12
    /// Above the title when the keyboard is up.
    static let compactTop: CGFloat = 8
    /// Between the card and the keyboard.
    static let compactEdge: CGFloat = 8
    /// Between the title and the card when the keyboard is up.
    static let compactHeadingGap: CGFloat = 12
    /// Inside the card (22 in the reference), and while the keyboard is up.
    static let pad: CGFloat = 22
    static let compactPad: CGFloat = 16
    /// Under the switch and the progress (18 in the reference), and while the keyboard is up.
    static let chromeGap: CGFloat = 18
    static let compactChromeGap: CGFloat = 12
    /// Between the other parts of the card.
    static let gap: CGFloat = 12
    /// Between «Продолжить» and the links under it.
    static let linkGap: CGFloat = 4
    /// Between the parts of the card, the links too, in the full arrangement (AuthScreen.tsx:321 `gap: 18`).
    static let fullGap: CGFloat = 18
    /// A keyboard lower than this (a hardware keyboard's bar) keeps the full arrangement.
    static let keyboard: CGFloat = 100
    /// Under the wordmark (AuthScreen.tsx:317 `marginBottom: 26`).
    static let afterBrand: CGFloat = 26
    /// Under the description (AuthScreen.tsx:320 `marginBottom: 24`).
    static let afterHint: CGFloat = 24
    /// Above the trust chips, under the card (AuthScreen.tsx:361 `marginTop: 22`).
    static let beforeChips: CGFloat = 22

    /// Under the title: 12 above the description (AuthScreen.tsx:320 `marginTop: 12`), more when it stepped aside.
    static func afterHeading(_ hint: Bool) -> CGFloat { return hint ? 12 : 16 }

    /// A part that may leave, with what it takes: its height and the gap that comes with it.
    struct Part {
        let id: Int
        let cost: CGFloat
    }

    /// The full arrangement: which of the parts above the card stay, the room above them, the card's parts that stay.
    struct Plan {
        let brand: Bool
        let chips: Bool
        let hint: Bool
        let gap: CGFloat
        let kept: Set<Int>
    }

    /// Takes the parts in their order while they fit; returns what they take.
    private static func take(_ parts: [Part], _ budget: CGFloat, _ into: inout Set<Int>) -> CGFloat {
        var left = budget
        for part in parts where part.cost <= left {
            into.insert(part.id)
            left -= part.cost
        }
        return budget - left
    }

    /// The keyboard is up: which of the card's parts stay.
    /// - `room`: the inside of the card (from under the title to above the keyboard, without the card's padding);
    /// - `core`: what is always there: the fields (with their captions), the waiting box, the button, their gaps;
    /// - `messages`: what went wrong, notices, the attempts left — shown now;
    /// - `helps`: the hints under the fields, the most needed first; `chrome`: the progress and the switch;
    ///   `extras`: the rest (the second hint, the links, «Только ручной ввод»).
    static func compact(room: CGFloat, core: CGFloat, messages: CGFloat, helps: [Part], chrome: [Part], extras: [Part]) -> Set<Int> {
        let budget = room - core
        // The parts above the fields are chosen without the messages: a message that appears does not move a field.
        var scratch = Set<Int>()
        let helpRoom = take(helps, budget, &scratch)
        var chromeKept = Set<Int>()
        var chromeUsed = take(chrome, budget - helpRoom, &chromeKept)
        if budget - chromeUsed - messages < 0 {
            // Only when a message cannot be shown otherwise.
            chromeKept.removeAll()
            chromeUsed = take(chrome, budget - messages, &chromeKept)
        }
        var kept = chromeKept
        var left = budget - chromeUsed - messages
        left -= take(helps, left, &kept)
        _ = take(extras, left, &kept)
        return kept
    }

    /// No keyboard: what stays above the card and on it, and the room above the wordmark.
    /// - `room`: from under the theme pill's row to above the bottom edge;
    /// - `brand`, `heading`, `hint`: the heights of the parts above the card; `chips`: the trust chips under it;
    /// - `card`: the card with its padding, the fields, the button and the messages (what always shows on it).
    static func full(room: CGFloat, brand: CGFloat, heading: CGFloat, hint: CGFloat, card: CGFloat, chips: CGFloat,
                     helps: [Part], chrome: [Part], extras: [Part]) -> Plan {
        var chromeCost: CGFloat = 0
        for part in chrome { chromeCost += part.cost }
        var helpCost: CGFloat = 0
        for part in helps { helpCost += part.cost }
        var extraCost: CGFloat = 0
        for part in extras { extraCost += part.cost }
        var all = Set<Int>()
        for part in chrome + helps + extras { all.insert(part.id) }
        // The chips leave first, then the description.
        let steps: [(Bool, Bool)] = [(true, true), (false, true), (false, false)]
        for (withChips, withHint) in steps {
            let above = AuthFit.above(brand: brand, heading: heading, hint: hint, withBrand: true, withHint: withHint)
            let below: CGFloat = withChips ? beforeChips + chips : 0
            let need = above + card + chromeCost + helpCost + extraCost + below
            // The chips come only when the page also keeps its whole room above the wordmark: in the previous app
            // they stand under the card, past the bottom edge of a phone, and the page starts at its own place.
            if withChips && need + topGap > room { continue }
            if need <= room { return Plan(brand: true, chips: withChips, hint: withHint, gap: min(topGap, room - need), kept: all) }
        }
        // Then the extras, then (when even the hints do not fit) the wordmark.
        for withBrand in [true, false] {
            let above = AuthFit.above(brand: brand, heading: heading, hint: hint, withBrand: withBrand, withHint: false)
            let budget = room - above - card - chromeCost
            if withBrand && budget < helpCost { continue }
            var kept = Set<Int>()
            for part in chrome { kept.insert(part.id) }
            let left = budget - take(helps, budget, &kept)
            _ = take(extras, left, &kept)
            return Plan(brand: withBrand, chips: false, hint: false, gap: 0, kept: kept)
        }
        return Plan(brand: false, chips: false, hint: false, gap: 0, kept: all)
    }

    /// What the parts above the card take, with their gaps.
    private static func above(brand: CGFloat, heading: CGFloat, hint: CGFloat, withBrand: Bool, withHint: Bool) -> CGFloat {
        var total: CGFloat = heading
        if withBrand { total += brand + afterBrand }
        if withHint {
            total += afterHeading(true) + hint + afterHint
        } else {
            total += afterHeading(false)
        }
        return total
    }
}
