import UIKit

/// The shelves of «Главная» (mobile/src/music/MusicScreen.tsx: `Shelf`, `CoverCard`, `ArtistCircle`): a 24 pt bold
/// title and a row of cards that scrolls sideways — «Любимое» (covers come first) and «Артисты» (round, the first
/// track of each artist in the list gives the picture; a touch searches for the artist).
enum MusicShelves {
    /// Spotify's Mist #B3B3B3 for artist names on dark surfaces; the theme's grey on light ones.
    static var mist: UIColor { return Theme.dark ? UIColor(hex: 0xB3B3B3) : Theme.muted }

    /// The artists of a list: the first track of each (by name, case and spaces aside), at most twelve.
    static func artists(_ rows: [MusicTrack]) -> [MusicTrack] {
        var seen = Set<String>()
        var out: [MusicTrack] = []
        for track in rows {
            let key = track.artist.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if key.isEmpty || seen.contains(key) { continue }
            seen.insert(key)
            out.append(track)
            if out.count == 12 { break }
        }
        return out
    }

    /// A shelf: the title, then the cards; the row runs to the screen's edges (`edge` — the page's side margin).
    static func shelf(_ title: String, cards: [UIView], edge: CGFloat) -> UIView {
        let box = UIStackView()
        box.axis = .vertical
        box.spacing = 14
        let heading = UILabel()
        heading.text = title
        heading.font = .systemFont(ofSize: 24, weight: .bold)
        heading.textColor = Theme.text
        heading.accessibilityTraits = .header
        box.addArrangedSubview(heading)
        let holder = UIView()
        let scroll = UIScrollView()
        scroll.showsHorizontalScrollIndicator = false
        scroll.clipsToBounds = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(scroll)
        let row = UIStackView(arrangedSubviews: cards)
        row.axis = .horizontal
        row.alignment = .top
        row.spacing = 12
        row.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(row)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: holder.topAnchor), scroll.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: -edge), scroll.trailingAnchor.constraint(equalTo: holder.trailingAnchor, constant: edge),
            row.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor), row.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            row.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: edge),
            row.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -edge),
            row.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
        ])
        box.addArrangedSubview(holder)
        return box
    }

    /// «Covers come first»: a near-square cover (radius 6) with the title and the artist under it.
    static func coverCard(_ track: MusicTrack, action: @escaping () -> Void) -> UIView {
        let card = UIControl()
        card.isAccessibilityElement = true
        card.accessibilityTraits = .button
        card.accessibilityLabel = "Слушать: \(track.title), \(track.artist)"
        let cover = MusicCoverView(radius: 6)
        cover.bind(track)
        let title = UILabel()
        title.text = track.title
        title.font = .systemFont(ofSize: 14, weight: .semibold)
        title.textColor = Theme.text
        let artist = UILabel()
        artist.text = track.artist
        artist.font = .systemFont(ofSize: 13)
        artist.textColor = mist
        let column = UIStackView(arrangedSubviews: [cover, title, artist])
        column.axis = .vertical
        column.spacing = 6
        column.isUserInteractionEnabled = false
        column.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(column)
        NSLayoutConstraint.activate([
            card.widthAnchor.constraint(equalToConstant: 140),
            cover.widthAnchor.constraint(equalToConstant: 140), cover.heightAnchor.constraint(equalToConstant: 140),
            column.topAnchor.constraint(equalTo: card.topAnchor), column.bottomAnchor.constraint(equalTo: card.bottomAnchor),
            column.leadingAnchor.constraint(equalTo: card.leadingAnchor), column.trailingAnchor.constraint(equalTo: card.trailingAnchor),
        ])
        pressFeedback(card)
        card.addAction(UIAction { _ in action() }, for: .touchUpInside)
        return card
    }

    /// Artists are round.
    static func artistCircle(_ track: MusicTrack, action: @escaping () -> Void) -> UIView {
        let card = UIControl()
        card.isAccessibilityElement = true
        card.accessibilityTraits = .button
        card.accessibilityLabel = "Найти: \(track.artist)"
        let face = MusicArtistFace(track)
        let name = UILabel()
        name.text = track.artist
        name.font = .systemFont(ofSize: 14, weight: .semibold)
        name.textColor = Theme.text
        name.textAlignment = .center
        let kind = UILabel()
        kind.text = "Артист"
        kind.font = .systemFont(ofSize: 12)
        kind.textColor = mist
        kind.textAlignment = .center
        let column = UIStackView(arrangedSubviews: [face, name, kind])
        column.axis = .vertical
        column.alignment = .center
        column.spacing = 8
        column.setCustomSpacing(0, after: name)
        column.isUserInteractionEnabled = false
        column.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(column)
        NSLayoutConstraint.activate([
            card.widthAnchor.constraint(equalToConstant: 120),
            face.widthAnchor.constraint(equalToConstant: 120), face.heightAnchor.constraint(equalToConstant: 120),
            name.widthAnchor.constraint(lessThanOrEqualTo: card.widthAnchor),
            column.topAnchor.constraint(equalTo: card.topAnchor), column.bottomAnchor.constraint(equalTo: card.bottomAnchor),
            column.leadingAnchor.constraint(equalTo: card.leadingAnchor), column.trailingAnchor.constraint(equalTo: card.trailingAnchor),
        ])
        pressFeedback(card)
        card.addAction(UIAction { _ in action() }, for: .touchUpInside)
        return card
    }

    /// Pressed: a little transparent (opacity .75).
    private static func pressFeedback(_ card: UIControl) {
        card.addAction(UIAction { [weak card] _ in card?.alpha = 0.75 }, for: [.touchDown, .touchDragEnter])
        card.addAction(UIAction { [weak card] _ in card?.alpha = 1 }, for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
    }
}

/// An artist's round picture: the cover of their track, or the first letter of the name.
final class MusicArtistFace: UIView {
    private let picture = UIImageView()
    private let letter = UILabel()
    private let track: MusicTrack

    init(_ track: MusicTrack) {
        self.track = track
        super.init(frame: .zero)
        backgroundColor = Theme.surface2
        layer.cornerRadius = 60
        clipsToBounds = true
        isUserInteractionEnabled = false
        letter.text = String(track.artist.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1)).uppercased()
        letter.font = .systemFont(ofSize: 30, weight: .bold)
        letter.textColor = Theme.text
        letter.textAlignment = .center
        picture.contentMode = .scaleAspectFill
        for part in [letter, picture] as [UIView] {
            part.frame = bounds
            part.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            addSubview(part)
        }
        show()
        NotificationCenter.default.addObserver(self, selector: #selector(arrived(_:)), name: MusicCovers.ready, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    private func show() {
        let image = MusicCovers.image(track)
        picture.image = image
        picture.isHidden = image == nil
        letter.isHidden = image != nil
    }

    @objc private func arrived(_ note: Notification) {
        guard note.object as? String == track.id else { return }
        show()
    }
}
