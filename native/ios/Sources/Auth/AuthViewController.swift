import UIKit

/// Signing in: the login, then the password, then the confirmation word — one field at a time. All three go to
/// the server together at the last step; which of them was wrong is never told.
final class AuthViewController: UIViewController, UITextFieldDelegate {
    private enum Step: Int { case name, password, word }

    private let server: Server
    /// Called with the session's token and the account (`user` of the server's answer) once signed in.
    var onSignedIn: ((String, [String: Any]) -> Void)?

    private var step = Step.name
    private var login = "", password = "", word = ""
    private var busy = false
    private var lockedUntil: Date?

    private let brand = UILabel(), motto = UILabel(), heading = UILabel(), hint = UILabel(), failure = UILabel()
    private let field = UITextField()
    private let plate = UIView()
    private let next = UIButton(type: .system)
    private let back = UIButton(type: .system)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let column = UIStackView()

    init(server: Server) {
        self.server = server
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bg
        brand.text = "Инвиз"
        brand.font = .systemFont(ofSize: 40, weight: .bold)
        brand.textColor = Theme.text
        motto.text = "Твоя линия связи."
        motto.font = .systemFont(ofSize: 17)
        motto.textColor = Theme.muted
        heading.font = .systemFont(ofSize: 22, weight: .semibold)
        heading.textColor = Theme.text
        hint.font = .systemFont(ofSize: 15)
        hint.textColor = Theme.muted
        hint.numberOfLines = 0
        failure.font = .systemFont(ofSize: 15)
        failure.textColor = Theme.danger
        failure.numberOfLines = 0
        failure.accessibilityTraits = .staticText

        plate.backgroundColor = Theme.surface2
        plate.layer.cornerRadius = 16
        plate.layer.cornerCurve = .continuous
        field.font = .systemFont(ofSize: 17)
        field.textColor = Theme.text
        field.tintColor = Theme.text
        field.keyboardAppearance = .dark
        field.autocorrectionType = .no
        field.autocapitalizationType = .none
        field.spellCheckingType = .no
        field.smartQuotesType = .no
        field.smartDashesType = .no
        field.delegate = self
        field.translatesAutoresizingMaskIntoConstraints = false
        plate.addSubview(field)

        var look = UIButton.Configuration.filled()
        look.baseBackgroundColor = Theme.accent
        look.baseForegroundColor = Theme.onAccent
        look.cornerStyle = .capsule
        look.contentInsets = NSDirectionalEdgeInsets(top: 15, leading: 20, bottom: 15, trailing: 20)
        next.configuration = look
        next.addTarget(self, action: #selector(goOn), for: .touchUpInside)
        back.setTitle("Назад", for: .normal)
        back.tintColor = Theme.muted
        back.titleLabel?.font = .systemFont(ofSize: 16)
        back.addTarget(self, action: #selector(goBack), for: .touchUpInside)
        spinner.color = Theme.muted
        spinner.hidesWhenStopped = true

        column.axis = .vertical
        column.spacing = 10
        column.translatesAutoresizingMaskIntoConstraints = false
        for part in [brand, motto, heading, hint, plate, failure, next, back, spinner] as [UIView] { column.addArrangedSubview(part) }
        column.setCustomSpacing(4, after: brand)
        column.setCustomSpacing(40, after: motto)
        column.setCustomSpacing(18, after: hint)
        column.setCustomSpacing(18, after: failure)
        view.addSubview(column)
        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            column.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            column.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 56),
            plate.heightAnchor.constraint(equalToConstant: 54),
            field.leadingAnchor.constraint(equalTo: plate.leadingAnchor, constant: 16),
            field.trailingAnchor.constraint(equalTo: plate.trailingAnchor, constant: -16),
            field.topAnchor.constraint(equalTo: plate.topAnchor),
            field.bottomAnchor.constraint(equalTo: plate.bottomAnchor),
        ])
        show(.name)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        field.becomeFirstResponder()
    }

    private func show(_ next: Step, error: String = "") {
        step = next
        failure.text = error
        failure.isHidden = error.isEmpty
        back.isHidden = next == .name
        field.text = ""
        switch next {
        case .name:
            heading.text = "Логин"
            hint.text = "Вход без почты и номера телефона. Данные проверим вместе на последнем шаге."
            field.attributedPlaceholder = NSAttributedString(string: "Введите логин", attributes: [.foregroundColor: Theme.subtle])
            field.isSecureTextEntry = false
            field.textContentType = .username
            field.text = login
            field.returnKeyType = .next
        case .password:
            heading.text = "Пароль"
            hint.text = "Введи пароль вручную. Следом понадобится слово подтверждения."
            field.attributedPlaceholder = NSAttributedString(string: "Пароль", attributes: [.foregroundColor: Theme.subtle])
            field.isSecureTextEntry = true
            field.textContentType = .password
            field.returnKeyType = .next
        case .word:
            heading.text = "Слово подтверждения"
            hint.text = "Введи слово подтверждения, которое выбрал при регистрации."
            field.attributedPlaceholder = NSAttributedString(string: "Твоё слово для входа", attributes: [.foregroundColor: Theme.subtle])
            field.isSecureTextEntry = true
            field.textContentType = .oneTimeCode
            field.textContentType = nil
            field.returnKeyType = .go
        }
        self.next.configuration?.title = next == .word ? "Войти в Инвиз" : "Продолжить"
        field.reloadInputViews()
        UIAccessibility.post(notification: .screenChanged, argument: heading)
    }

    private func forgetSecrets() { password = ""; word = "" }

    @objc private func goBack() {
        guard !busy else { return }
        switch step {
        case .name: break
        case .password: forgetSecrets(); show(.name)
        case .word: forgetSecrets(); show(.password)
        }
    }

    @objc private func goOn() {
        guard !busy else { return }
        let typed = field.text ?? ""
        switch step {
        case .name:
            if let until = lockedUntil, until > Date() { return show(.name, error: "Слишком много неверных попыток. Вход снова откроется через 5 минут.") }
            login = typed.trimmingCharacters(in: .whitespacesAndNewlines)
            guard login.range(of: "^[A-Za-z0-9_]{3,24}$", options: .regularExpression) != nil else { return show(.name, error: "Логин: 3–24 символа — латинские буквы, цифры и знак _.") }
            show(.password)
        case .password:
            guard !typed.isEmpty, typed.count <= 128 else { return show(.password, error: "Введи свой пароль. Максимум — 128 символов.") }
            password = typed
            show(.word)
        case .word:
            // An empty word is sent as it is: only the server decides whether an older account may enter without one.
            word = typed.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping.lowercased()
            signIn()
        }
    }

    private func signIn() {
        var body: [String: Any] = ["username": login, "password": password, "confirmationWord": word]
        for (key, value) in Account.deviceFields { body[key] = value }
        guard let json = Core.text(body) else { return }
        busy = true
        spinner.startAnimating()
        next.isEnabled = false
        server.send("POST", "/auth/login", body: json) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                self.busy = false
                self.spinner.stopAnimating()
                self.next.isEnabled = true
                switch result {
                case .success(let answer):
                    guard let session = answer as? [String: Any], let token = session["token"] as? String, !token.isEmpty, let user = session["user"] as? [String: Any] else {
                        self.forgetSecrets()
                        return self.show(.name, error: "Не удалось выполнить запрос. Попробуй ещё раз.")
                    }
                    self.forgetSecrets()
                    self.field.text = ""
                    self.onSignedIn?(token, user)
                case .failure(let error):
                    // Wrong login, password or word: back to the first step, with how many tries are left.
                    self.forgetSecrets()
                    if case .refused(let message, let status, let code, let details) = error, code == "LOGIN_FAILED" || code == "LOGIN_LOCKED" || status == 401 {
                        if code == "LOGIN_LOCKED", let wait = details["retryAfterSeconds"] as? Double {
                            self.lockedUntil = Date().addingTimeInterval(wait)
                            return self.show(.name, error: "Слишком много неверных попыток. Вход снова откроется через 5 минут.")
                        }
                        if let left = details["attemptsLeft"] as? Int { return self.show(.name, error: "Неверный логин, пароль или слово подтверждения. Осталось попыток: \(left).") }
                        return self.show(.name, error: message)
                    }
                    self.show(.name, error: error.words)
                }
            }
        }
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        goOn()
        return false
    }
}
