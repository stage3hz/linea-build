import UIKit

/// The avatar crop maths (the reference's photo/avatarCrop.ts): the photo covers a round viewport of side `viewport`;
/// the person pans (tx, ty: the photo centre's offset from the viewport centre, in points) and zooms (≥ 1 on top of
/// the «cover» scale). The result is the square of the source image under the circle, in source pixels.
enum AvatarCrop {
    static let maxZoom: CGFloat = 5

    /// The scale at which the photo exactly covers the viewport (its shorter side fills it).
    static func coverScale(_ width: CGFloat, _ height: CGFloat, _ viewport: CGFloat) -> CGFloat {
        return viewport / min(width, height)
    }

    /// The largest offset that still keeps the viewport covered, for the zoom.
    static func maxOffset(_ width: CGFloat, _ height: CGFloat, _ viewport: CGFloat, _ zoom: CGFloat) -> CGPoint {
        let s = coverScale(width, height, viewport) * zoom
        return CGPoint(x: max(0, (width * s - viewport) / 2), y: max(0, (height * s - viewport) / 2))
    }

    static func clamp(_ width: CGFloat, _ height: CGFloat, _ viewport: CGFloat, _ zoom: CGFloat, _ tx: CGFloat, _ ty: CGFloat) -> CGPoint {
        let m = maxOffset(width, height, viewport, zoom)
        return CGPoint(x: max(-m.x, min(m.x, tx)), y: max(-m.y, min(m.y, ty)))
    }

    static func rect(width: CGFloat, height: CGFloat, viewport: CGFloat, zoom given: CGFloat, tx: CGFloat, ty: CGFloat) -> CGRect {
        let zoom = max(1, min(maxZoom, given))
        let offset = clamp(width, height, viewport, zoom, tx, ty)
        let s = coverScale(width, height, viewport) * zoom
        let side = min(width, height, viewport / s)
        // The viewport centre is at (−tx, −ty) from the photo centre, in screen points.
        var x = width / 2 - offset.x / s - side / 2
        var y = height / 2 - offset.y / s - side / 2
        x = max(0, min(width - side, x))
        y = max(0, min(height - side, y))
        return CGRect(x: x.rounded(), y: y.rounded(), width: side.rounded(.down), height: side.rounded(.down))
    }
}

/// The avatar picker (photo/AvatarCropper.tsx): the chosen photo fills the screen, a round window shows exactly what
/// the avatar will be (the rest dimmed), one finger moves the photo, two fingers zoom (up to 5×), a double tap zooms
/// to 2.5× or back. «Готово» gives the square under the circle in the picture's pixels.
final class AvatarCropperViewController: UIViewController, UIGestureRecognizerDelegate {
    private let picture: UIImage
    var onDone: ((CGRect) -> Void)?
    private let photo = UIImageView()
    private let dim = CAShapeLayer()
    private let edge = CAShapeLayer()
    private var zoom: CGFloat = 1
    private var tx: CGFloat = 0
    private var ty: CGFloat = 0
    private var startZoom: CGFloat = 1
    private var start = CGPoint.zero

    init(picture: UIImage) {
        self.picture = picture
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
        modalTransitionStyle = .crossDissolve
    }

    required init?(coder: NSCoder) { return nil }

    private var pixelWidth: CGFloat { return CGFloat(picture.cgImage?.width ?? Int(picture.size.width)) }
    private var pixelHeight: CGFloat { return CGFloat(picture.cgImage?.height ?? Int(picture.size.height)) }
    private var viewport: CGFloat { return min(view.bounds.width - 32, 380) }
    private var base: CGFloat { return AvatarCrop.coverScale(pixelWidth, pixelHeight, viewport) }

