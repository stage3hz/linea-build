import AVFoundation
import AVKit
import UIKit

// Звонок › «Звук»: which microphone and which output the call uses (the reference's calls/CallAudioPanel.tsx and
// the route functions of its modules/linea-call). By default the system routes the call (connected headphones take
// both); here the person can change that for this call. The microphone is chosen on its own (the phone's own while
// the sound stays in Bluetooth headphones); the output: «Громкий динамик» here, any other device in the system's list.

/// One microphone or output as AVAudioSession names it (the reference's `AudioPort`).
struct CallAudioPort: Equatable {
    let id: String
    let name: String
    let kind: String

    init(_ port: AVAudioSessionPortDescription) {
        id = port.uid
        name = port.portName
        kind = port.portType.rawValue
    }

    /// The reference's `portLabel` (audioRouteModel.ts).
    var label: String {
        switch kind {
        case "MicrophoneBuiltIn": return "Микрофон телефона"
        case "Receiver": return "Телефон"
        case "Speaker": return "Громкий динамик"
        case "MicrophoneWired", "Headphones", "HeadsetMic":
            let plain = ["headphones", "headset microphone", "наушники"].contains(name.lowercased())
            return !name.isEmpty && !plain ? name : "Проводные наушники"
        default: return name.isEmpty ? "Устройство" : name
        }
    }

    /// The reference's `portHint`: what kind of device it is.
    var hint: String {
        if kind.hasPrefix("Bluetooth") { return "Bluetooth" }
        if kind == "USBAudio" { return "USB" }
        if kind == "CarAudio" { return "Автомобиль" }
        if kind == "MicrophoneWired" || kind == "Headphones" || kind == "HeadsetMic" { return "Провод" }
        return ""
    }
}

/// What the person chose for this call's sound (LineCallModule.swift `CallAudio` of the reference). Main queue.
enum CallAudioChoice {
    /// The microphone chosen (a port uid), or nil for the system's choice. Kept until the call ends.
    static var chosen: String?
    /// "system" (as iOS routes it), "receiver" (the phone itself) or "device" (the headphones `outputDevice`).
    /// The loudspeaker is not here: it is the call screen's own switch.
    static var output = "system"
    static var outputDevice: String?

    /// The microphones to offer: each once, the phone's own first (`microphoneChoices`).
    static var microphones: [CallAudioPort] {
        var seen = Set<String>()
        var result: [CallAudioPort] = []
        for port in AVAudioSession.sharedInstance().availableInputs ?? [] where !port.uid.isEmpty && !seen.contains(port.uid) {
            seen.insert(port.uid)
            result.append(CallAudioPort(port))
        }
        let own = result.filter { $0.kind == "MicrophoneBuiltIn" }
        return own + result.filter { $0.kind != "MicrophoneBuiltIn" }
    }

    /// The headphones and other devices the call can sound in, besides the phone and its speaker (`outputDevices`).
    static var devices: [CallAudioPort] { return microphones.filter { $0.kind != "MicrophoneBuiltIn" } }

    static var input: CallAudioPort? { return AVAudioSession.sharedInstance().currentRoute.inputs.first.map { CallAudioPort($0) } }
    static var current: CallAudioPort? { return AVAudioSession.sharedInstance().currentRoute.outputs.first.map { CallAudioPort($0) } }

    private static func port(_ uid: String) -> AVAudioSessionPortDescription? {
        return (AVAudioSession.sharedInstance().availableInputs ?? []).first(where: { $0.uid == uid })
    }

    /// The microphone iOS should prefer for what was chosen, or nil to leave it to the system. iOS routes a call by
    /// its microphone: a headset's own microphone sends the sound to that headset too; the phone's microphone leaves
    /// the sound in Bluetooth headphones (over A2DP) or, with Bluetooth not allowed, in the phone.
    private static func wantedInput() -> AVAudioSessionPortDescription? {
        let session = AVAudioSession.sharedInstance()
        if let uid = chosen, let own = port(uid) { return own }
        if output == "device", let uid = outputDevice, let device = port(uid) { return device }
        if output == "receiver" { return (session.availableInputs ?? []).first(where: { $0.portType == .builtInMic }) }
        return nil
    }

