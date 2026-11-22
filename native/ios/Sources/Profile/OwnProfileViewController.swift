import UIKit

/// «Мой профиль» read-only, as others see it (the reference's ProfileScreen.tsx without «Изм.»): the banner or the
/// light, the pattern, the decorated avatar with the ring of stories, the name in Unbounded with the emoji status
/// (a tap opens the status picker), «в сети», the card, the posts, stories and gifts. Scrolling up, the photo
/// shrinks away and the name settles small in the middle of the top row; a long pull opens the photo and video.
/// «Изменить» opens the editor.
final class OwnProfileViewController: UIViewController, UIScrollViewDelegate {
    private let messenger: Messenger?
    private let scroll = UIScrollView()
    private let content = UIStackView()
    private let hero = ProfileHeroView()
    private let topLayers = ProfileTopLayers()
    private let card = ProfileInfoCard()
    private let postsBlock = ProfilePostsBlock(frame: .zero)
    private let noticeLabel = UILabel()
    private let bar = UIView()
    private let barBackdrop = UIView()
    private let back = UIButton(type: .system)
    private let edit = UIButton(type: .system)
    private let smallName = UILabel()
    private let smallStatus = UILabel()
    private let titleBox = UIStackView()
    private var copied = false
    private var copyTurn = 0
    /// Opens the status picker as soon as the page shows (a tap on the status in Settings).
    var opensStatusPicker = false