    override var prefersStatusBarHidden: Bool { return true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        view.overrideUserInterfaceStyle = .dark
        photo.image = picture
        photo.contentMode = .scaleToFill
        view.addSubview(photo)
        dim.fillRule = .evenOdd
        dim.fillColor = UIColor(white: 0, alpha: 0.62).cgColor
        view.layer.addSublayer(dim)
        edge.fillColor = nil
        edge.strokeColor = UIColor(white: 1, alpha: 0.75).cgColor
        edge.lineWidth = 1.5
        view.layer.addSublayer(edge)

        let title = UILabel()
        title.text = "Фото профиля"
        title.font = .systemFont(ofSize: 17, weight: .bold)
        title.textColor = .white
        let hint = UILabel()
        hint.text = "Двигай и приближай фото пальцами"
        hint.font = .systemFont(ofSize: 13)
        hint.textColor = UIColor(white: 1, alpha: 0.7)
        let top = UIStackView(arrangedSubviews: [title, hint])
        top.axis = .vertical
        top.alignment = .center
        top.spacing = 4
        top.isUserInteractionEnabled = false
        top.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(top)
        let cancel = UIButton(type: .system)
        cancel.setTitle("Отмена", for: .normal)
        cancel.titleLabel?.font = .systemFont(ofSize: 17)
        cancel.tintColor = .white
        cancel.addTarget(self, action: #selector(cancelPressed), for: .touchUpInside)
        let done = UIButton(type: .system)
        done.setTitle("Готово", for: .normal)
        done.titleLabel?.font = .systemFont(ofSize: 17, weight: .bold)
        done.tintColor = .white
        done.addTarget(self, action: #selector(donePressed), for: .touchUpInside)
        for button in [cancel, done] {
            button.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(button)
        }
        NSLayoutConstraint.activate([
            top.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 18),
            top.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            cancel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            cancel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -20),
            done.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),
            done.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -20),
        ])
        let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:)))
        let double = UITapGestureRecognizer(target: self, action: #selector(doubleTapped))
        double.numberOfTapsRequired = 2
        for gesture in [pan, pinch, double] as [UIGestureRecognizer] {
            gesture.delegate = self
            view.addGestureRecognizer(gesture)
        }
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { return true }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let r = viewport / 2
        let circle = UIBezierPath(ovalIn: CGRect(x: view.bounds.midX - r, y: view.bounds.midY - r, width: viewport, height: viewport))
        let mask = UIBezierPath(rect: view.bounds)
        mask.append(circle)
        dim.path = mask.cgPath
        edge.path = circle.cgPath
        place()
    }

    private func place() {
        let s = base * zoom
        let size = CGSize(width: pixelWidth * s, height: pixelHeight * s)
        photo.bounds = CGRect(origin: .zero, size: size)
        photo.center = CGPoint(x: view.bounds.midX + tx, y: view.bounds.midY + ty)
    }

    private func keepCovered() {
        let fixed = AvatarCrop.clamp(pixelWidth, pixelHeight, viewport, zoom, tx, ty)
        tx = fixed.x
        ty = fixed.y
    }

    @objc private func panned(_ gesture: UIPanGestureRecognizer) {
        if gesture.state == .began { start = CGPoint(x: tx, y: ty) }
        let moved = gesture.translation(in: view)
        tx = start.x + moved.x
        ty = start.y + moved.y
        keepCovered()
        place()
    }

    @objc private func pinched(_ gesture: UIPinchGestureRecognizer) {
        if gesture.state == .began { startZoom = zoom }
        zoom = max(1, min(AvatarCrop.maxZoom, startZoom * gesture.scale))
        keepCovered()
        place()
    }

    @objc private func doubleTapped() {
        zoom = zoom > 1.5 ? 1 : 2.5
        keepCovered()
        UIView.animate(withDuration: 0.3) { self.place() }
    }

    @objc private func cancelPressed() { dismiss(animated: true, completion: nil) }

    @objc private func donePressed() {
        let crop = AvatarCrop.rect(width: pixelWidth, height: pixelHeight, viewport: viewport, zoom: zoom, tx: tx, ty: ty)
        let done = onDone
        dismiss(animated: true) { done?(crop) }
    }
}
