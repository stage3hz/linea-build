import AVFoundation
import UIKit

/// Music for everyone in a room (the reference's roomMusic.tsx): on a phone only in headphones — from the phone's
/// own loudspeaker the music would go straight back into the microphone and everyone would hear it twice.
/// One person turns it on; what they play (which track, where in it, playing or paused) is told to the others
/// straight over the room's own peer-to-peer channel, and every device plays the track itself from the catalogue.
/// No sound is sent and the server sees nothing. A phone without headphones takes no part: it neither plays nor
/// leads. The wire's rules are the shared core's (`roomMusicIn`, `roomMusicOut`). Main queue only.
final class RoomMusic {
    static let shared = RoomMusic()
    /// Posted on the main queue when what plays for everyone (or who leads it) changed.
    static let changed = Notification.Name("invizent.room-music")

    /// "me" while this phone leads, a connection's id while that person leads, nil when nothing is shared.
    private(set) var host: String?
    /// The track the one who leads plays, as they told it.
    private(set) var track: [String: Any]?
    /// Whether music for everyone may run here: inside a room, with the sound in headphones.
    private(set) var allowed = false
    private var started = false
    private var beat: Timer?
    private var told = ""

    private init() {}

    /// Begins to follow the room this phone is in. Called once (by the shell).
    func start() {
        if started { return }
        started = true
        RoomVoice.shared.onPeerText = { [weak self] (peer: String, text: String) -> Void in self?.heard(peer, text) }
        RoomVoice.shared.onPeerReady = { [weak self] (_: String) -> Void in
            // Somebody's channel opened: they are told at once what plays.
            guard let self, self.host == "me" else { return }
            self.tell()
        }
        // Leaving the room while leading: the others are told while the connections are still open.
        RoomVoice.shared.onLeaving = { [weak self] in
            guard let self, self.host == "me" else { return }
            RoomVoice.shared.sendToPeers(RoomRules.musicOff)
        }
        NotificationCenter.default.addObserver(self, selector: #selector(moved), name: RoomVoice.changed, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(moved), name: AVAudioSession.routeChangeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(playerMoved), name: MusicPlayer.changed, object: nil)
    }

    /// The room, or where the phone's sound goes, changed (the route's notice comes on another queue).
    @objc private func moved() {
        DispatchQueue.main.async { [weak self] in self?.check() }
    }

    private func check() {
        var now = RoomVoice.shared.state != nil && RoomVoice.headphones
        #if targetEnvironment(simulator)
        if RoomVoice.shared.isDemo { now = RoomVoice.shared.state != nil && demoAllowed }
        #endif
        // The one who led left the room without a word (their connection dropped): nothing is shared any more.
        if let host, host != "me", now, RoomVoice.shared.userId(ofPeer: host) == nil {
            self.host = nil
            track = nil
            if MusicPlayer.shared.playing { MusicPlayer.shared.togglePlayback() }
            NotificationCenter.default.post(name: RoomMusic.changed, object: nil)
        }
        if now == allowed { return }
        allowed = now
        if !now { end() }
        NotificationCenter.default.post(name: RoomMusic.changed, object: nil)
    }

    /// Leaving the room, or taking the headphones off: the lead ends for everyone; what was playing along stops.
    private func end() {
        if host == "me" {
            RoomVoice.shared.sendToPeers(RoomRules.musicOff)
        } else if host != nil, MusicPlayer.shared.playing {
            MusicPlayer.shared.togglePlayback()
        }
        host = nil
        track = nil
        beat?.invalidate()
        beat = nil
        told = ""
    }

    // MARK: Listening: follow whoever leads

    private func heard(_ peer: String, _ text: String) {
        guard allowed, let data = Core.view("roomMusicIn", [text]) as? [String: Any] else { return }
        let player = MusicPlayer.shared
        if data["off"] as? Bool == true {
            guard host == peer else { return }
            host = nil
            track = nil
            if player.playing { player.togglePlayback() }
            NotificationCenter.default.post(name: RoomMusic.changed, object: nil)
            return
        }
        guard let wanted = data["track"] as? [String: Any], let id = wanted["id"] as? String, let source = wanted["source"] as? String,
              let place = (data["place"] as? NSNumber)?.doubleValue else { return }
        if host == "me" {
            beat?.invalidate()
            beat = nil
        }
        host = peer
        track = wanted
        if player.current?.id != id {
            let made = MusicTrack(id: id, source: source, sourceId: wanted["sourceId"] as? String, title: wanted["title"] as? String ?? "", artist: wanted["artist"] as? String ?? "",
                                  artworkUrl: nil, duration: (wanted["duration"] as? NSNumber)?.doubleValue ?? 0, genre: nil, mood: nil, sourceUrl: nil, downloadable: false,
                                  fileName: nil, mimeType: nil, fileSize: nil, savedAt: nil)
            // The place is taken at the next word from the one who leads, once the track has loaded here.
            player.play(made)
        } else {
            if abs(player.position - place) > RoomRules.musicDrift { player.seek(place) }
            let playing = data["playing"] as? Bool ?? false
            if player.playing != playing && !player.loading { player.togglePlayback() }
        }
        NotificationCenter.default.post(name: RoomMusic.changed, object: nil)
    }

    // MARK: Leading: tell the others on every change and on a slow beat

    /// «Включить … для всех».
    func lead() {
        guard allowed, let current = MusicPlayer.shared.current, current.source != "local" else { return }
        host = "me"
        track = nil
        told = ""
        tell()
        beat?.invalidate()
        beat = Timer.scheduledTimer(withTimeInterval: RoomRules.musicBeat, repeats: true) { [weak self] (_: Timer) -> Void in self?.tell() }
        NotificationCenter.default.post(name: RoomMusic.changed, object: nil)
    }

    /// «Выключить».
    func stopLeading() {
        guard host == "me" else { return }
        RoomVoice.shared.sendToPeers(RoomRules.musicOff)
        host = nil
        beat?.invalidate()
        beat = nil
        NotificationCenter.default.post(name: RoomMusic.changed, object: nil)
    }

    private func tell() {
        let player = MusicPlayer.shared
        guard host == "me", let current = player.current else { return }
        // A file of the phone's own gives no text: it cannot be played for everyone.
        guard let text = Core.view("roomMusicOut", [current.json, player.position, player.playing]) as? String else { return }
        told = current.id + (player.playing ? "|1" : "|0")
        RoomVoice.shared.sendToPeers(text)
    }

    @objc private func playerMoved() {
        guard host == "me" else {
            if host != nil || allowed { NotificationCenter.default.post(name: RoomMusic.changed, object: nil) }
            return
        }
        let player = MusicPlayer.shared
        let key = (player.current?.id ?? "") + (player.playing ? "|1" : "|0")
        if key != told { tell() }
        NotificationCenter.default.post(name: RoomMusic.changed, object: nil)
    }

    #if targetEnvironment(simulator)
    private var demoAllowed = false

    /// What plays for everyone, without a room's connections (-roomsdemo music).
    func showDemo(host: String, track: [String: Any]) {
        demoAllowed = true
        allowed = true
        self.host = host
        self.track = track
        NotificationCenter.default.post(name: RoomMusic.changed, object: nil)
    }
    #endif
}

/// The line under the people of a room: what plays for everyone, or the button that starts it; on a phone without
/// headphones — why there is no music here.
final class RoomMusicLine: UIControl {
    private let icon = UIImageView()
    private let heading = UILabel()
    private let words = UILabel()
    private let off = UIButton(type: .system)
    private var playingFor = false
    private var canLead = false
    /// The room's members and the people inside, for the name of the one who leads.
    private var members: [Person] = []
    /// How tall the line is now.
    private(set) var tall: CGFloat = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        icon.contentMode = .center
        icon.isUserInteractionEnabled = false
        addSubview(icon)
        heading.font = .systemFont(ofSize: 15.5, weight: .semibold)
        heading.textColor = Theme.text
        addSubview(heading)
        words.textColor = Theme.muted
        addSubview(words)
        off.setTitle("Выключить", for: .normal)
        off.setTitleColor(Theme.text, for: .normal)
        off.titleLabel?.font = .systemFont(ofSize: 13)
        off.layer.cornerRadius = 17
        off.layer.borderWidth = 1
        off.layer.borderColor = Theme.veil(0.18).cgColor
        off.accessibilityLabel = "Выключить музыку для всех"
        off.addTarget(self, action: #selector(offPressed), for: .touchUpInside)
        addSubview(off)
        addTarget(self, action: #selector(pressed), for: .touchUpInside)
        isAccessibilityElement = false
        words.isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { return nil }

    /// `inside`: whether this phone is inside the room on screen.
    func show(inside: Bool, members: [Person]) {
        self.members = members
        let music = RoomMusic.shared
        let player = MusicPlayer.shared
        playingFor = false
        canLead = false
        off.isHidden = true
        heading.isHidden = true
        icon.isHidden = true
        words.accessibilityTraits = .staticText
        guard inside else {
            tall = 0
            isHidden = true
            return
        }
        isHidden = false
        guard music.allowed else {
            words.text = "Музыка для всех — на телефоне только в наушниках"
            words.font = .systemFont(ofSize: 12.5)
            words.textColor = Theme.subtle
            words.textAlignment = .center
            tall = 18
            return setNeedsLayout()
        }
        let leading = music.host == "me"
        var shownName: String? = nil
        if leading { shownName = player.current?.title } else if music.host != nil { shownName = music.track?["title"] as? String }
        if let host = music.host, let shownName {
            playingFor = true
            var by = "ты"
            if !leading {
                let userId = RoomVoice.shared.userId(ofPeer: host)
                by = members.first(where: { (member: Person) -> Bool in member.id == userId }).map { RoomRules.firstName($0) } ?? "кто-то"
            }
            icon.isHidden = false
            icon.image = UIImage(systemName: "music.note", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .regular))
            icon.tintColor = Theme.text
            icon.backgroundColor = Theme.veil(0.08)
            icon.layer.cornerRadius = 13
            icon.clipsToBounds = true
            heading.isHidden = false
            heading.text = shownName
            words.text = "включил \(by) · играет у всех"
            words.font = .systemFont(ofSize: 12.5)
            words.textColor = Theme.muted
            words.textAlignment = .left
            off.isHidden = !leading
            tall = 44
            return setNeedsLayout()
        }
        let current = player.current
        let local = current?.source == "local"
        canLead = current != nil && !local
        icon.isHidden = false
        icon.image = UIImage(systemName: "music.note", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .regular))
        icon.tintColor = Theme.muted
        icon.backgroundColor = .clear
        if local {
            words.text = "Свой файл нельзя включить для всех — выбери трек из каталога"
        } else if let current {
            words.text = "Включить «\(String(current.title.prefix(40)))» для всех"
        } else {
            words.text = "Музыка для всех: включи трек в «Музыке»"
        }
        words.font = .systemFont(ofSize: 13.5)
        words.textColor = Theme.muted
        words.textAlignment = .left
        words.accessibilityTraits = .button
        alpha = canLead ? 1 : 0.55
        tall = 22
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = bounds.width
        if playingFor {
            alpha = 1
            icon.frame = CGRect(x: 0, y: 0, width: 44, height: 44)
            var right = width
            if !off.isHidden {
                let wide = ceil(off.sizeThatFits(CGSize(width: 200, height: 34)).width) + 24
                off.frame = CGRect(x: width - wide, y: 5, width: wide, height: 34)
                right -= wide + 12
            }
            heading.frame = CGRect(x: 56, y: 3, width: max(0, right - 56), height: 20)
            words.frame = CGRect(x: 56, y: 24, width: max(0, right - 56), height: 17)
        } else if icon.isHidden {
            alpha = 1
            words.frame = bounds
        } else {
            let wide = min(width - 26, ceil(words.sizeThatFits(CGSize(width: width - 26, height: 22)).width))
            let left = (width - wide - 26) / 2
            icon.frame = CGRect(x: left, y: 0, width: 20, height: bounds.height)
            words.frame = CGRect(x: left + 26, y: 0, width: wide, height: bounds.height)
        }
    }

    @objc private func pressed() {
        guard canLead, !playingFor else { return }
        RoomMusic.shared.lead()
    }

    @objc private func offPressed() { RoomMusic.shared.stopLeading() }
}
