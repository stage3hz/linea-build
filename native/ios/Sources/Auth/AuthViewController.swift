import UIKit

/// The sign-in screen (`mobile/src/AuthScreen.tsx`), one step at a time:
/// - signing in: the login, the password, the confirmation word — all three go to the server together at the
///   last step, and which of them was wrong is never told;
/// - creating an account: the login, the public profile, the password, the confirmation word, the recovery word;
/// - a forgotten password: the login with the recovery word, the waiting period, the new password.
/// What is typed is kept only in the fields, and the secrets are forgotten on every way out of a flow.
final class AuthViewController: UIViewController {
    private enum Mode {
        case loginName, loginPassword, loginWord
        case registerName, registerProfile, registerPassword, registerConfirmation, registerRecovery
        case recover, waiting, reset
    }

    /// What the server said about the recovery attempts of one login.
    private struct RecoveryFeedback {
        let username: String
        let remaining: Int?
        let lockedUntil: Date?
    }

    private static let loginSteps: [Mode] = [.loginName, .loginPassword, .loginWord]
    private static let registerSteps: [Mode] = [.registerName, .registerProfile, .registerPassword, .registerConfirmation, .registerRecovery]

    private let server: Server
    /// Called with the session's token and the account (`user` of the server's answer) once signed in.
    var onSignedIn: ((String, [String: Any]) -> Void)?

    private var mode = Mode.loginName
    private var shownMode: Mode?
    private var shownBusy = false
    /// The permission to set a new password, while a recovery is under way.
    private var grant: RecoveryGrant?
    /// The server's clock minus this phone's, in milliseconds.
    private var serverOffset: Double = 0
    private var entered = false
    private var pending = false
    private var checking = false
    private var statusPending = false
    private var generation = 0
    private var statusGeneration = 0
    private var lastStatusCheck = Date.distantPast
    private var loginLockUntil: Date?
    private var feedback: RecoveryFeedback?
    private var errorText = ""
    private var noticeText = ""
    /// A made-up request shown for the simulator check: nothing is asked from the server and nothing is kept.
    private var sample = false
    private var ticker: Timer?

    // Nothing scrolls: the column stands still between the top and the keyboard (AuthFit, `arrange`).
    private let column = UIStackView()
    // L: the reference's sign-in (AuthScreen.tsx, App.tsx `ThemeAccess`): the steps live on a glass card (GlassSurface
    // «regular», radius 32, 22 inside), and a glass pill at the top right names the theme on screen and opens the choice.
    private let card = GlassPill(interactive: false)
    private let cardColumn = UIStackView()
    private let themePill = GlassPill(interactive: false)
    private let themeButton = UIButton(type: .custom)
    private let brand = WordmarkView(size: 60) // Effects: «Инвиз» in moving platinum, the reference's Wordmark (Auth/AuthBackdrop.swift)
    private let motto = UILabel()
    private let heading = AppearingTextView() // Effects: the title's words rise in one after another (AppearingText)
    private let hint = UILabel()
    private let switcher = UISegmentedControl(items: ["Войти", "Создать аккаунт"])
    private let progress = UIStackView()
    private var bars: [UIView] = []
    private let progressLabel = UILabel()

    private let nameEntry = AuthEntry(caption: "Логин", placeholder: "Введите логин", secret: false)
    private let loginWarning = AuthNotice(error: false)
    private let displayEntry = AuthEntry(caption: "Имя", placeholder: "Как тебя видят в чатах", secret: false)
    private let handleEntry = AuthEntry(caption: "Публичный @юзернейм", placeholder: "Для поиска, не как логин", secret: false)
    private let profileHelp = AuthViewController.note("По @юзернейму тебя найдут. Логин для входа другой, его не видит никто.")
    private let passwordEntry = AuthEntry(caption: "Пароль", placeholder: "Твой пароль", secret: true)
    private let confirmationEntry = AuthEntry(caption: "Слово подтверждения", placeholder: "Твоё слово для входа", secret: true)
    private let confirmationHelp = AuthViewController.note("")
    private let recoveryEntry = AuthEntry(caption: "Слово восстановления", placeholder: "Отдельное слово для восстановления", secret: true)
    private let recoveryHelp = AuthViewController.note(AuthViewController.wordHelp)
    private let recoveryExtra = AuthViewController.note("")
    private let waitingBox = UIStackView()
    private let clock = UILabel()
    private let clockOwner = AuthViewController.note("")
    private let resetValidity = AuthViewController.note("")
    private let recoveryLock = AuthNotice(error: true)
    private let attemptsNote = AuthViewController.note("")
    private let manualNote = AuthViewController.note("Только ручной ввод. Вставка и автозаполнение отключены.", size: 11, color: Theme.subtle)
    private let notice = AuthNotice(error: false)
    private let failure = AuthNotice(error: true)
    private let loginLock = AuthNotice(error: true)
    private let proceed = ActionButton(label: "Продолжить") // Effects: the button with states (ActionButton)
    private let forgot = UIButton(type: .system)
    private let back = UIButton(type: .system)
    /// While the keyboard is up, the room between the card's parts and «Продолжить», so the button stands at the
    /// card's bottom right above the keyboard.
    private let spacer = UIView()

    // The two arrangements (AuthFit): without the keyboard and with it.
    private var columnTop: NSLayoutConstraint?
    private var cardFill: NSLayoutConstraint?
    private var cardPadTop: NSLayoutConstraint?
    private var cardPadBottom: NSLayoutConstraint?
    /// Which of the parts that may leave for want of room the step has (the rest show by their own `isHidden`).
    private var wanted: [ObjectIdentifier: Bool] = [:]
    /// How much of the screen the keyboard covers now, and the height of the last keyboard that was up.
    private var keyboardOverlap: CGFloat = 0
    private var keyboardHeight: CGFloat = 0
    /// The compact arrangement stays while a request is under way (the field is closed then and the keyboard leaves
    /// for a moment): nothing moves before the answer.
    private var holdCompact = false
    private var arrangedFor = ""

    private static let wordHelp = "От 4 до 64 русских или английских букв, без пробелов. Регистр не важен; «е» и «ё» различаются."

    private static func note(_ words: String, size: CGFloat = 12, color: UIColor = Theme.muted) -> UILabel {
        let label = UILabel()
        label.text = words
        label.font = .systemFont(ofSize: size)
        label.textColor = color
        label.numberOfLines = 0
        return label
    }

    init(server: Server) {
        self.server = server
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    // MARK: The screen

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        build()
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanging(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        restore()
        #if targetEnvironment(simulator)
        simulatorMode()
        #endif
        render()
        if mode == .waiting { checkRecovery() }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        ticker?.invalidate()
        ticker = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            self?.tick()
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        focus()
        #if targetEnvironment(simulator)
        // `-authfocus 2`: the keyboard goes to the second field of the step (the shots with the keyboard up).
        let place = UserDefaults.standard.integer(forKey: "authfocus")
        if place > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                self?.focusField(place)
            }
        }
        #endif
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let key = "\(view.bounds.width)x\(view.bounds.height)/\(view.safeAreaInsets.top)/\(view.safeAreaInsets.bottom)"
        if key != arrangedFor {
            arrangedFor = key
            arrange()
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // The screen is leaving: answers still on their way are not for it any more, and nothing typed stays.
        ticker?.invalidate()
        ticker = nil
        generation += 1
        statusGeneration += 1
        holdCompact = false
        pending = false
        statusPending = false
        checking = false
        entered = false
        clearSecrets()
    }

