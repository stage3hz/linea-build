import UIKit

// Animated avatar frames drawn in code (the reference's platina/CodeFrames.tsx, SVG + Reanimated), ported shape for
// shape and timing for timing to Core Animation: sharp at any size, no image files. Each frame sits around a round
// avatar and reaches 30% past it (the view is 1.3× the avatar, centred over it). `live` plays the motion
// (profiles, the selected choice); lists get the still frame (each loop held at 0.15 of its way, as the reference).

/// The reference's deterministic pseudo-random: the same frame looks the same on every phone.
func decorRand(_ seed: Double) -> Double {
    let x = sin(seed * 9301 + 49297) * 233280
    return x - floor(x)
}

/// Easing curves of Reanimated.
enum DecorEase {
    static func linear(_ t: Double) -> Double { return t }
    static func inOutSine(_ t: Double) -> Double { return -(cos(Double.pi * t) - 1) / 2 }
    static func inOutQuad(_ t: Double) -> Double { return t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2 }
    static func inOutCubic(_ t: Double) -> Double { return t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2 }
    static func outCubic(_ t: Double) -> Double { return 1 - pow(1 - t, 3) }
}

/// Small helpers shared by the drawn decorations.
enum DecorDraw {
    static func circle(_ center: CGPoint, _ radius: CGFloat) -> CGPath {
        return UIBezierPath(arcCenter: center, radius: radius, startAngle: 0, endAngle: .pi * 2, clockwise: true).cgPath
    }

    static func stroke(_ path: CGPath, color: UIColor, width: CGFloat, dash: [CGFloat] = [], round: Bool = false, frame: CGRect) -> CAShapeLayer {
        let layer = CAShapeLayer()
        layer.frame = frame
        layer.path = path
        layer.fillColor = nil
        layer.strokeColor = color.cgColor
        layer.lineWidth = width
        if !dash.isEmpty { layer.lineDashPattern = dash.map { NSNumber(value: Double($0)) } }
        if round { layer.lineCap = .round }
        layer.lineJoin = .round
        return layer
    }

    static func fill(_ path: CGPath, color: UIColor, frame: CGRect) -> CAShapeLayer {
        let layer = CAShapeLayer()
        layer.frame = frame
        layer.path = path
        layer.fillColor = color.cgColor
        return layer
    }

    /// A gradient seen through a shape (an SVG `url(#gradient)` stroke or fill). The gradient spans `box`.
    static func gradient(_ colors: [UIColor], start: CGPoint, end: CGPoint, locations: [Double]? = nil, through mask: CAShapeLayer, box: CGRect, frame: CGRect) -> CALayer {
        let holder = CALayer()
        holder.frame = frame
        let gradient = CAGradientLayer()
        gradient.frame = box
        gradient.colors = colors.map { $0.cgColor }
        gradient.startPoint = start
        gradient.endPoint = end
        if let locations { gradient.locations = locations.map { NSNumber(value: $0) } }
        holder.addSublayer(gradient)
        mask.frame = holder.bounds
        holder.mask = mask
        return holder
    }

    /// An SVG path in a `viewBox` of w×h, scaled to `size` (only M, L, C, Q, Z with absolute numbers are used).
    static func path(_ text: String, viewBox: CGSize, size: CGSize) -> CGPath {
        let path = CGMutablePath()
        let sx = size.width / viewBox.width, sy = size.height / viewBox.height
        var numbers: [CGFloat] = []
        var command: Character = "M"
        func flush() {
            func point(_ index: Int) -> CGPoint { return CGPoint(x: numbers[index] * sx, y: numbers[index + 1] * sy) }
            switch command {
            case "M": if numbers.count >= 2 { path.move(to: point(0)); var i = 2; while i + 1 < numbers.count { path.addLine(to: point(i)); i += 2 } }
            case "L": var i = 0; while i + 1 < numbers.count { path.addLine(to: point(i)); i += 2 }
            case "C": var i = 0; while i + 5 < numbers.count { path.addCurve(to: point(i + 4), control1: point(i), control2: point(i + 2)); i += 6 }
            case "Q": var i = 0; while i + 3 < numbers.count { path.addQuadCurve(to: point(i + 2), control: point(i)); i += 4 }
            case "Z": path.closeSubpath()
            default: break
            }
            numbers = []
        }
        var current = ""
        for character in text {
            if "MLCQZ".contains(character) {
                if !current.isEmpty, let value = Double(current) { numbers.append(CGFloat(value)) }
                current = ""
                flush()
                command = character
            } else if character == " " || character == "," {
                if !current.isEmpty, let value = Double(current) { numbers.append(CGFloat(value)) }
                current = ""
            } else if character == "-" && !current.isEmpty {
                if let value = Double(current) { numbers.append(CGFloat(value)) }
                current = "-"
            } else {
                current.append(character)
            }
        }
        if !current.isEmpty, let value = Double(current) { numbers.append(CGFloat(value)) }
        flush()
        return path
    }