    @discardableResult
    private static func applyInput() -> Bool {
        let session = AVAudioSession.sharedInstance()
        let wanted = wantedInput()
        if wanted == nil && chosen == nil && output == "system" { return (try? session.setPreferredInput(nil)) != nil }
        guard let input = wanted else { return false }
        if session.currentRoute.inputs.first?.uid == input.uid { return true }
        return (try? session.setPreferredInput(input)) != nil
    }

    /// nil: back to the system's choice. False when the microphone is not available (any more).
    @discardableResult
    static func setInput(_ uid: String?) -> Bool {
        if let uid = uid {
            guard port(uid) != nil else { return false }
            chosen = uid
        } else {
            chosen = nil
        }
        return applyInput()
    }

    /// "system", "receiver" or "device" (with the headphones' uid). The phone itself is reached by not allowing
    /// Bluetooth for the call; everything else allows it.
    @discardableResult
    static func setOutput(_ kind: String, _ uid: String?) -> Bool {
        let session = AVAudioSession.sharedInstance()
        let receiver = kind == "receiver"
        if kind == "device" {
            guard let uid = uid, port(uid) != nil else { return false }
            output = "device"
            outputDevice = uid
        } else {
            output = receiver ? "receiver" : "system"
            outputDevice = nil
        }
        let options: AVAudioSession.CategoryOptions = receiver ? [] : [.allowBluetooth, .allowBluetoothA2DP]
        do {
            try session.setCategory(.playAndRecord, mode: session.mode, options: options)
            try session.overrideOutputAudioPort(.none)
        } catch {
            return false
        }
        return applyInput()
    }

    /// A call has ended: the next one starts on the system's own microphone and output again (`resetCallAudio`).
    static func reset() {
        guard chosen != nil || output != "system" else { return }
        chosen = nil
        output = "system"
        outputDevice = nil
        try? AVAudioSession.sharedInstance().setPreferredInput(nil)
    }