    private func build() {
        motto.text = "Твоя линия связи."
        motto.font = .systemFont(ofSize: 17)
        motto.textColor = Theme.muted
        heading.accessibilityTraits = .header
        hint.font = .systemFont(ofSize: 15)
        hint.textColor = Theme.muted
        hint.numberOfLines = 0

        switcher.selectedSegmentTintColor = Theme.veil(0.14)
        switcher.backgroundColor = Theme.surface2
        switcher.setTitleTextAttributes([.foregroundColor: Theme.muted, .font: UIFont.systemFont(ofSize: 13, weight: .medium)], for: .normal)
        switcher.setTitleTextAttributes([.foregroundColor: Theme.text, .font: UIFont.systemFont(ofSize: 13, weight: .bold)], for: .selected)
        switcher.addTarget(self, action: #selector(switched), for: .valueChanged)

        let barRow = UIStackView()
        barRow.axis = .horizontal
        barRow.spacing = 8
        barRow.distribution = .fillEqually
        for _ in 0..<AuthViewController.registerSteps.count {
            let bar = UIView()
            bar.layer.cornerRadius = 2
            bar.heightAnchor.constraint(equalToConstant: 4).isActive = true
            bars.append(bar)
            barRow.addArrangedSubview(bar)
        }
        progressLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        progressLabel.textColor = Theme.muted
        progressLabel.setContentHuggingPriority(.required, for: .horizontal)
        progressLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        progress.axis = .horizontal
        progress.alignment = .center
        progress.spacing = 13
        progress.addArrangedSubview(barRow)
        progress.addArrangedSubview(progressLabel)
        progress.isAccessibilityElement = true

        loginWarning.words = "Это твой логин для входа. Его видишь только ты, и сменить его потом нельзя. Публичный @юзернейм задашь на следующем шаге — он будет другим. Запомни логин или запиши в надёжное место."
        nameEntry.limit = 24
        displayEntry.limit = 50
        displayEntry.field.autocapitalizationType = .words
        displayEntry.field.returnKeyType = .next
        handleEntry.limit = 25
        handleEntry.noSpaces = true
        for entry in [nameEntry, handleEntry, passwordEntry, confirmationEntry, recoveryEntry] {
            entry.field.returnKeyType = .go
            entry.onReturn = { [weak self] in
                self?.submit()
            }
        }
        nameEntry.onReturn = { [weak self] in
            guard let self else { return }
            if self.mode == .recover { _ = self.recoveryEntry.field.becomeFirstResponder() } else { self.submit() }
        }
        // Return: to the next field of the step (the fields of a step stand still), on the last field — «Продолжить».
        displayEntry.onReturn = { [weak self] in
            _ = self?.handleEntry.field.becomeFirstResponder()
        }

        clock.font = .monospacedDigitSystemFont(ofSize: 43, weight: .bold)
        clock.textColor = Theme.text
        clock.textAlignment = .center
        clock.accessibilityLabel = "Осталось до проверки сервером"
        clockOwner.textAlignment = .center
        let waitingAbout = AuthViewController.note("На устройствах с открытым аккаунтом этот запрос можно отменить. Если запрос сохранён, можно закрыть приложение и вернуться. Готовность проверяется на сервере каждые 10 секунд.")
        let waitingLeave = AuthViewController.note("Переход ко входу удалит запрос с этого устройства. Продолжить его здесь после этого не получится.")
        waitingBox.axis = .vertical
        waitingBox.spacing = 10
        for part in [clock, clockOwner, waitingAbout, waitingLeave] as [UIView] { waitingBox.addArrangedSubview(part) }
        waitingBox.setCustomSpacing(18, after: clockOwner)

        proceed.accessibilityIdentifier = "auth-submit"
        proceed.addTarget(self, action: #selector(submit), for: .touchUpInside)
        forgot.setTitle("Забыл пароль?", for: .normal)
        forgot.tintColor = Theme.text
        forgot.titleLabel?.font = .systemFont(ofSize: 14, weight: .bold)
        forgot.addTarget(self, action: #selector(forgotPassword), for: .touchUpInside)
        back.tintColor = Theme.muted
        back.titleLabel?.font = .systemFont(ofSize: 15)
        back.addTarget(self, action: #selector(goBack), for: .touchUpInside)
        forgot.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        back.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true

        column.axis = .vertical
        column.spacing = 12
        column.translatesAutoresizingMaskIntoConstraints = false
        for part in [brand, motto, heading, hint] as [UIView] { column.addArrangedSubview(part) }
        // L: everything from the switch down is on the glass card (`gap: 18`, 22 inside).
        cardColumn.axis = .vertical
        cardColumn.spacing = 12
        cardColumn.translatesAutoresizingMaskIntoConstraints = false
        spacer.isHidden = true
        spacer.isUserInteractionEnabled = false
        spacer.setContentHuggingPriority(UILayoutPriority(1), for: .vertical)
        spacer.setContentCompressionResistancePriority(UILayoutPriority(1), for: .vertical)
        let parts: [UIView] = [switcher, progress, nameEntry, loginWarning, displayEntry, handleEntry, profileHelp,
                               passwordEntry, confirmationEntry, confirmationHelp, recoveryEntry, recoveryHelp, recoveryExtra, waitingBox, resetValidity,
                               recoveryLock, attemptsNote, manualNote, notice, failure, loginLock, spacer, proceed, forgot, back]
        for part in parts { cardColumn.addArrangedSubview(part) }
        card.shape(radius: 32)
        card.contentView.addSubview(cardColumn)
        let padTop = cardColumn.topAnchor.constraint(equalTo: card.contentView.topAnchor, constant: AuthFit.pad)
        let padBottom = cardColumn.bottomAnchor.constraint(equalTo: card.contentView.bottomAnchor, constant: -AuthFit.pad)
        cardPadTop = padTop
        cardPadBottom = padBottom
        NSLayoutConstraint.activate([
            padTop,
            padBottom,
            cardColumn.leadingAnchor.constraint(equalTo: card.contentView.leadingAnchor, constant: 22),
            cardColumn.trailingAnchor.constraint(equalTo: card.contentView.trailingAnchor, constant: -22),
        ])
        column.addArrangedSubview(card)
        column.setCustomSpacing(4, after: brand)
        column.setCustomSpacing(28, after: motto)
        column.setCustomSpacing(8, after: heading)
        column.setCustomSpacing(24, after: hint)
        cardColumn.setCustomSpacing(18, after: switcher)
        cardColumn.setCustomSpacing(18, after: progress)
        cardColumn.setCustomSpacing(0, after: spacer)
        cardColumn.setCustomSpacing(AuthFit.linkGap, after: proceed)
        cardColumn.setCustomSpacing(0, after: forgot)

        // L: the theme pill (GlassSurface «clear», radius 24, 44 tall, 14 inside): the moon / sun / half circle (17),
        // the theme's name (12, semibold), a small chevron (12, quiet); 20 from the right, 7 under the safe area.
        themePill.effect = TabGlass.effect(clear: true, interactive: false, dark: Theme.dark)
        themePill.shape(radius: 24)
        themePill.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(themePill)
        themeButton.translatesAutoresizingMaskIntoConstraints = false
        themeButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        themeButton.setContentHuggingPriority(.required, for: .horizontal)
        themeButton.addTarget(self, action: #selector(themePressed), for: .touchUpInside)
        themePill.contentView.addSubview(themeButton)
        paintThemePill()

        view.addSubview(column)
        // Without the keyboard the page starts under the theme pill's row (58) with room above it (`arrange`); with
        // the keyboard the title stands at the top and the card reaches down to the keyboard.
        let top = column.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: AuthFit.pillRow + AuthFit.topGap)
        let fill = card.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -AuthFit.compactEdge)
        // Below the parts' own resistance: on a screen too small for them the card would rather pass the keyboard.
        fill.priority = UILayoutPriority(740)
        columnTop = top
        cardFill = fill
        // A touch beside the card puts the keyboard away (there is nothing to scroll it away with).
        let away = UITapGestureRecognizer(target: self, action: #selector(putKeyboardAway))
        away.cancelsTouchesInView = false
        away.delegate = self
        view.addGestureRecognizer(away)
        NSLayoutConstraint.activate([
            // L: the row of the theme pill (at least 58 tall) stands above the page; the page starts 64 under it.
            themePill.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 7),
            themePill.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
            themePill.heightAnchor.constraint(equalToConstant: 44),
            // The pill takes the width of its words (it cut «Графит» to «Гра…т»).
            themePill.widthAnchor.constraint(greaterThanOrEqualToConstant: 128),
            themeButton.topAnchor.constraint(equalTo: themePill.contentView.topAnchor),
            themeButton.bottomAnchor.constraint(equalTo: themePill.contentView.bottomAnchor),
            themeButton.leadingAnchor.constraint(equalTo: themePill.contentView.leadingAnchor),
            themeButton.trailingAnchor.constraint(equalTo: themePill.contentView.trailingAnchor),
            top,
            column.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 22),
            column.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -22),
        ])
        view.bringSubviewToFront(themePill)
    }

    // MARK: L: the theme pill

    /// The pill names the theme on screen (the night theme at night), as the «Оформление» row in the settings does.
    private func paintThemePill() {
        let state = ThemeStore.nightState()
        let shown = state["shown"] as? String ?? "black"
        let night = state["night"] as? Bool ?? false
        let symbol = ThemeStore.mode == "system" && !night ? "circle.lefthalf.filled" : (shown == "light" ? "sun.max" : "moon")
        let words = NSMutableAttributedString(string: ThemeStore.themeName(shown), attributes: [.font: UIFont.systemFont(ofSize: 12, weight: .semibold), .foregroundColor: Theme.text])
        // The small chevron after the name (`chevron-down`, 12, quiet), 8 after it.
        let chevron = NSTextAttachment()
        chevron.image = UIImage(systemName: "chevron.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 9, weight: .semibold))?.withTintColor(Theme.muted, renderingMode: .alwaysOriginal)
        words.append(NSAttributedString(string: "  "))
        words.append(NSAttributedString(attachment: chevron))
        themeButton.setImage(UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .regular)), for: .normal)
        themeButton.tintColor = Theme.text
        themeButton.setAttributedTitle(words, for: .normal)
        themeButton.contentEdgeInsets = UIEdgeInsets(top: 0, left: 14, bottom: 0, right: 22)
        themeButton.titleEdgeInsets = UIEdgeInsets(top: 0, left: 8, bottom: 0, right: -8)
        themeButton.accessibilityLabel = "Оформление: " + ThemeStore.themeName(shown)
    }