    init(messenger: Messenger?) {
        self.messenger = messenger
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    private var me: Person {
        if let messenger, let person = Person(messenger.ownProfile) { return person }
        #if targetEnvironment(simulator)
        return ProfileSamples.me
        #else
        return Person(id: "", username: "", displayName: "", bio: "", birthday: "", avatarColor: 0x5E7BFF, avatarId: "")
        #endif
    }

    private var base: String { return messenger?.server.endpoint ?? "" }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        view.addSubview(topLayers.back)
        scroll.alwaysBounceVertical = true
        scroll.showsVerticalScrollIndicator = false
        scroll.delegate = self
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        content.axis = .vertical
        content.spacing = 17
        content.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(content)
        content.addArrangedSubview(hero)
        hero.avatarHolder.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(avatarTapped)))
        hero.status.accessibilityHint = "Сменить статус рядом с именем"
        hero.onStatus = { [weak self] (y: CGFloat) -> Void in self?.openStatusPicker(anchorY: y) }
        card.onCopy = { [weak self] in self?.copyUsername() }
        content.addArrangedSubview(card)
        content.setCustomSpacing(14 + 17, after: hero)
        content.addArrangedSubview(postsBlock)
        noticeLabel.font = .systemFont(ofSize: 13)
        noticeLabel.textColor = Theme.accent
        noticeLabel.textAlignment = .center
        noticeLabel.numberOfLines = 0
        noticeLabel.isHidden = true
        content.addArrangedSubview(noticeLabel)
        postsBlock.attach(host: self, messenger: messenger, userId: messenger?.userId ?? me.id, own: true, avatar: hero.avatar)

        view.addSubview(topLayers.front)
        barBackdrop.backgroundColor = Theme.bg
        barBackdrop.alpha = 0
        view.addSubview(barBackdrop)
        bar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bar)
        back.setImage(UIImage(systemName: "chevron.left", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold)), for: .normal)
        back.tintColor = Theme.text
        back.accessibilityLabel = "Назад"
        back.addTarget(self, action: #selector(goBack), for: .touchUpInside)
        GlassBacking.put(under: back) // C: the reference's IconButton — a round of clear glass
        var look = UIButton.Configuration.filled()
        look.attributedTitle = AttributedString(NSAttributedString(string: "Изм.", attributes: [.font: UIFont.systemFont(ofSize: 16, weight: .semibold)]))
        look.baseBackgroundColor = Theme.surface2
        look.baseForegroundColor = Theme.text
        look.cornerStyle = .capsule
        look.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 17, bottom: 0, trailing: 17)
        edit.configuration = look
        edit.accessibilityLabel = "Изменить профиль"
        edit.addTarget(self, action: #selector(editPressed), for: .touchUpInside)
        smallName.font = .systemFont(ofSize: 16, weight: .bold)
        smallName.textColor = Theme.text
        smallName.textAlignment = .center
        smallStatus.text = "в сети"
        smallStatus.font = .systemFont(ofSize: 12)
        smallStatus.textColor = Theme.muted
        smallStatus.textAlignment = .center
        titleBox.axis = .vertical
        titleBox.alignment = .center
        titleBox.addArrangedSubview(smallName)
        titleBox.addArrangedSubview(smallStatus)
        titleBox.alpha = 0
        titleBox.isUserInteractionEnabled = false
        for part in [back, edit, titleBox] as [UIView] {
            part.translatesAutoresizingMaskIntoConstraints = false
            bar.addSubview(part)
        }
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            content.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 60 + 8),
            content.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -36),
            content.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 17),
            content.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -17),
            content.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -34),
            bar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
            bar.heightAnchor.constraint(equalToConstant: 52),
            back.leadingAnchor.constraint(equalTo: bar.leadingAnchor),
            back.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            back.widthAnchor.constraint(equalToConstant: 44),
            back.heightAnchor.constraint(equalToConstant: 44),
            edit.trailingAnchor.constraint(equalTo: bar.trailingAnchor),
            edit.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            edit.heightAnchor.constraint(equalToConstant: 44),
            titleBox.centerXAnchor.constraint(equalTo: bar.centerXAnchor),
            titleBox.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            titleBox.leadingAnchor.constraint(greaterThanOrEqualTo: back.trailingAnchor, constant: 10),
            titleBox.trailingAnchor.constraint(lessThanOrEqualTo: edit.leadingAnchor, constant: -10),
        ])
        NotificationCenter.default.addObserver(self, selector: #selector(refresh), name: Messenger.ownProfileChanged, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(refresh), name: PlatinaState.changed, object: nil)
        messenger?.prepareSettingsAvatars()
        messenger?.refreshOwnProfile()
        PlatinaState.shared.refresh()
        refresh()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        topLayers.celebrate(in: view)
        if opensStatusPicker {
            opensStatusPicker = false
            openStatusPicker(anchorY: hero.convert(CGPoint(x: 0, y: hero.bounds.height - 60), to: nil).y)
        }
    }

    @objc private func refresh() {
        guard isViewLoaded else { return }
        let person = me
        topLayers.show(person, base: base)
        let tinted = topLayers.tinted
        hero.show(person, base: base, presenceWords: "в сети", tinted: tinted)
        smallName.text = person.displayName
        edit.configuration?.baseBackgroundColor = tinted ? UIColor(white: 0, alpha: 0.28) : Theme.surface2
        edit.configuration?.baseForegroundColor = tinted ? .white : Theme.text
        card.show(username: person.username, birthday: person.birthday, bio: person.bio, copied: copied)
        postsBlock.setColor(person.avatarColor)
        view.setNeedsLayout()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        layoutTop()
    }

    private func layoutTop() {
        let scrolled = scroll.contentOffset.y + scroll.adjustedContentInset.top
        let heroBottom = hero.frame.maxY
        topLayers.layout(width: view.bounds.width, topInset: view.safeAreaInsets.top, scrolled: scrolled, heroBottom: heroBottom)
        hero.applyScroll(scrolled)
        barBackdrop.frame = CGRect(x: 0, y: 0, width: view.bounds.width, height: view.safeAreaInsets.top + 8 + 52 + 12)
        func fade(_ from: CGFloat, _ to: CGFloat) -> CGFloat { return max(0, min(1, (scrolled - from) / max(1, to - from))) }
        barBackdrop.alpha = fade(heroBottom - 80, heroBottom - 40) * 0.96
        titleBox.alpha = fade(heroBottom - 60, heroBottom - 30)
        titleBox.transform = CGAffineTransform(translationX: 0, y: 8 * (1 - titleBox.alpha))
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) { layoutTop() }

    func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint, targetContentOffset: UnsafeMutablePointer<CGPoint>) {
        if scrollView.contentOffset.y + scrollView.adjustedContentInset.top < -110 { openMedia() }
    }

    @objc private func goBack() { navigationController?.popViewController(animated: true) }

    @objc private func editPressed() {
        guard let messenger else { return }
        navigationController?.pushViewController(ProfileEditViewController(messenger: messenger), animated: true)
    }

    @objc private func avatarTapped() {
        if postsBlock.openStoriesIfAny() { return }
        openMedia()
    }

    private func openMedia() {
        let person = me
        guard !ProfileMediaViewer.items(person).isEmpty, presentedViewController == nil else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        present(ProfileMediaViewer(person: person, base: base), animated: true, completion: nil)
    }

    private func copyUsername() {
        let handle = me.username
        guard !handle.isEmpty else { return }
        UIPasteboard.general.string = "@" + handle
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        copied = true
        copyTurn += 1
        let turn = copyTurn
        refresh()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { [weak self] in
            guard let self, self.copyTurn == turn else { return }
            self.copied = false
            self.refresh()
        }
    }

    private func say(_ words: String) {
        noticeLabel.text = words
        noticeLabel.isHidden = words.isEmpty
        guard !words.isEmpty else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.5) { [weak self] in
            if self?.noticeLabel.text == words { self?.say("") }
        }
    }

    private func openStatusPicker(anchorY: CGFloat) {
        guard presentedViewController == nil else { return }
        let status = PlatinaState.shared.status
        let picker = StatusPickerViewController(anchorY: anchorY, status: status, current: me.look.visibleStatus())
        picker.onPick = { [weak self] (emoji: String?) -> Void in self?.applyStatus(emoji) }
        present(picker, animated: false, completion: nil)
    }

    private func applyStatus(_ emoji: String?) {
        guard let messenger else {
            say(emoji == nil ? "Статус убран." : "Статус обновлён.")
            return
        }
        messenger.changeStatusEmoji(emoji) { [weak self] (result: Result<[String: Any], ServerError>) -> Void in
            switch result {
            case .success: self?.say(emoji == nil ? "Статус убран." : "Статус обновлён.")
            case .failure(let error):
                self?.say(error.words.isEmpty ? "Не удалось изменить статус." : error.words)
                PlatinaState.shared.refresh(force: true)
            }
        }
    }
}