    /// The system's own list of outputs (the phone, the speaker, AirPods, a car…): the only way iOS lets an app offer
    /// them all. The picker is put in the window out of sight and its button is pressed for the person.
    static func showOutputPicker(in window: UIWindow?) {
        guard let window = window else { return }
        let picker = AVRoutePickerView(frame: CGRect(x: -10, y: -10, width: 1, height: 1))
        picker.alpha = 0.01
        window.addSubview(picker)
        for view in picker.subviews {
            if let button = view as? UIButton { button.sendActions(for: .touchUpInside) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { picker.removeFromSuperview() }
    }
}

/// The panel itself, drawn inside the call screen (not a window of its own): a dark card at the bottom over a dim.
final class CallAudioPanelView: UIView {
    var onClose: (() -> Void)?
    var onSpeaker: (() -> Void)?
    var speakerOn = false {
        didSet { if speakerOn != oldValue { rebuild() } }
    }

    private let backdrop = UIButton(type: .custom)
    private let card = UIView()
    private let header = UILabel()
    private let closeButton = UIButton(type: .custom)
    private let scroll = UIScrollView()
    private let stack = UIStackView()
    private var timer: Timer?
    private var shownKey = ""

    override init(frame: CGRect) {
        super.init(frame: frame)
        backdrop.backgroundColor = UIColor(white: 0, alpha: 0.45)
        backdrop.accessibilityLabel = "Закрыть"
        backdrop.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        addSubview(backdrop)
        card.backgroundColor = UIColor(red: 28 / 255, green: 30 / 255, blue: 38 / 255, alpha: 0.97)
        card.layer.cornerRadius = 26
        card.layer.cornerCurve = .continuous
        card.clipsToBounds = true
        addSubview(card)
        header.text = "Звук"
        header.font = .systemFont(ofSize: 18, weight: .bold)
        header.textColor = .white
        header.accessibilityTraits = .header
        card.addSubview(header)
        closeButton.setImage(IonIcon.image("close", size: 22), for: .normal)
        closeButton.tintColor = .white
        closeButton.accessibilityLabel = "Закрыть"
        closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        card.addSubview(closeButton)
        scroll.bounces = false
        scroll.showsVerticalScrollIndicator = true
        card.addSubview(scroll)
        stack.axis = .vertical
        stack.spacing = 0
        scroll.addSubview(stack)
        accessibilityViewIsModal = true
        NotificationCenter.default.addObserver(self, selector: #selector(routeChanged), name: AVAudioSession.routeChangeNotification, object: nil)
        // A change of microphone takes a moment to show in the route.
        timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] (_: Timer) -> Void in self?.rebuild() }
        rebuild()
    }

    required init?(coder: NSCoder) { return nil }

    deinit {
        timer?.invalidate()
        NotificationCenter.default.removeObserver(self)
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    @objc private func routeChanged() {
        DispatchQueue.main.async { [weak self] in self?.rebuild() }
    }

    @objc private func closeTapped() { onClose?() }

    override func accessibilityPerformEscape() -> Bool {
        onClose?()
        return true
    }

    // MARK: Rows

    private enum Entry {
        case title(String)
        case now(String)
        case row(icon: String, label: String, hint: String, selected: Bool?, action: () -> Void)
    }

    private func entries() -> [Entry] {
        let choice = CallAudioChoice.output
        var list: [Entry] = [.title("Динамики")]
        if let current = CallAudioChoice.current { list.append(.now("Сейчас: " + current.label)) }
        list.append(.row(icon: "phone-portrait-outline", label: "Как в системе", hint: "", selected: !speakerOn && choice == "system", action: { [weak self] in self?.chooseOutput("system", nil) }))
        list.append(.row(icon: "call", label: "Телефон", hint: "", selected: !speakerOn && choice == "receiver", action: { [weak self] in self?.chooseOutput("receiver", nil) }))
        list.append(.row(icon: "volume-high", label: "Громкий динамик", hint: "", selected: speakerOn, action: { [weak self] in self?.chooseOutput("speaker", nil) }))
        for port in CallAudioChoice.devices {
            let on = !speakerOn && choice == "device" && CallAudioChoice.outputDevice == port.id
            list.append(.row(icon: "headset-outline", label: port.label, hint: port.hint, selected: on, action: { [weak self] in self?.chooseOutput("device", port.id) }))
        }
        list.append(.row(icon: "list-outline", label: "Список системы…", hint: "Если устройства нет выше (колонка, AirPlay)", selected: nil, action: { [weak self] in CallAudioChoice.showOutputPicker(in: self?.window) }))
        list.append(.title("Микрофон"))
        let input = CallAudioChoice.input
        let chosen = CallAudioChoice.chosen
        list.append(.row(icon: "mic-outline", label: "Как в системе", hint: chosen == nil && input != nil ? "Сейчас: " + (input?.label ?? "") : "", selected: chosen == nil, action: { [weak self] in self?.chooseInput(nil) }))
        for port in CallAudioChoice.microphones {
            list.append(.row(icon: "mic", label: port.label, hint: port.hint, selected: chosen == port.id, action: { [weak self] in self?.chooseInput(port.id) }))
        }
        return list
    }

    private func chooseInput(_ id: String?) {
        CallAudioChoice.setInput(id)
        rebuild()
    }

    /// The loudspeaker is the call screen's own switch; the rest is asked of iOS.
    private func chooseOutput(_ kind: String, _ id: String?) {
        if kind == "speaker" {
            if !speakerOn { onSpeaker?() }
            return
        }
        if speakerOn { onSpeaker?() }
        CallAudioChoice.setOutput(kind, id)
        rebuild()
    }

    private func rebuild() {
        let list = entries()
        // Built again only when something shown changed (the timer reads the route every 1.5 s).
        var key = ""
        for entry in list {
            switch entry {
            case .title(let words): key += "t" + words
            case .now(let words): key += "n" + words
            case .row(let icon, let label, let hint, let selected, _): key += "r\(icon)\(label)\(hint)\(String(describing: selected))"
            }
        }
        if key == shownKey { return }
        shownKey = key
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for entry in list {
            switch entry {
            case .title(let words):
                let label = UILabel()
                label.attributedText = NSAttributedString(string: words.uppercased(), attributes: [.font: UIFont.systemFont(ofSize: 12, weight: .bold), .kern: 1.2, .foregroundColor: UIColor(white: 1, alpha: 0.6)])
                label.accessibilityTraits = .header
                stack.addArrangedSubview(CallAudioPanelView.padded(label, top: 10, bottom: 4))
            case .now(let words):
                let label = UILabel()
                label.text = words
                label.font = .systemFont(ofSize: 13)
                label.textColor = UIColor(white: 1, alpha: 0.75)
                stack.addArrangedSubview(CallAudioPanelView.padded(label, top: 0, bottom: 4))
            case .row(let icon, let label, let hint, let selected, let action):
                let row = CallAudioRow(icon: icon, label: label, hint: hint, selected: selected)
                row.onPress = action
                stack.addArrangedSubview(row)
            }
        }
        setNeedsLayout()
    }

    private static func padded(_ label: UILabel, top: CGFloat, bottom: CGFloat) -> UIView {
        let box = UIView()
        label.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 14),
            label.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -14),
            label.topAnchor.constraint(equalTo: box.topAnchor, constant: top),
            label.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -bottom),
        ])
        return box
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        backdrop.frame = bounds
        let width = bounds.width - 20
        // The list's own height: paddingHorizontal 6, paddingBottom 6.
        let fitted = stack.systemLayoutSizeFitting(CGSize(width: width - 12, height: UIView.layoutFittingCompressedSize.height), withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
        let contentHeight = ceil(fitted.height) + 6
        let maxHeight = bounds.height * 0.72
        let height = min(maxHeight, 8 + 44 + contentHeight + 8)
        card.frame = CGRect(x: 10, y: bounds.height - safeAreaInsets.bottom - 10 - height, width: width, height: height)
        header.frame = CGRect(x: 14, y: 8, width: width - 28 - 32, height: 44)
        closeButton.frame = CGRect(x: width - 14 - 22 - 10, y: 8 + 11 - 10, width: 42, height: 42)
        scroll.frame = CGRect(x: 0, y: 52, width: width, height: height - 52 - 8)
        stack.frame = CGRect(x: 6, y: 0, width: width - 12, height: ceil(fitted.height))
        scroll.contentSize = CGSize(width: width, height: contentHeight)
    }
}