    /// «Оформление»: the four built-in themes (the palettes belong to Platina, which needs an account). The choice
    /// follows the settings' theme cards (`settingsThemeTap`); the screen is drawn again in the new look.
    @objc private func themePressed() {
        let state = ThemeStore.nightState()
        let shown = state["shown"] as? String ?? "black"
        let sheet = UIAlertController(title: "Оформление", message: nil, preferredStyle: .actionSheet)
        for item in ThemeStore.list("appearances") {
            guard let id = item["value"] as? String, let label = item["label"] as? String else { continue }
            sheet.addAction(UIAlertAction(title: id == shown ? label + " ✓" : label, style: .default, handler: { [weak self] (_: UIAlertAction) -> Void in
                self?.chooseTheme(id)
            }))
        }
        sheet.addAction(UIAlertAction(title: "Отмена", style: .cancel, handler: nil))
        sheet.popoverPresentationController?.sourceView = themePill
        present(sheet, animated: true)
    }

    private func chooseTheme(_ id: String) {
        let state = ThemeStore.nightState()
        let night = state["night"] as? Bool ?? false
        let known = state["known"] as? Bool ?? true
        let auto = state["auto"] as? Bool ?? false
        guard let plan = Core.view("settingsThemeTap", [id, night]) as? [String: Any] else { return }
        if plan["nightOff"] as? Bool == true {
            DevicePreferences.set(["nightForced": false, "nightForcedAt": known ? auto : true])
        }
        if let dark = plan["darkTheme"] as? String { ThemeStore.darkTheme = dark }
        if let mode = plan["mode"] as? String {
            if DevicePreferences.word("nightMode") == nil {
                DevicePreferences.set(["nightMode": ThemeStore.mode == "system" ? "system" : "off"])
            }
            ThemeStore.mode = mode
        }
        guard ThemeStore.refresh(), let window = view.window else { return }
        // The sign-in screen is not part of the app's shell: it is made again in the new colours.
        let fresh = AuthViewController(server: server)
        fresh.onSignedIn = onSignedIn
        window.rootViewController = fresh
    }

    /// A recovery request kept from an earlier launch brings the screen back to its waiting period.
    private func restore() {
        do {
            guard let saved = try RecoveryStore.read(base: server.base) else { return }
            nameEntry.value = saved.username
            grant = saved.grant
            serverOffset = saved.grant.serverMs - nowMs
            mode = .waiting
            noticeText = "Запрос восстановления найден. Проверяем его состояние на сервере."
        } catch {
            noticeText = "Не удалось прочитать сохранённый запрос восстановления. Можно начать новый запрос."
        }
    }

    #if targetEnvironment(simulator)
    /// `-authmode register` / `recover` open the first step of that flow, `profile` the second step of creating an
    /// account (two fields); `waiting` / `reset` show those two screens with a made-up request (no server is asked,
    /// nothing is kept).
    private func simulatorMode() {
        guard let wanted = UserDefaults.standard.string(forKey: "authmode") else { return }
        if wanted == "register" || wanted == "recover" || wanted == "profile" {
            grant = nil
            noticeText = ""
            nameEntry.value = ""
            if wanted == "register" {
                mode = .registerName
            } else if wanted == "profile" {
                mode = .registerProfile
            } else {
                mode = .recover
            }
            return
        }
        guard wanted == "waiting" || wanted == "reset" else { return }
        let stamp = ISO8601DateFormatter()
        stamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let now = Date()
        let ready = wanted == "waiting" ? now.addingTimeInterval(9 * 60 + 41) : now.addingTimeInterval(-60)
        let fields: [String: Any] = ["resetToken": "sample", "requestId": "sample", "readyAt": stamp.string(from: ready),
                                     "expiresAt": stamp.string(from: ready.addingTimeInterval(20 * 60)), "serverTime": stamp.string(from: now)]
        guard let made = RecoveryGrant(fields) else { return }
        sample = true
        grant = made
        serverOffset = 0
        nameEntry.value = "nativetester"
        noticeText = wanted == "reset" ? "Сервер разрешил сменить пароль. Оба секретных слова останутся прежними." : ""
        mode = wanted == "waiting" ? .waiting : .reset
    }