    /// A looping animation of `keyPath`: `value(p)` sampled along a 0→1 loop of `duration` seconds after `delay`,
    /// eased like Reanimated's `withTiming(…, {easing})` under `withRepeat(-1)`.
    static func loop(_ keyPath: String, duration: Double, delay: Double = 0, ease: @escaping (Double) -> Double = DecorEase.linear, samples: Int = 24, value: (Double) -> Any) -> CAKeyframeAnimation {
        let animation = CAKeyframeAnimation(keyPath: keyPath)
        var values: [Any] = []
        var times: [NSNumber] = []
        for step in 0...samples {
            let t = Double(step) / Double(samples)
            values.append(value(ease(t)))
            times.append(NSNumber(value: t))
        }
        animation.values = values
        animation.keyTimes = times
        animation.calculationMode = .linear
        animation.duration = duration
        animation.repeatCount = .infinity
        animation.isRemovedOnCompletion = false
        if delay > 0 {
            animation.beginTime = CACurrentMediaTime() + delay
            animation.fillMode = .backwards
        }
        return animation
    }

    /// A full turn every `duration` seconds (negative `turns`: the other way).
    static func spin(duration: Double, turns: Double = 1, from: Double = 0) -> CABasicAnimation {
        let animation = CABasicAnimation(keyPath: "transform.rotation.z")
        animation.fromValue = from
        animation.toValue = from + Double.pi * 2 * turns
        animation.duration = duration
        animation.repeatCount = .infinity
        animation.isRemovedOnCompletion = false
        return animation
    }

    /// A layer the size of `frame` that turns about its centre.
    static func turning(_ frame: CGRect) -> CALayer {
        let layer = CALayer()
        layer.frame = frame
        return layer
    }
}

/// One of the frames drawn in code. Its bounds are the art's box (the avatar's size × 1.3), centred on the avatar.
final class CodeFrameView: UIView {
    let frameId: String
    var live = false {
        didSet { if live != oldValue { built = .zero; setNeedsLayout() } }
    }
    private var built = CGSize.zero

    init(frameId: String) {
        self.frameId = frameId
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
        let art = bounds.width
        switch frameId {
        case "fx-neon": neon(art)
        case "fx-flame": flame(art)
        case "fx-stardust": stardust(art)
        case "fx-glitch": glitch(art)
        case "fx-aurora": aurora(art)
        case "fx-lightning": lightning(art)
        case "fx-hearts": hearts(art)
        default: orbit(art)
        }
    }

    /// Where a loop stands in a still frame.
    private let stillAt = 0.15

    private func whole(_ art: CGFloat) -> CGRect { return CGRect(x: 0, y: 0, width: art, height: art) }

    // MARK: The frames