/// One row of «Звук»: the icon, the name with a line under it, and a tick when it is the one in use.
private final class CallAudioRow: UIControl {
    var onPress: (() -> Void)?
    private let selectedNow: Bool?

    init(icon: String, label: String, hint: String, selected: Bool?) {
        selectedNow = selected
        super.init(frame: .zero)
        layer.cornerRadius = 14
        layer.cornerCurve = .continuous
        backgroundColor = selected == true ? UIColor(white: 1, alpha: 0.10) : .clear
        let image = UIImageView(image: IonIcon.image(icon, size: 20))
        image.tintColor = .white
        let words = UILabel()
        words.text = label
        words.font = .systemFont(ofSize: 16)
        words.textColor = .white
        words.numberOfLines = 0
        let column = UIStackView(arrangedSubviews: [words])
        column.axis = .vertical
        if !hint.isEmpty {
            let under = UILabel()
            under.text = hint
            under.font = .systemFont(ofSize: 12)
            under.textColor = UIColor(white: 1, alpha: 0.6)
            under.numberOfLines = 0
            column.addArrangedSubview(under)
        }
        let row = UIStackView(arrangedSubviews: [image, column])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 12
        if selected == true {
            let tick = UIImageView(image: IonIcon.image("checkmark", size: 20))
            tick.tintColor = .white
            row.addArrangedSubview(tick)
            tick.widthAnchor.constraint(equalToConstant: 20).isActive = true
            tick.heightAnchor.constraint(equalToConstant: 20).isActive = true
        }
        image.widthAnchor.constraint(equalToConstant: 20).isActive = true
        image.heightAnchor.constraint(equalToConstant: 20).isActive = true
        row.isUserInteractionEnabled = false
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            row.topAnchor.constraint(greaterThanOrEqualTo: topAnchor),
            row.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 50),
        ])
        let fit = row.heightAnchor.constraint(equalTo: heightAnchor)
        fit.priority = .defaultLow
        fit.isActive = true
        isAccessibilityElement = true
        accessibilityLabel = hint.isEmpty ? label : label + ", " + hint
        accessibilityTraits = selected == true ? [.button, .selected] : .button
        addTarget(self, action: #selector(pressed), for: .touchUpInside)
    }

    required init?(coder: NSCoder) { return nil }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? UIColor(white: 1, alpha: 0.14) : (selectedNow == true ? UIColor(white: 1, alpha: 0.10) : .clear) }
    }

    @objc private func pressed() { onPress?() }
}