    /// `-authfocus N`: the keyboard goes to the N-th field of the step (1 — the first).
    private func focusField(_ place: Int) {
        guard view.window != nil, !pending, !entered else { return }
        let fields: [AuthEntry] = [nameEntry, displayEntry, handleEntry, passwordEntry, confirmationEntry, recoveryEntry].filter { (entry: AuthEntry) -> Bool in
            return !entry.isHidden && entry.isEnabled
        }
        guard place >= 1, place <= fields.count else { return }
        _ = fields[place - 1].field.becomeFirstResponder()
    }
    #endif

    // MARK: Nothing scrolls: the two arrangements

    private func want(_ part: UIView, _ shown: Bool) {
        wanted[ObjectIdentifier(part)] = shown
    }

    private func wants(_ part: UIView) -> Bool {
        if let shown = wanted[ObjectIdentifier(part)] { return shown }
        return !part.isHidden
    }

    private var compactWanted: Bool {
        return keyboardOverlap > AuthFit.keyboard || (holdCompact && keyboardHeight > 0)
    }

    private var editing: Bool {
        let fields: [AuthEntry] = [nameEntry, displayEntry, handleEntry, passwordEntry, confirmationEntry, recoveryEntry]
        return fields.contains(where: { (entry: AuthEntry) -> Bool in entry.field.isFirstResponder })
    }

    /// The height a part takes at this width, whether it shows now or not.
    private static func measure(_ part: UIView, _ width: CGFloat) -> CGFloat {
        if let label = part as? UILabel {
            if (label.text ?? "").isEmpty { return 0 }
            return ceil(label.sizeThatFits(CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)).height)
        }
        let size = part.systemLayoutSizeFitting(CGSize(width: width, height: UIView.layoutFittingCompressedSize.height),
                                                withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
        return ceil(size.height)
    }

    private static func key(_ part: UIView) -> Int {
        return ObjectIdentifier(part).hashValue
    }

    private func showPart(_ part: UIView, _ shown: Bool) {
        if part.isHidden == shown { part.isHidden = !shown }
        part.alpha = shown ? 1 : 0
    }

    /// Puts the screen in the arrangement it is in now (AuthFit): without the keyboard — the wordmark, the motto, the
    /// title and the description, the card; with it — the title at the top and the card down to the keyboard with
    /// «Продолжить» at its bottom. Called inside the keyboard's own animation, it moves the screen together with it.
    private func arrange() {
        guard isViewLoaded, view.bounds.width > 0 else { return }
        let compact = compactWanted
        let safe = view.safeAreaInsets
        let columnWidth = view.bounds.width - 44
        let inner = columnWidth - 44
        let helps: [UIView] = [confirmationHelp, recoveryHelp, profileHelp, resetValidity, loginWarning]
        let chrome: [UIView] = [progress, switcher]
        let extras: [UIView] = [recoveryExtra, back, forgot, manualNote]
        let links: [UIView] = [forgot, back]
        let messages: [UIView] = [recoveryLock, attemptsNote, notice, failure, loginLock]
        let mayLeave: [UIView] = helps + chrome + extras
        func isIn(_ list: [UIView], _ part: UIView) -> Bool {
            return list.contains(where: { (other: UIView) -> Bool in other === part })
        }
        var heights: [ObjectIdentifier: CGFloat] = [:]
        for part in cardColumn.arrangedSubviews where part !== spacer && wants(part) {
            heights[ObjectIdentifier(part)] = AuthViewController.measure(part, inner)
        }
        func height(_ part: UIView) -> CGFloat {
            return heights[ObjectIdentifier(part)] ?? 0
        }
        func cost(_ part: UIView, _ tight: Bool) -> CGFloat {
            if isIn(links, part) { return height(part) + AuthFit.linkGap }
            if isIn(chrome, part) { return height(part) + (tight ? AuthFit.compactChromeGap : AuthFit.chromeGap) }
            return height(part) + AuthFit.gap
        }
        func parts(_ list: [UIView], _ tight: Bool) -> [AuthFit.Part] {
            var made: [AuthFit.Part] = []
            for part in list where wants(part) {
                made.append(AuthFit.Part(id: AuthViewController.key(part), cost: cost(part, tight)))
            }
            return made
        }
        var core = height(proceed)
        var messageCost: CGFloat = 0
        for part in cardColumn.arrangedSubviews {
            if part === spacer || part === proceed || !wants(part) || isIn(mayLeave, part) { continue }
            if isIn(messages, part) { messageCost += cost(part, false) } else { core += cost(part, false) }
        }
        let brandHeight = AuthViewController.measure(brand, columnWidth)
        let mottoHeight = AuthViewController.measure(motto, columnWidth)
        let headingHeight = AuthViewController.measure(heading, columnWidth)
        let hintHeight = AuthViewController.measure(hint, columnWidth)

        // Without the keyboard: from under the theme pill's row to above the bottom edge.
        let small: CGFloat = keyboardOverlap > AuthFit.keyboard ? 0 : keyboardOverlap
        let fullRoom = view.bounds.height - max(small, safe.bottom) - AuthFit.edge - (safe.top + AuthFit.pillRow)
        let plan = AuthFit.full(room: fullRoom, brand: brandHeight, motto: mottoHeight, heading: headingHeight, hint: hintHeight,
                                card: 2 * AuthFit.pad + core + messageCost,
                                helps: parts(helps, false), chrome: parts(chrome, false), extras: parts(extras, false))
        // With the keyboard: the card's inside from under the title to above the keyboard.
        let plateTop = safe.top + AuthFit.compactTop + headingHeight + AuthFit.compactHeadingGap
        let plateBottom = view.bounds.height - keyboardHeight - AuthFit.compactEdge
        let kept = AuthFit.compact(room: plateBottom - plateTop - 2 * AuthFit.compactPad, core: core, messages: messageCost,
                                   helps: parts(helps, true), chrome: parts(chrome, true), extras: parts(extras, true))

        let keep: Set<Int> = compact ? kept : plan.kept
        for part in mayLeave {
            showPart(part, wants(part) && keep.contains(AuthViewController.key(part)))
        }
        showPart(brand, !compact && plan.brand)
        showPart(motto, !compact && plan.motto)
        showPart(hint, !compact && plan.hint)
        if spacer.isHidden == compact { spacer.isHidden = !compact }
        themePill.alpha = compact ? 0 : 1
        themePill.isUserInteractionEnabled = !compact
        column.setCustomSpacing(AuthFit.afterBrand(plan.motto), after: brand)
        column.setCustomSpacing(AuthFit.afterMotto, after: motto)
        column.setCustomSpacing(compact ? AuthFit.compactHeadingGap : AuthFit.afterHeading(plan.hint), after: heading)
        column.setCustomSpacing(AuthFit.afterHint, after: hint)
        let chromeGap: CGFloat = compact ? AuthFit.compactChromeGap : AuthFit.chromeGap
        cardColumn.setCustomSpacing(chromeGap, after: switcher)
        cardColumn.setCustomSpacing(chromeGap, after: progress)
        let pad: CGFloat = compact ? AuthFit.compactPad : AuthFit.pad
        cardPadTop?.constant = pad
        cardPadBottom?.constant = -pad
        columnTop?.constant = compact ? AuthFit.compactTop : AuthFit.pillRow + plan.gap
        cardFill?.constant = -(keyboardHeight + AuthFit.compactEdge)
        cardFill?.isActive = compact
    }