    private func neon(_ art: CGFloat) {
        let c = CGPoint(x: art / 2, y: art / 2), r = art * 0.405
        let glow = DecorDraw.stroke(DecorDraw.circle(c, r), color: lookColor("#22E4FF", alpha: 0.35), width: art * 0.07, frame: whole(art))
        let glowAt: (Double) -> Double = { (p: Double) -> Double in 0.45 + 0.4 * sin(p * Double.pi) }
        glow.opacity = Float(glowAt(stillAt))
        layer.addSublayer(glow)
        let turn = DecorDraw.turning(whole(art))
        let ringMask = DecorDraw.stroke(DecorDraw.circle(c, r), color: .black, width: art * 0.028, frame: whole(art))
        let box = CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)
        turn.addSublayer(DecorDraw.gradient([lookColor("#FF2BD6"), lookColor("#22E4FF"), lookColor("#7C5CFF")], start: CGPoint(x: 0, y: 0), end: CGPoint(x: 1, y: 1), through: ringMask, box: box, frame: whole(art)))
        turn.addSublayer(DecorDraw.fill(DecorDraw.circle(CGPoint(x: c.x, y: c.y - r), art * 0.022), color: .white, frame: whole(art)))
        layer.addSublayer(turn)
        if live {
            glow.add(DecorDraw.loop("opacity", duration: 1.7, ease: DecorEase.inOutSine) { (p: Double) -> Any in NSNumber(value: glowAt(p)) }, forKey: "pulse")
            turn.add(DecorDraw.spin(duration: 2.6), forKey: "spin")
        } else {
            turn.setAffineTransform(CGAffineTransform(rotationAngle: CGFloat(stillAt * Double.pi * 2)))
        }
    }

    private func flame(_ art: CGFloat) {
        let ember = CAGradientLayer()
        ember.type = .radial
        ember.frame = whole(art)
        ember.startPoint = CGPoint(x: 0.5, y: 0.5)
        ember.endPoint = CGPoint(x: 1, y: 1)
        let orange = lookColor("#FF7A1A"), red = lookColor("#FF2E00")
        ember.colors = [orange.withAlphaComponent(0).cgColor, orange.withAlphaComponent(0).cgColor, orange.withAlphaComponent(0.7).cgColor, red.withAlphaComponent(0).cgColor]
        ember.locations = [0, 0.72, 0.8, 1]
        layer.addSublayer(ember)
        let r = art * 0.39, count = 14
        let w = art * 0.08, h = art * 0.13
        let shape = DecorDraw.path("M5 0 C7 4 10 7 10 11 C10 14 7.8 16 5 16 C2.2 16 0 14 0 11 C0 7 3 4 5 0 Z", viewBox: CGSize(width: 10, height: 16), size: CGSize(width: w, height: h))
        for index in 0..<count {
            let seed = Double(index)
            let angle = CGFloat(index) / CGFloat(count) * .pi * 2
            // rotate(angle), then up by r + 0.35 h — the tongue's own scale then plays about its centre.
            let holder = CALayer()
            holder.bounds = CGRect(x: 0, y: 0, width: w, height: h)
            holder.position = CGPoint(x: art / 2, y: art / 2)
            holder.transform = CATransform3DTranslate(CATransform3DMakeRotation(angle, 0, 0, 1), 0, -r - h * 0.35, 0)
            let mask = CAShapeLayer()
            mask.path = shape
            mask.fillColor = UIColor.black.cgColor
            let tongue = DecorDraw.gradient([lookColor("#FF3D00"), lookColor("#FF9A1F"), lookColor("#FFE680")], start: CGPoint(x: 0, y: 1), end: CGPoint(x: 0, y: 0), locations: [0, 0.55, 1], through: mask, box: CGRect(x: 0, y: 0, width: w, height: h), frame: CGRect(x: 0, y: 0, width: w, height: h))
            holder.addSublayer(tongue)
            let scaleAt: (Double) -> CATransform3D = { (p: Double) -> CATransform3D in
                CATransform3DMakeScale(CGFloat(0.9 + 0.15 * cos(p * Double.pi * 2)), CGFloat(0.75 + 0.45 * sin(p * Double.pi)), 1)
            }
            if live {
                let duration = (520 + decorRand(seed) * 380) / 1000, delay = decorRand(seed + 3) * 400 / 1000
                tongue.transform = scaleAt(0)
                tongue.add(DecorDraw.loop("transform", duration: duration, delay: delay, ease: DecorEase.inOutSine) { (p: Double) -> Any in NSValue(caTransform3D: scaleAt(p)) }, forKey: "flicker")
            } else {
                tongue.transform = scaleAt(stillAt)
            }
            layer.addSublayer(holder)
        }
    }

    private func stardust(_ art: CGFloat) {
        let c = art / 2
        func ring(_ count: Int, _ radius: CGFloat, _ seed: Double, _ color: String) -> CALayer {
            let holder = DecorDraw.turning(whole(art))
            for index in 0..<count {
                let i = Double(index)
                let angle = Double(index) / Double(count) * Double.pi * 2 + decorRand(seed + i) * 0.4
                let size = art * CGFloat(0.012 + decorRand(seed + i * 3) * 0.018)
                let dot = DecorDraw.fill(DecorDraw.circle(CGPoint(x: c + CGFloat(cos(angle)) * radius, y: c + CGFloat(sin(angle)) * radius), size), color: lookColor(color), frame: whole(art))
                dot.opacity = Float(0.55 + decorRand(seed + i * 7) * 0.45)
                holder.addSublayer(dot)
            }
            return holder
        }
        let slow = ring(18, art * 0.42, 1, "#FFF4C2"), fast = ring(11, art * 0.47, 9, "#C9B8FF")
        layer.addSublayer(slow)
        layer.addSublayer(fast)
        if live {
            slow.add(DecorDraw.spin(duration: 9), forKey: "spin")
            fast.add(DecorDraw.spin(duration: 5.2, turns: -1), forKey: "spin")
        } else {
            slow.setAffineTransform(CGAffineTransform(rotationAngle: CGFloat(stillAt * Double.pi * 2)))
            fast.setAffineTransform(CGAffineTransform(rotationAngle: CGFloat(-stillAt * Double.pi * 2)))
        }
        for index in 0..<4 {
            let seed = Double(index)
            let a = decorRand(seed + 2) * Double.pi * 2, rr = art * CGFloat(0.4 + decorRand(seed + 4) * 0.08), s = art * 0.09
            let star = DecorDraw.fill(DecorDraw.path("M5 0 L6 4 L10 5 L6 6 L5 10 L4 6 L0 5 L4 4 Z", viewBox: CGSize(width: 10, height: 10), size: CGSize(width: s, height: s)), color: .white, frame: CGRect(x: 0, y: 0, width: s, height: s))
            star.position = CGPoint(x: c + CGFloat(cos(a)) * rr, y: c + CGFloat(sin(a)) * rr)
            let shapeAt: (Double) -> CATransform3D = { (p: Double) -> CATransform3D in
                let grow = CGFloat(0.4 + sin(p * Double.pi) * 0.8)
                return CATransform3DRotate(CATransform3DMakeScale(grow, grow, 1), CGFloat(p * Double.pi / 2), 0, 0, 1)
            }
            if live {
                let duration = (1400 + decorRand(seed) * 1200) / 1000, delay = decorRand(seed + 5) * 1200 / 1000
                star.opacity = 0
                star.transform = shapeAt(0)
                star.add(DecorDraw.loop("opacity", duration: duration, delay: delay, ease: DecorEase.inOutSine) { (p: Double) -> Any in NSNumber(value: sin(p * Double.pi)) }, forKey: "fade")
                star.add(DecorDraw.loop("transform", duration: duration, delay: delay, ease: DecorEase.inOutSine) { (p: Double) -> Any in NSValue(caTransform3D: shapeAt(p)) }, forKey: "grow")
            } else {
                star.opacity = Float(sin(stillAt * Double.pi))
                star.transform = shapeAt(stillAt)
            }
            layer.addSublayer(star)
        }
    }

    private func glitch(_ art: CGFloat) {
        let c = CGPoint(x: art / 2, y: art / 2), r = art * 0.405, w = art * 0.03
        let red = DecorDraw.stroke(DecorDraw.circle(c, r), color: lookColor("#FF2A55"), width: w, dash: [art * 0.3, art * 0.04], frame: whole(art))
        red.opacity = 0.85
        let cyan = DecorDraw.stroke(DecorDraw.circle(c, r), color: lookColor("#00F0FF"), width: w, dash: [art * 0.22, art * 0.06], frame: whole(art))
        cyan.opacity = 0.85
        let white = DecorDraw.stroke(DecorDraw.circle(c, r), color: .white, width: w * 0.55, frame: whole(art))
        for (layerPart, seed) in [(red, 1), (cyan, 2)] {
            layer.addSublayer(layerPart)
            if live {
                let d = art * 0.025, sign: CGFloat = seed % 2 == 1 ? 1 : -1
                let rest = Double(900 + seed * 130) / 1000
                let steps: [Double] = [rest, 0.04, 0.05, 0.04, 0.04]
                let total = steps.reduce(0, +)
                let xs: [CGFloat] = [0, 0, d * sign, -d * 0.6, d * 0.3, 0]
                let animation = CAKeyframeAnimation(keyPath: "transform")
                animation.values = xs.map { NSValue(caTransform3D: CATransform3DMakeTranslation($0, -$0 * 0.4, 0)) }
                var at = 0.0
                var times: [NSNumber] = [0]
                for step in steps { at += step; times.append(NSNumber(value: at / total)) }
                animation.keyTimes = times
                animation.timingFunctions = steps.map { _ in CAMediaTimingFunction(name: .easeInEaseOut) }
                animation.duration = total
                animation.repeatCount = .infinity
                animation.isRemovedOnCompletion = false
                layerPart.add(animation, forKey: "jitter")
            } else {
                let x = seed == 1 ? art * 0.012 : -art * 0.012
                layerPart.transform = CATransform3DMakeTranslation(x, -x * 0.4, 0)
            }
        }
        layer.addSublayer(white)
    }

    private func aurora(_ art: CGFloat) {
        let c = CGPoint(x: art / 2, y: art / 2), r = art * 0.41
        let box = CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)
        func ring(_ colors: [String], _ width: CGFloat, _ dash: [CGFloat]) -> CALayer {
            let holder = DecorDraw.turning(whole(art))
            let mask = DecorDraw.stroke(DecorDraw.circle(c, r), color: .black, width: width, dash: dash, round: true, frame: whole(art))
            let stops = colors.indices.map { Double($0) / Double(max(1, colors.count - 1)) }
            holder.addSublayer(DecorDraw.gradient(colors.map { lookColor($0) }, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 1, y: 1), locations: stops, through: mask, box: box, frame: whole(art)))
            return holder
        }
        let one = ring(["#00FFA3", "#00C2FF", "#7B61FF", "#00FFA3"], art * 0.05, [])
        let two = ring(["#FF6AD5", "#C774E8", "#94D0FF"], art * 0.022, [art * 0.5, art * 0.3])
        two.opacity = 0.7
        layer.addSublayer(one)
        layer.addSublayer(two)
        if live {
            one.add(DecorDraw.spin(duration: 7), forKey: "spin")
            two.add(DecorDraw.spin(duration: 4.8, turns: -1), forKey: "spin")
        } else {
            one.setAffineTransform(CGAffineTransform(rotationAngle: CGFloat(stillAt * Double.pi * 2)))
            two.setAffineTransform(CGAffineTransform(rotationAngle: CGFloat(-stillAt * Double.pi * 2)))
        }
    }

    private func lightning(_ art: CGFloat) {
        let c = art / 2, r = art * 0.41
        layer.addSublayer(DecorDraw.stroke(DecorDraw.circle(CGPoint(x: c, y: c), r), color: lookColor("#8FB8FF", alpha: 0.55), width: art * 0.018, frame: whole(art)))
        let path = CGMutablePath()
        let segments = 7
        for index in 0...segments {
            let t = Double(index) / Double(segments)
            let a = -0.55 + t * 1.1
            let rr = r + (index % 2 == 1 ? 1 : -1) * art * 0.035
            let point = CGPoint(x: c + CGFloat(cos(a)) * rr, y: c + CGFloat(sin(a)) * rr)
            if index == 0 { path.move(to: point) } else { path.addLine(to: point) }
        }
        for index in 0..<3 {
            let seed = Double(index)
            let bolt = DecorDraw.turning(whole(art))
            bolt.addSublayer(DecorDraw.stroke(path, color: lookColor("#6FA8FF", alpha: 0.6), width: art * 0.045, frame: whole(art)))
            bolt.addSublayer(DecorDraw.stroke(path, color: .white, width: art * 0.016, frame: whole(art)))
            let start = decorRand(seed) * Double.pi * 2
            if live {
                let steps: [Double] = [0.06, 0.07, 0.05, 0.26, (700 + seed * 420) / 1000]
                let total = steps.reduce(0, +)
                let flash = CAKeyframeAnimation(keyPath: "opacity")
                let first: Double = index == 0 ? 1 : 0
                let levels: [Double] = [first, 1, 0.2, 1, 0, 0]
                flash.values = levels.map { (level: Double) -> NSNumber in NSNumber(value: level) }
                var at = 0.0
                var times: [NSNumber] = [0]
                for step in steps { at += step; times.append(NSNumber(value: at / total)) }
                flash.keyTimes = times
                flash.duration = total
                flash.repeatCount = .infinity
                flash.isRemovedOnCompletion = false
                if index > 0 {
                    flash.beginTime = CACurrentMediaTime() + seed * 0.38
                    flash.fillMode = .backwards
                }
                bolt.opacity = 0
                bolt.add(flash, forKey: "flash")
                bolt.add(DecorDraw.spin(duration: (6000 + seed * 900) / 1000, from: start), forKey: "spin")
            } else {
                bolt.opacity = index == 0 ? 1 : 0
                bolt.setAffineTransform(CGAffineTransform(rotationAngle: CGFloat(start)))
            }
            layer.addSublayer(bolt)
        }
    }

    private func hearts(_ art: CGFloat) {
        let c = art / 2, r = art * 0.43, count = 8
        layer.addSublayer(DecorDraw.stroke(DecorDraw.circle(CGPoint(x: c, y: c), art * 0.4), color: lookColor("#FF5FA2", alpha: 0.5), width: art * 0.014, frame: whole(art)))
        let turn = DecorDraw.turning(whole(art))
        for index in 0..<count {
            let seed = Double(index)
            let angle = Double(index) / Double(count) * Double.pi * 2
            let s = art * CGFloat(0.07 + decorRand(seed + 2) * 0.03)
            let heart = DecorDraw.fill(DecorDraw.path("M12 21.6 L10.3 20 C4.2 14.5 0.2 10.9 0.2 6.4 C0.2 2.8 3 0 6.6 0 C8.6 0 10.6 1 12 2.5 C13.4 1 15.4 0 17.4 0 C21 0 23.8 2.8 23.8 6.4 C23.8 10.9 19.8 14.5 13.7 20 Z", viewBox: CGSize(width: 24, height: 22), size: CGSize(width: s, height: s)),
                                       color: lookColor(index % 3 != 0 ? "#FF4F8B" : "#FF9CC2"), frame: CGRect(x: 0, y: 0, width: s, height: s))
            heart.position = CGPoint(x: c + CGFloat(cos(angle)) * r, y: c + CGFloat(sin(angle)) * r)
            let beatAt: (Double) -> CATransform3D = { (p: Double) -> CATransform3D in
                let grow = CGFloat(0.8 + 0.3 * sin(p * Double.pi))
                return CATransform3DMakeScale(grow, grow, 1)
            }
            if live {
                heart.transform = beatAt(0)
                heart.add(DecorDraw.loop("transform", duration: (1100 + decorRand(seed) * 500) / 1000, delay: decorRand(seed + 1) * 600 / 1000, ease: DecorEase.inOutSine) { (p: Double) -> Any in NSValue(caTransform3D: beatAt(p)) }, forKey: "beat")
            } else {
                heart.transform = beatAt(stillAt)
            }
            turn.addSublayer(heart)
        }
        layer.addSublayer(turn)
        if live { turn.add(DecorDraw.spin(duration: 8), forKey: "spin") } else { turn.setAffineTransform(CGAffineTransform(rotationAngle: CGFloat(stillAt * Double.pi * 2))) }
    }

    private func orbit(_ art: CGFloat) {
        func ring(duration: Double, tilt: Double, color: String, planet: String, rx: CGFloat) {
            let holder = DecorDraw.turning(whole(art))
            holder.setAffineTransform(CGAffineTransform(rotationAngle: CGFloat(tilt * Double.pi / 180)))
            let c = art / 2, ry = rx * 0.32, s = art * 0.075
            let ellipse = DecorDraw.stroke(UIBezierPath(ovalIn: CGRect(x: c - rx, y: c - ry, width: rx * 2, height: ry * 2)).cgPath, color: lookColor(color, alpha: 0.7), width: art * 0.01, frame: whole(art))
            holder.addSublayer(ellipse)
            let moon = CALayer()
            moon.bounds = CGRect(x: 0, y: 0, width: s, height: s)
            moon.cornerRadius = s / 2
            moon.backgroundColor = lookColor(planet).cgColor
            moon.shadowColor = lookColor(planet).cgColor
            moon.shadowOpacity = 0.9
            moon.shadowRadius = s
            moon.shadowOffset = .zero
            let placeAt: (Double) -> CGPoint = { (p: Double) -> CGPoint in
                let t = p * Double.pi * 2
                return CGPoint(x: c + CGFloat(cos(t)) * rx, y: c + CGFloat(sin(t)) * ry)
            }
            if live {
                moon.position = placeAt(0)
                moon.add(DecorDraw.loop("position", duration: duration, samples: 48) { (p: Double) -> Any in NSValue(cgPoint: placeAt(p)) }, forKey: "orbit")
            } else {
                moon.position = placeAt(stillAt)
            }
            holder.addSublayer(moon)
            layer.addSublayer(holder)
        }
        ring(duration: 3.6, tilt: -22, color: "#9FD3FF", planet: "#5EC8FF", rx: art * 0.48)
        ring(duration: 5.4, tilt: 28, color: "#FFD39F", planet: "#FFB347", rx: art * 0.46)
    }

    /// The still frame as a picture (the chat list draws it from ChatDecorStore).
    static func still(_ frameId: String, avatar: CGFloat) -> UIImage? {
        let view = CodeFrameView(frameId: frameId)
        let art = avatar * AvatarCatalog.codeFrameScale
        view.frame = CGRect(x: 0, y: 0, width: art, height: art)
        view.layoutIfNeeded()
        let renderer = UIGraphicsImageRenderer(size: view.bounds.size)
        return renderer.image { (context: UIGraphicsImageRendererContext) -> Void in view.layer.render(in: context.cgContext) }
    }
}
