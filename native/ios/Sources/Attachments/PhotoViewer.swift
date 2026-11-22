import UIKit

/// A photo on the whole screen. The small picture from the message is shown at once; the real one replaces it
/// when it has been downloaded, checked and decrypted. Pinch or double tap to zoom, swipe down or the cross to
/// close. The decrypted picture lives in memory only, for as long as this screen is open.
final class PhotoViewer: UIViewController, UIScrollViewDelegate, UIGestureRecognizerDelegate {
    private let scroll = UIScrollView()
    private let picture = UIImageView()
    private let close = UIButton(type: .system)
    private let note = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let small: UIImage?
    private var full: UIImage?
    private let loader: AttachmentLoad?
    private var failed = false
    private lazy var drag = UIPanGestureRecognizer(target: self, action: #selector(dragged(_:)))

    /// `small`: the picture from the message, if it has one. `load`: what brings the real picture (nil: `small` is all there is).
    init(small: UIImage?, load: AttachmentLoad?) {
        self.small = small
        loader = load
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        modalTransitionStyle = .crossDissolve
    }

    required init?(coder: NSCoder) { return nil }

    override var prefersStatusBarHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        scroll.delegate = self
        scroll.minimumZoomScale = 1
        scroll.maximumZoomScale = 4
        scroll.showsVerticalScrollIndicator = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.bouncesZoom = true
        view.addSubview(scroll)
        picture.contentMode = .scaleAspectFit
        picture.image = small
        picture.isAccessibilityElement = true
        picture.accessibilityLabel = "Фото"
        scroll.addSubview(picture)

        note.font = .systemFont(ofSize: 13)
        note.textColor = Theme.text
        note.textAlignment = .center
        note.numberOfLines = 0
        view.addSubview(note)
        spinner.color = Theme.text
        spinner.hidesWhenStopped = true
        view.addSubview(spinner)

        close.setImage(UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold)), for: .normal)
        close.tintColor = Theme.text
        close.backgroundColor = UIColor(white: 0, alpha: 0.45)
        close.layer.cornerRadius = 20
        close.accessibilityLabel = "Закрыть просмотр"
        close.addTarget(self, action: #selector(closeNow), for: .touchUpInside)
        view.addSubview(close)

        let twice = UITapGestureRecognizer(target: self, action: #selector(tappedTwice(_:)))
        twice.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(twice)
        let once = UITapGestureRecognizer(target: self, action: #selector(tappedOnce))
        once.require(toFail: twice)
        view.addGestureRecognizer(once)
        drag.delegate = self
        view.addGestureRecognizer(drag)
        MotionBlur.attach(scroll, following: drag) // MotionBlur: the picture dragged down and let go, smeared along its fall below 90 Hz
        begin()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if scroll.frame.size != view.bounds.size {
            scroll.zoomScale = 1
            scroll.frame = view.bounds
            picture.frame = scroll.bounds
            scroll.contentSize = scroll.bounds.size
        }
        let top = view.safeAreaInsets.top
        close.frame = CGRect(x: view.bounds.width - 56, y: top + 8, width: 40, height: 40)
        let bottom = view.bounds.height - max(view.safeAreaInsets.bottom, 16)
        let size = note.sizeThatFits(CGSize(width: view.bounds.width - 48, height: 200))
        note.frame = CGRect(x: 24, y: bottom - size.height - 8, width: view.bounds.width - 48, height: size.height)
        spinner.center = small == nil && full == nil ? view.center : CGPoint(x: view.bounds.midX, y: note.frame.minY - 20)
    }

    private func say(_ words: String) {
        note.text = words
        view.setNeedsLayout()
    }

    /// Asks for the real picture.
    private func begin() {
        guard let load = loader else { return }
        failed = false
        say("")
        spinner.startAnimating()
        load.onProgress = { [weak self] words in self?.say(words) }
        load.start { [weak self] result in
            guard let self else { return }
            self.spinner.stopAnimating()
            switch result {
            case .success(let data):
                if let image = UIImage(data: data) {
                    self.full = image
                    self.picture.image = image
                    self.say("")
                } else {
                    self.say("Устройство не смогло показать изображение.")
                }
            case .failure(let failure):
                self.failed = true
                self.say(failure.words + "\nОшибка · нажми, чтобы повторить")
            }
        }
    }

    @objc private func closeNow() {
        loader?.cancel()
        dismiss(animated: true)
    }

    @objc private func tappedOnce() {
        if failed { begin() }
    }

    @objc private func tappedTwice(_ tap: UITapGestureRecognizer) {
        if scroll.zoomScale > 1.01 {
            scroll.setZoomScale(1, animated: true)
            return
        }
        let point = tap.location(in: picture)
        let size = CGSize(width: scroll.bounds.width / 2.5, height: scroll.bounds.height / 2.5)
        scroll.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { picture }

    // MARK: Swipe down to close

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === drag else { return true }
        // Only a mostly vertical, downward move over a picture that is not zoomed in.
        let speed = drag.velocity(in: view)
        return scroll.zoomScale <= 1.01 && speed.y > 0 && abs(speed.y) > abs(speed.x) * 1.5
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        gestureRecognizer === drag
    }

    @objc private func dragged(_ pan: UIPanGestureRecognizer) {
        let move = max(0, pan.translation(in: view).y)
        let part = min(1, move / max(1, view.bounds.height * 0.5))
        switch pan.state {
        case .changed:
            scroll.transform = CGAffineTransform(translationX: 0, y: move)
            view.backgroundColor = UIColor.black.withAlphaComponent(1 - part * 0.7)
            close.alpha = 1 - part
            note.alpha = 1 - part
        case .ended, .cancelled, .failed:
            let away = pan.state == .ended && (move > view.bounds.height * 0.18 || pan.velocity(in: view).y > 900)
            if away {
                loader?.cancel()
                UIView.animate(withDuration: 0.2, animations: {
                    self.scroll.transform = CGAffineTransform(translationX: 0, y: self.view.bounds.height)
                    self.view.backgroundColor = UIColor.black.withAlphaComponent(0)
                }, completion: { _ in self.dismiss(animated: false) })
            } else {
                UIView.animate(withDuration: 0.25) {
                    self.scroll.transform = .identity
                    self.view.backgroundColor = .black
                    self.close.alpha = 1
                    self.note.alpha = 1
                }
            }
        default:
            break
        }
    }
}
