import CoreImage
import UIKit

/// Painted art around a round avatar (the reference's platina/Decorations.tsx `DecorationArt`): the still picture
/// from the app's bundle, and — while `live` (profiles, the chosen tile) — the motion drawn in code over it: a band of
/// light crossing the art, its own silhouette breathing as a glow behind it, embers rising or sparkles twinkling.
/// The view's bounds are the art's box (the avatar × `scale`), centred on the avatar.
final class DecorationArtView: UIView {
    let decoration: AvatarCatalog.Decoration
    var live = false {
        didSet { if live != oldValue { built = .zero; setNeedsLayout() } }
    }
    private var built = CGSize.zero
    private static var glows: [String: UIImage] = [:]

    init(decoration: AvatarCatalog.Decoration) {
        self.decoration = decoration
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        NotificationCenter.default.addObserver(self, selector: #selector(back), name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    required init?(coder: NSCoder) { return nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc private func back() { built = .zero; setNeedsLayout() }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { built = .zero; setNeedsLayout() }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width > 0, bounds.size != built else { return }
        built = bounds.size
        layer.sublayers?.forEach { $0.removeFromSuperlayer() }
        guard let picture = AvatarCatalog.picture(decoration) else { return }
        let size = bounds.width
        let box = CGRect(x: 0, y: 0, width: size, height: size)

        if live && !decoration.glow.isEmpty, let glow = DecorationArtView.glowPicture(picture, color: decoration.glow, size: size) {
            let layerGlow = CALayer()
            layerGlow.frame = box
            layerGlow.contents = glow.cgImage
            layerGlow.contentsGravity = .resizeAspect
            layerGlow.opacity = 0.2
            layer.addSublayer(layerGlow)
            layerGlow.add(DecorDraw.loop("opacity", duration: 2.4, ease: DecorEase.inOutQuad) { (p: Double) -> Any in NSNumber(value: 0.2 + 0.45 * sin(p * Double.pi)) }, forKey: "breathe")
            layerGlow.add(DecorDraw.loop("transform.scale", duration: 2.4, ease: DecorEase.inOutQuad) { (p: Double) -> Any in NSNumber(value: 1 + 0.03 * sin(p * Double.pi)) }, forKey: "grow")
        }

        let art = CALayer()
        art.frame = box
        art.contents = picture.cgImage
        art.contentsGravity = .resizeAspect
        layer.addSublayer(art)

        if live && decoration.sweep {
            // Sweep, then rest: a constant shimmer looks cheap, an occasional glint looks expensive.
            let holder = CALayer()
            holder.frame = box
            let mask = CALayer()
            mask.frame = box
            mask.contents = picture.cgImage
            mask.contentsGravity = .resizeAspect
            holder.mask = mask
            let band = CAGradientLayer()
            band.bounds = CGRect(x: 0, y: 0, width: size * 0.55, height: size * 1.5)
            band.anchorPoint = CGPoint(x: 0, y: 0)
            band.position = CGPoint(x: 0, y: -size * 0.25)
            band.colors = [UIColor(white: 1, alpha: 0).cgColor, UIColor(white: 1, alpha: 0.75).cgColor, UIColor(white: 1, alpha: 0).cgColor]
            band.startPoint = CGPoint(x: 0, y: 0.5)
            band.endPoint = CGPoint(x: 1, y: 0.5)
            holder.addSublayer(band)
            layer.addSublayer(holder)
            let sweep = CAKeyframeAnimation(keyPath: "transform")
            var values: [NSValue] = []
            var times: [NSNumber] = []
            let moving = 1.5, total = 1.5 + 2.6
            let steps = 24
            // The band turns about its own centre (RN's rotate is about the view's centre).
            let pivot = CGPoint(x: size * 0.55 / 2, y: size * 1.5 / 2)
            func place(_ p: Double) -> NSValue {
                var made = CATransform3DMakeTranslation(-size * 1.2 + CGFloat(p) * size * 2.4, 0, 0)
                made = CATransform3DTranslate(made, pivot.x, pivot.y, 0)
                made = CATransform3DRotate(made, 18 * .pi / 180, 0, 0, 1)
                made = CATransform3DTranslate(made, -pivot.x, -pivot.y, 0)
                return NSValue(caTransform3D: made)
            }
            for step in 0...steps {
                let t = Double(step) / Double(steps)
                values.append(place(DecorEase.inOutCubic(t)))
                times.append(NSNumber(value: t * moving / total))
            }
            values.append(place(1))
            times.append(NSNumber(value: 1))
            sweep.values = values
            sweep.keyTimes = times
            sweep.duration = total
            sweep.repeatCount = .infinity
            sweep.isRemovedOnCompletion = false
            band.transform = place(0).caTransform3DValue
            band.add(sweep, forKey: "sweep")
        }

        if live && !decoration.particles.isEmpty {
            let rise = decoration.rise
            let color = lookColor(decoration.particles)
            for index in 0..<(rise ? 9 : 7) {
                let r: (Double) -> Double = { (n: Double) -> Double in decorRand(Double(index) * 11 + n) }
                let angle = r(1) * Double.pi * 2, radius = Double(size) * (0.36 + r(2) * 0.1)
                let x = Double(size) / 2 + cos(angle) * radius, y = Double(size) / 2 + sin(angle) * radius
                let dot = max(2, Double(size) * (rise ? 0.018 : 0.022) * (0.7 + r(3) * 0.6))
                let spark = CALayer()
                spark.bounds = CGRect(x: 0, y: 0, width: dot, height: dot)
                spark.position = CGPoint(x: x, y: y)
                spark.cornerRadius = CGFloat(dot / 2)
                spark.backgroundColor = color.cgColor
                spark.shadowColor = color.cgColor
                spark.shadowOpacity = 0.9
                spark.shadowRadius = CGFloat(dot * 1.5)
                spark.shadowOffset = .zero
                spark.opacity = 0
                let duration = (1800 + r(4) * 1800) / 1000, delay = (r(5) * 1600).rounded() / 1000
                let wobble = Double(index)
                if rise {
                    spark.add(DecorDraw.loop("opacity", duration: duration, delay: delay, ease: DecorEase.inOutQuad) { (p: Double) -> Any in NSNumber(value: min(1, p * 4, (1 - p) * 2)) }, forKey: "fade")
                    spark.add(DecorDraw.loop("transform", duration: duration, delay: delay, ease: DecorEase.inOutQuad) { (p: Double) -> Any in
                        NSValue(caTransform3D: CATransform3DMakeTranslation(CGFloat(sin(p * 6 + wobble) * Double(size) * 0.015), CGFloat(-p * Double(size) * 0.14), 0))
                    }, forKey: "rise")
                } else {
                    spark.add(DecorDraw.loop("opacity", duration: duration, delay: delay, ease: DecorEase.inOutQuad) { (p: Double) -> Any in NSNumber(value: abs(sin(p * Double.pi)) * 0.9) }, forKey: "fade")
                    spark.add(DecorDraw.loop("transform.scale", duration: duration, delay: delay, ease: DecorEase.inOutQuad) { (p: Double) -> Any in NSNumber(value: 0.5 + sin(p * Double.pi) * 0.7) }, forKey: "twinkle")
                }
                layer.addSublayer(spark)
            }
        }
    }

    /// The art's silhouette in one colour, blurred (`blurRadius` max(4, 5% of the art)), made once per size.
    private static func glowPicture(_ picture: UIImage, color: String, size: CGFloat) -> UIImage? {
        let key = "\(color)@\(Int(size))@\(picture.hash)"
        if let hit = glows[key] { return hit }
        let side = CGSize(width: size, height: size)
        let tinted = UIGraphicsImageRenderer(size: side).image { (context: UIGraphicsImageRendererContext) -> Void in
            picture.draw(in: CGRect(origin: .zero, size: side))
            lookColor(color).setFill()
            context.fill(CGRect(origin: .zero, size: side), blendMode: .sourceIn)
        }
        guard let input = CIImage(image: tinted), let blur = CIFilter(name: "CIGaussianBlur") else { return tinted }
        blur.setValue(input.clampedToExtent(), forKey: kCIInputImageKey)
        blur.setValue(max(4, size * 0.05) * tinted.scale / 2, forKey: kCIInputRadiusKey)
        guard let output = blur.outputImage?.cropped(to: input.extent), let made = CIContext().createCGImage(output, from: input.extent) else { return tinted }
        let image = UIImage(cgImage: made, scale: tinted.scale, orientation: .up)
        glows[key] = image
        return image
    }
}