    /// The keyboard comes, goes or changes: the screen moves once, in the keyboard's own time and curve.
    @objc private func keyboardChanging(_ note: Notification) {
        guard isViewLoaded, let info = note.userInfo, let value = info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue else { return }
        let end = view.convert(value.cgRectValue, from: nil)
        let overlap = max(0, view.bounds.maxY - end.minY)
        keyboardOverlap = overlap
        if overlap > AuthFit.keyboard {
            keyboardHeight = overlap
            holdCompact = false
        }
        let duration = (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
        let curve = (info[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?.uintValue ?? 7
        relayout(duration: duration, options: UIView.AnimationOptions(rawValue: curve << 16))
    }

    private func relayout(duration: TimeInterval, options: UIView.AnimationOptions) {
        guard view.window != nil, duration > 0 else {
            arrange()
            return
        }
        view.layoutIfNeeded()
        UIView.animate(withDuration: duration, delay: 0, options: options.union([.beginFromCurrentState, .allowUserInteraction]), animations: { [weak self] () -> Void in
            guard let screen = self else { return }
            screen.arrange()
            screen.view.layoutIfNeeded()
        }, completion: nil)
    }

    /// Lets the compact arrangement go once a request has ended: right away when no field has the keyboard (the
    /// waiting period), or when the keyboard does not come back to the field.
    private func releaseHold() {
        guard holdCompact else { return }
        if !editing {
            holdCompact = false
            relayout(duration: 0.3, options: .curveEaseInOut)
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            guard let screen = self, screen.holdCompact, !screen.pending, !screen.entered else { return }
            screen.holdCompact = false
            screen.relayout(duration: 0.3, options: .curveEaseInOut)
        }
    }

    @objc private func putKeyboardAway() {
        view.endEditing(true)
    }

    // MARK: What is on the screen

    private var nowMs: Double { return Date().timeIntervalSince1970 * 1000 }
    private var login: String { return AuthRules.name(nameEntry.value) }
    private var isLogin: Bool { return AuthViewController.loginSteps.contains(mode) }
    private var isRegister: Bool { return AuthViewController.registerSteps.contains(mode) }

    /// Five wrong sign-ins close the entrance for five minutes (the server enforces it; this shows the countdown).
    private var loginLocked: Bool {
        guard isLogin, let until = loginLockUntil else { return false }
        return until > Date()
    }

    private var loginLockText: String {
        let left = Int(max(0, (loginLockUntil ?? Date()).timeIntervalSinceNow.rounded(.up)))
        return "\(left / 60):" + String(format: "%02d", left % 60)
    }

    /// Until when the recovery of the login now typed is closed; nil when it is not.
    private var recoveryLockedUntil: Date? {
        guard let known = feedback, known.username == login, let until = known.lockedUntil, until > Date() else { return nil }
        return until
    }

    private func headingWords(_ mode: Mode) -> String {
        switch mode {
        case .loginName, .registerName: return "Логин"
        case .loginPassword, .registerPassword: return "Пароль"
        case .loginWord, .registerConfirmation: return "Слово подтверждения"
        case .registerProfile: return "Профиль"
        case .registerRecovery: return "Слово восстановления"
        case .recover: return "Восстановление"
        case .waiting: return "Ожидание"
        case .reset: return "Новый пароль"
        }
    }

    private func hintWords(_ mode: Mode) -> String {
        switch mode {
        case .loginName: return "Вход без почты и номера телефона. Данные проверим вместе на последнем шаге."
        case .loginPassword: return "Введи пароль вручную. Следом понадобится слово подтверждения."
        case .loginWord: return "Введи слово подтверждения, которое выбрал при регистрации."
        case .registerName: return "Всё вводится один раз. Перед тем как идти дальше, проверь, что нет опечатки."
        case .registerProfile: return "Это видят другие: имя и @юзернейм для поиска. Логин остаётся тайным."
        case .registerPassword: return "От 10 до 128 символов. Длинная фраза тоже подходит."
        case .registerConfirmation: return "Это слово нужно при входе после пароля. Оно должно отличаться от логина и пароля."
        case .registerRecovery: return "Это отдельное слово понадобится, если забудешь пароль. Оно должно отличаться от первого."
        case .recover: return "Введи логин и слово восстановления. После подтверждения нужно будет подождать 10 минут."
        case .waiting: return "Слово восстановления подтверждено. Через 10 минут сервер разрешит задать новый пароль."
        case .reset: return "Введи новый пароль и проверь его глазами. Слово подтверждения и слово восстановления сохранятся."
        }
    }

    private func buttonWords(_ mode: Mode) -> String {
        switch mode {
        case .registerRecovery: return "Создать аккаунт"
        case .loginWord: return "Войти в Инвиз"
        case .recover: return "Подтвердить слово"
        case .waiting: return "Проверить статус"
        case .reset: return "Сохранить новый пароль"
        default: return "Продолжить"
        }
    }

    /// Puts everything the screen knows on it.
    private func render() {
        guard isViewLoaded else { return }
        let changed = shownMode != mode
        shownMode = mode
        let busy = pending || entered
        // A field that was closed for the time of a request gets the keyboard back.
        let freed = shownBusy && !busy
        shownBusy = busy
        heading.show(headingWords(mode), font: .systemFont(ofSize: 22, weight: .semibold), color: Theme.text) // Effects
        hint.text = hintWords(mode)

        want(switcher, isLogin || isRegister)
        switcher.selectedSegmentIndex = isRegister ? 1 : 0
        switcher.isEnabled = !busy

        var step = 0
        var stepCount = 0
        if let at = AuthViewController.registerSteps.firstIndex(of: mode) {
            step = at + 1
            stepCount = AuthViewController.registerSteps.count
        } else if let at = AuthViewController.loginSteps.firstIndex(of: mode) {
            step = at + 1
            stepCount = AuthViewController.loginSteps.count
        }
        want(progress, step != 0)
        for (index, bar) in bars.enumerated() {
            bar.isHidden = index >= stepCount
            bar.backgroundColor = index < step ? Theme.accent : Theme.veil(0.12)
        }
        progressLabel.text = "\(step) / \(stepCount)"
        progress.accessibilityLabel = "Шаг \(step) из \(stepCount)"

        nameEntry.isHidden = !(mode == .loginName || mode == .registerName || mode == .recover)
        want(loginWarning, mode == .registerName)
        displayEntry.isHidden = mode != .registerProfile
        handleEntry.isHidden = mode != .registerProfile
        want(profileHelp, mode == .registerProfile)
        passwordEntry.isHidden = !(mode == .loginPassword || mode == .registerPassword || mode == .reset)
        let asksConfirmation = mode == .loginWord || mode == .registerConfirmation
        confirmationEntry.isHidden = !asksConfirmation
        want(confirmationHelp, asksConfirmation)
        if mode == .registerConfirmation {
            confirmationHelp.text = AuthViewController.wordHelp
        } else {
            confirmationHelp.text = "Если в старом аккаунте слово ещё не настроено, оставь поле пустым. После входа сможешь добавить его в безопасности."
        }
        let asksRecovery = mode == .registerRecovery || mode == .recover
        recoveryEntry.isHidden = !asksRecovery
        want(recoveryHelp, asksRecovery)
        want(recoveryExtra, asksRecovery)
        if mode == .registerRecovery {
            recoveryExtra.text = "Запомни оба слова и храни их отдельно. В приложении их нельзя будет посмотреть повторно."
        } else {
            recoveryExtra.text = "Всего 3 неверные попытки, затем восстановление блокируется на 24 часа. Вход с паролем и словом подтверждения остаётся доступен."
        }
        waitingBox.isHidden = !(mode == .waiting && grant != nil)
        clockOwner.text = "Запрос для логина \(login)"
        want(manualNote, mode != .waiting)
        notice.words = noticeText
        failure.words = errorText

        want(forgot, isLogin)
        forgot.isEnabled = !busy
        want(back, !(mode == .loginName || mode == .registerName))
        back.isEnabled = !busy
        let leavesRecovery = mode == .recover || mode == .waiting || mode == .reset
        back.setTitle(leavesRecovery ? "‹ Вернуться ко входу" : "‹ Назад", for: .normal)
        for entry in [nameEntry, displayEntry, handleEntry, passwordEntry, confirmationEntry] { entry.isEnabled = !busy }
        // The key of the keyboard: «далее» from the login to the recovery word, «готово» everywhere else.
        let nameReturn: UIReturnKeyType = mode == .recover ? .next : .go
        if nameEntry.field.returnKeyType != nameReturn {
            nameEntry.field.returnKeyType = nameReturn
            if nameEntry.field.isFirstResponder { nameEntry.field.reloadInputViews() }
        }

        if changed {
            passwordEntry.set(caption: mode == .reset ? "Новый пароль" : "Пароль", placeholder: mode == .loginPassword ? "Твой пароль" : "От 10 символов — можно фразу")
            // A secret being created is typed once, so it is shown while typed; the one being entered is hidden.
            setShown(passwordEntry, mode != .loginPassword)
            setShown(confirmationEntry, mode == .registerConfirmation)
            setShown(recoveryEntry, mode == .registerRecovery)
        }
        renderTime()
        if changed {
            focus()
            UIAccessibility.post(notification: .screenChanged, argument: heading)
        } else if freed {
            focus()
        }
        if !busy { releaseHold() }
    }

    private func setShown(_ entry: AuthEntry, _ shown: Bool) {
        entry.shownWhenEmpty = shown
        if entry.value.isEmpty { entry.reveal(shown) }
    }

    /// The parts that change as time passes: the countdowns and what they close.
    private func renderTime() {
        let busy = pending || entered
        if let held = grant, mode == .waiting {
            let left = AuthRules.countdown(until: held.readyMs, now: nowMs + serverOffset)
            clock.text = left
            clock.accessibilityValue = left
        }
        if let held = grant, mode == .reset {
            let left = AuthRules.countdown(until: held.expiresMs, now: nowMs + serverOffset)
            resetValidity.text = "Подтверждение действительно ещё \(left)."
            want(resetValidity, true)
        } else {
            want(resetValidity, false)
        }

        var recoveryClosed = false
        var attempts = ""
        var lockWords = ""
        if mode == .recover {
            if let until = recoveryLockedUntil {
                recoveryClosed = true
                let left = AuthRules.countdown(until: until.timeIntervalSince1970 * 1000, now: nowMs)
                lockWords = "Восстановление временно заблокировано. Повторная попытка через \(left). Ограничение действует на сервере."
            } else if let known = feedback, known.username == login, let remaining = known.remaining, remaining > 0 {
                attempts = "По ответу сервера осталось попыток: \(remaining) из 3."
            }
        }
        if recoveryLock.words != lockWords { recoveryLock.words = lockWords }
        attemptsNote.text = attempts
        attemptsNote.isHidden = attempts.isEmpty
        recoveryEntry.isEnabled = !busy && !recoveryClosed

        let closed = loginLocked
        let lockText = closed ? "Вход временно закрыт. Попробуй через \(loginLockText)." : ""
        if loginLock.words != lockText { loginLock.words = lockText }

        var words = buttonWords(mode)
        if closed { words = "Подожди \(loginLockText)" } else if entered { words = "Готово" }
        let loading = !entered && (pending || (checking && mode == .waiting))
        // Effects: «Готово» rolls in with a check once signed in; a spinner while the request goes.
        if entered { words = buttonWords(mode) }
        if proceed.label != words { proceed.label = words }
        if proceed.loading != loading { proceed.loading = loading }
        if proceed.success != entered { proceed.success = entered }
        proceed.isEnabled = !(recoveryClosed || closed)
        arrange()
    }

    /// The keyboard goes to the first field of the step; the waiting period has none.
    private func focus() {
        guard view.window != nil, !pending, !entered else { return }
        for entry in [nameEntry, displayEntry, passwordEntry, confirmationEntry, recoveryEntry] {
            if !entry.isHidden && entry.isEnabled {
                _ = entry.field.becomeFirstResponder()
                return
            }
        }
        view.endEditing(true)
    }

    private func tick() {
        if mode == .reset, !pending, !sample, let held = grant, held.expiresMs <= nowMs + serverOffset {
            clearSecrets()
            grant = nil
            mode = .recover
            errorText = "Время для смены пароля закончилось. Начни восстановление заново."
            RecoveryStore.clear(base: server.base, resetToken: held.resetToken)
            render()
            return
        }
        // The server is asked every ten seconds whether the waiting period is over.
        if mode == .waiting, Date().timeIntervalSince(lastStatusCheck) >= 10 { checkRecovery() }
        renderTime()
    }

    // MARK: Steps

    private func current(_ id: Int) -> Bool { return generation == id }

    private func clearSecrets() {
        passwordEntry.value = ""
        confirmationEntry.value = ""
        recoveryEntry.value = ""
    }

    /// Starts a request to the server; nil when one is already under way.
    private func begin() -> Int? {
        if pending || entered { return nil }
        pending = true
        // The field is closed for the time of the request and the keyboard may leave: the arrangement stays.
        holdCompact = compactWanted
        errorText = ""
        noticeText = ""
        generation += 1
        render()
        return generation
    }

    private func fail(_ words: String) {
        errorText = words
        proceed.signalError() // Effects: «Ошибка» with a shake for 1.4 s
        render()
    }

    private func go(_ to: Mode) {
        errorText = ""
        noticeText = ""
        mode = to
        render()
    }

    private func usernameCheck() -> Bool {
        if AuthRules.validName(nameEntry.value) { return true }
        fail(AuthRules.nameError)
        return false
    }

    @objc private func switched() {
        let register = switcher.selectedSegmentIndex == 1
        if pending || entered || register == isRegister {
            render()
            return
        }
        generation += 1
        clearSecrets()
        nameEntry.value = ""
        go(register ? .registerName : .loginName)
    }

    @objc private func forgotPassword() {
        guard !pending, !entered else { return }
        generation += 1
        clearSecrets()
        go(.recover)
    }

    @objc private func goBack() {
        guard !pending, !entered else { return }
        if mode == .waiting || mode == .reset {
            leaveRecovery()
            return
        }
        generation += 1
        errorText = ""
        noticeText = ""
        switch mode {
        case .loginWord:
            confirmationEntry.value = ""
            passwordEntry.value = ""
            mode = .loginPassword
        case .loginPassword:
            clearSecrets()
            mode = .loginName
        case .registerRecovery:
            recoveryEntry.value = ""
            mode = .registerConfirmation
        case .registerConfirmation:
            confirmationEntry.value = ""
            mode = .registerPassword
        case .registerPassword:
            clearSecrets()
            mode = .registerProfile
        case .registerProfile:
            mode = .registerName
        default:
            clearSecrets()
            nameEntry.value = ""
            mode = .loginName
        }
        render()
    }

    @objc private func submit() {
        guard !pending, !entered else { return }
        if isRegister {
            registerNext()
            return
        }
        switch mode {
        case .loginName:
            if loginLocked { return }
            if usernameCheck() { go(.loginPassword) }
        case .loginPassword:
            if AuthRules.passwordEntered(passwordEntry.value) { go(.loginWord) } else { fail(AuthRules.passwordEntryError) }
        case .loginWord:
            signIn()
        case .recover:
            verifyRecovery()
        case .waiting:
            checkRecovery()
        case .reset:
            resetPassword()
        default:
            break
        }
    }

    // MARK: Signing in and creating an account

    /// The session of an answer nobody waits for any more is closed on the server at once.
    private static func discard(_ result: Result<Any, ServerError>, base: String) {
        guard case .success(let answer) = result, let token = (answer as? [String: Any])?["token"] as? String, !token.isEmpty else { return }
        Server(base: base, token: token).op("logout", []) { _ in }
    }

    /// Takes the session of a sign-in answer; false when the answer is not one.
    private func accept(_ answer: Any) -> Bool {
        guard let session = answer as? [String: Any], let token = session["token"] as? String, !token.isEmpty,
              let user = session["user"] as? [String: Any] else { return false }
        clearSecrets()
        // The button shows «Готово» for a moment before the chats open.
        entered = true
        pending = false
        view.endEditing(true)
        render()
        let base = server.base
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.55) { [weak self] in
            if let screen = self, screen.entered {
                screen.onSignedIn?(token, user)
            } else {
                Server(base: base, token: token).op("logout", []) { _ in }
            }
        }
        return true
    }

    private func signIn() {
        guard usernameCheck() else { return }
        if !AuthRules.passwordEntered(passwordEntry.value) {
            fail(AuthRules.passwordEntryError)
            return
        }
        // An empty word is sent as it is: only the server decides whether an older account may enter without one.
        let args: [Any] = [login, passwordEntry.value, AuthRules.word(confirmationEntry.value)]
        guard let id = begin() else { return }
        let base = server.base
        server.op("login", args) { [weak self] result in
            DispatchQueue.main.async {
                guard let screen = self, screen.current(id) else {
                    AuthViewController.discard(result, base: base)
                    return
                }
                switch result {
                case .success(let answer):
                    if screen.accept(answer) { return }
                    screen.clearSecrets()
                    screen.mode = .loginName
                    screen.errorText = "Не удалось выполнить запрос. Попробуй ещё раз."
                case .failure(let error):
                    if case .refused(let message, let status, let code, let details) = error, code == "LOGIN_FAILED" || code == "LOGIN_LOCKED" || status == 401 {
                        // Wrong login, password or word: back to the first step (which of the three was wrong is
                        // never told), with how many tries are left; after five the server closes the entrance.
                        screen.clearSecrets()
                        screen.mode = .loginName
                        let wait = (details["retryAfterSeconds"] as? NSNumber)?.doubleValue ?? 0
                        if code == "LOGIN_LOCKED", wait > 0 {
                            screen.loginLockUntil = Date().addingTimeInterval(wait)
                            screen.errorText = "Слишком много неверных попыток. Вход снова откроется через 5 минут."
                        } else if let left = (details["attemptsLeft"] as? NSNumber)?.intValue {
                            screen.errorText = "Неверный логин, пароль или слово подтверждения. Осталось попыток: \(left)."
                        } else {
                            screen.errorText = message
                        }
                    } else {
                        screen.confirmationEntry.value = ""
                        screen.errorText = error.words
                    }
                }
                screen.pending = false
                screen.render()
            }
        }
    }

    private func registerNext() {
        switch mode {
        case .registerName:
            if usernameCheck() { go(.registerProfile) }
            return
        case .registerProfile:
            let shownName = displayEntry.value.trimmingCharacters(in: .whitespacesAndNewlines)
            let publicName = AuthRules.handle(handleEntry.value)
            if shownName.isEmpty || shownName.unicodeScalars.count > 50 {
                fail("Имя: от 1 до 50 символов.")
            } else if !AuthRules.validName(publicName) {
                fail("@юзернейм: 3–24 символа — латинские буквы, цифры и знак _.")
            } else if publicName == login {
                fail("@юзернейм должен отличаться от логина: логин никто не должен видеть.")
            } else {
                go(.registerPassword)
            }
            return
        case .registerPassword:
            let invalid = AuthRules.newPasswordError(passwordEntry.value)
            if invalid.isEmpty { go(.registerConfirmation) } else { fail(invalid) }
            return
        case .registerConfirmation:
            let invalid = AuthRules.wordError(confirmationEntry.value, password: passwordEntry.value, login: login)
            if invalid.isEmpty { go(.registerRecovery) } else { fail(invalid) }
            return
        default:
            break
        }
        let invalid = AuthRules.wordError(recoveryEntry.value, password: passwordEntry.value, login: login, otherWord: confirmationEntry.value)
        if !invalid.isEmpty {
            fail(invalid)
            return
        }
        let args: [Any] = [login, passwordEntry.value, displayEntry.value.trimmingCharacters(in: .whitespacesAndNewlines),
                           AuthRules.word(confirmationEntry.value), AuthRules.word(recoveryEntry.value), AuthRules.handle(handleEntry.value)]
        guard let id = begin() else { return }
        let base = server.base
        server.op("register", args) { [weak self] result in
            DispatchQueue.main.async {
                guard let screen = self, screen.current(id) else {
                    AuthViewController.discard(result, base: base)
                    return
                }
                switch result {
                case .success(let answer):
                    if screen.accept(answer) { return }
                    screen.errorText = "Не удалось создать аккаунт."
                case .failure(let error):
                    let message = error.words
                    // A taken @username is fixed on the profile step, not by typing every secret again; a taken
                    // login — on the first step, with the password and the words kept. There is no early «is it
                    // free» question on purpose: the login is secret and must not be probed.
                    if message.contains("@юзернейм") {
                        screen.mode = .registerProfile
                    } else if message.contains("логин уже занят") {
                        screen.mode = .registerName
                    }
                    screen.errorText = message
                }
                screen.pending = false
                screen.render()
            }
        }
    }

    // MARK: A forgotten password

    private func verifyRecovery() {
        if recoveryLockedUntil != nil { return }
        guard usernameCheck() else { return }
        let invalid = AuthRules.wordError(recoveryEntry.value)
        if !invalid.isEmpty {
            fail(invalid)
            return
        }
        let name = login
        let args: [Any] = [name, AuthRules.word(recoveryEntry.value)]
        guard let id = begin() else { return }
        let base = server.base
        server.op("verifyRecovery", args) { [weak self] result in
            DispatchQueue.main.async {
                guard let screen = self, screen.current(id) else { return }
                screen.pending = false
                switch result {
                case .success(let answer):
                    if let made = RecoveryGrant(answer) {
                        screen.clearSecrets()
                        screen.grant = made
                        screen.serverOffset = made.serverMs - screen.nowMs
                        screen.feedback = nil
                        do {
                            try RecoveryStore.save(base: base, username: name, grant: made)
                        } catch {
                            screen.noticeText = "Не удалось сохранить запрос на устройстве. Оставь этот экран открытым до окончания ожидания."
                        }
                        screen.mode = .waiting
                    } else {
                        screen.recoveryEntry.value = ""
                        screen.errorText = "Сервер вернул некорректное подтверждение. Попробуй ещё раз."
                    }
                case .failure(let error):
                    screen.recoveryEntry.value = ""
                    screen.errorText = error.words
                    if case .refused(_, _, _, let details) = error {
                        var remaining: Int?
                        if let number = details["attemptsRemaining"] as? NSNumber { remaining = max(0, min(3, number.intValue)) }
                        var seconds: Double?
                        if let number = details["retryAfterSeconds"] as? NSNumber { seconds = max(0, number.doubleValue) }
                        if remaining != nil || seconds != nil {
                            var until: Date?
                            if let wait = seconds, wait > 0 { until = Date().addingTimeInterval(wait) }
                            screen.feedback = RecoveryFeedback(username: name, remaining: remaining, lockedUntil: until)
                        }
                    }
                }
                screen.render()
                if screen.mode == .waiting { screen.checkRecovery() }
            }
        }
    }

    /// Asks the server whether the waiting period is over.
    private func checkRecovery() {
        guard let held = grant, !statusPending, !pending, !entered, mode == .waiting, !sample else { return }
        let life = generation
        statusGeneration += 1
        let asked = statusGeneration
        statusPending = true
        checking = true
        lastStatusCheck = Date()
        renderTime()
        let base = server.base
        server.op("recoveryStatus", [held.resetToken]) { [weak self] result in
            DispatchQueue.main.async {
                guard let screen = self else { return }
                if asked == screen.statusGeneration {
                    screen.statusPending = false
                    screen.checking = false
                }
                guard screen.current(life), screen.grant?.resetToken == held.resetToken, screen.mode == .waiting else {
                    screen.renderTime()
                    return
                }
                switch result {
                case .success(let answer):
                    if let status = answer as? [String: Any], let requestId = status["requestId"] as? String, requestId == held.requestId,
                       let state = status["status"] as? String, state == "ready" || state == "waiting",
                       let readyAt = status["readyAt"] as? String, RecoveryGrant.ms(readyAt) != nil,
                       let expiresAt = status["expiresAt"] as? String, RecoveryGrant.ms(expiresAt) != nil,
                       let serverTime = status["serverTime"] as? String, RecoveryGrant.ms(serverTime) != nil {
                        var updated = held
                        updated.readyAt = readyAt
                        updated.expiresAt = expiresAt
                        updated.serverTime = serverTime
                        screen.grant = updated
                        screen.serverOffset = updated.serverMs - screen.nowMs
                        screen.errorText = ""
                        if state == "ready" {
                            screen.noticeText = "Сервер разрешил сменить пароль. Оба секретных слова останутся прежними."
                            screen.mode = .reset
                        }
                    } else {
                        screen.errorText = "Не удалось проверить состояние запроса."
                    }
                case .failure(let error):
                    if case .refused(_, let status, _, _) = error, status == 401 || status == 410 {
                        RecoveryStore.clear(base: base, resetToken: held.resetToken)
                        screen.clearSecrets()
                        screen.grant = nil
                        screen.mode = .recover
                        screen.noticeText = "Запрос отменён, уже использован или его срок закончился. Можно начать восстановление заново."
                        screen.errorText = ""
                    } else {
                        screen.errorText = error.words
                    }
                }
                screen.render()
            }
        }
    }

    private func resetPassword() {
        guard let held = grant else {
            clearSecrets()
            go(.recover)
            return
        }
        let invalid = AuthRules.newPasswordError(passwordEntry.value)
        if !invalid.isEmpty {
            fail(invalid)
            return
        }
        if sample { return }
        let args: [Any] = [held.resetToken, passwordEntry.value]
        guard let id = begin() else { return }
        let base = server.base
        server.op("resetPassword", args) { [weak self] result in
            DispatchQueue.main.async {
                // The request is used up whoever is still looking: it is not kept any longer.
                if case .success = result { RecoveryStore.clear(base: base, resetToken: held.resetToken) }
                guard let screen = self, screen.current(id) else { return }
                screen.pending = false
                switch result {
                case .success:
                    screen.clearSecrets()
                    screen.grant = nil
                    screen.feedback = nil
                    screen.nameEntry.value = ""
                    screen.mode = .loginName
                    screen.noticeText = "Пароль изменён. Все устройства вышли из аккаунта. Войди с новым паролем и прежним словом подтверждения."
                case .failure(let error):
                    if case .refused(_, let status, let code, _) = error {
                        if code == "RECOVERY_WAIT" {
                            screen.clearSecrets()
                            screen.mode = .waiting
                        }
                        if status == 401 || status == 410 {
                            RecoveryStore.clear(base: base, resetToken: held.resetToken)
                            screen.clearSecrets()
                            screen.grant = nil
                            screen.mode = .recover
                        }
                    }
                    screen.errorText = error.words
                }
                screen.render()
                if screen.mode == .waiting { screen.checkRecovery() }
            }
        }
    }

    /// Back to signing in: the request is removed from this device and cannot be continued here.
    private func leaveRecovery() {
        guard !pending, !entered else { return }
        if !sample { RecoveryStore.clear(base: server.base, resetToken: grant?.resetToken) }
        sample = false
        generation += 1
        statusGeneration += 1
        statusPending = false
        checking = false
        clearSecrets()
        grant = nil
        nameEntry.value = ""
        go(.loginName)
    }
}

extension AuthViewController: UIGestureRecognizerDelegate {
    /// Only a touch beside the card and the theme pill puts the keyboard away.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        let inCard = card.bounds.contains(touch.location(in: card))
        let inPill = themePill.alpha > 0.01 && themePill.bounds.contains(touch.location(in: themePill))
        return !inCard && !inPill
    }
}
