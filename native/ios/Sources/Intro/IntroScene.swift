import UIKit
import CoreText

/// The intro's pictures, made once: the word INVIZ as a picture (I, V, I, Z in the app's Unbounded face; N is the
/// app's own sign, the mark of the app icon by its traced outlines), the two digits a particle shows close up, and
/// where the strokes of the cipher's signs are. Android: intro/IntroScene.kt (IntroArt).
final class IntroArt {
    /// The word, white on clear, `width` × `height`; `alpha` is its coverage row by row from the top (0…255).
    let width: Int
    let height: Int
    let alpha: [UInt8]
    /// Each letter's left edge and width in the picture, px: I, N, V, I, Z.
    let spans: [[Double]]
    /// «0» and «1» side by side, 128 × 64, coverage.
    let digits: [UInt8]
    /// The points of the strokes of 0…9, A…F, each (x, y) within about ±0.33 × ±0.5 (y up).
    let glyphs: [[Float]]

    /// The letters' height in the picture, px; the baseline; the picture's height; the word's left edge.
    static let cap: Double = 300
    static let base: Double = 360
    static let pictureHeight: Int = 420
    static let left: Double = 30
    /// Scene units per px: the letters are 10 high.
    static let unit: Double = 10.0 / cap
    static let digitsW: Int = 128
    static let digitsH: Int = 64
    static let signs: [String] = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "A", "B", "C", "D", "E", "F"]

    /// The app's sign, N: the three pieces of the app icon's mark, traced into outlines, 474 × 442, y down.
    static let markPieces: [[Double]] = [
        [331, 69, 337, 56, 346, 48, 448, 2, 457, 1, 462, 2, 468, 6, 473, 17, 473, 304, 471, 310, 467, 313, 460, 313, 458, 312, 433, 286, 333, 175, 331, 170],
        [0, 34, 2, 27, 6, 19, 15, 11, 22, 7, 30, 5, 114, 5, 125, 8, 134, 13, 154, 33, 237, 122, 466, 377, 471, 386, 473, 395, 473, 402, 471, 411, 464, 424, 452, 435, 443, 439, 429, 442, 372, 442, 360, 440, 351, 436, 346, 432, 5, 55, 0, 44],
        [0, 133, 2, 128, 5, 125, 13, 125, 36, 147, 133, 250, 135, 257, 135, 381, 134, 386, 131, 392, 121, 401, 25, 440, 13, 440, 5, 435, 0, 426],
    ]
    static let markW: Double = 474
    static let markH: Double = 442

    init(width: Int, height: Int, alpha: [UInt8], spans: [[Double]], digits: [UInt8], glyphs: [[Float]]) {
        self.width = width
        self.height = height
        self.alpha = alpha
        self.spans = spans
        self.digits = digits
        self.glyphs = glyphs
    }

    /// The word's right end in the picture, px.
    var wordEnd: Double { return spans[4][0] + spans[4][1] }

    func covered(_ px: Double, _ py: Double) -> Bool {
        let x = Int(px)
        let y = Int(py)
        if x < 0 || y < 0 || x >= width || y >= height { return false }
        return alpha[y * width + x] > 127
    }

    /// The word as an image (white, with its coverage), for the still stages.
    func image() -> CGImage? {
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        for i in 0..<(width * height) {
            let a = alpha[i]
            pixels[4 * i] = a
            pixels[4 * i + 1] = a
            pixels[4 * i + 2] = a
            pixels[4 * i + 3] = a
        }
        guard let provider = CGDataProvider(data: Data(pixels) as CFData) else { return nil }
        return CGImage(
            width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent
        )
    }

    /// A grey picture to draw into with white: a byte of the result is the coverage, row 0 is the top.
    private static func coverage(width: Int, height: Int, draw: (CGContext) -> Void) -> [UInt8]? {
        guard width > 0, height > 0, let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return nil }
        context.setFillColor(gray: 0, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.setFillColor(gray: 1, alpha: 1)
        context.textMatrix = CGAffineTransform.identity
        draw(context)
        guard let data = context.data else { return nil }
        let row = context.bytesPerRow
        let bytes = data.bindMemory(to: UInt8.self, capacity: row * height)
        var out = [UInt8](repeating: 0, count: width * height)
        for y in 0..<height {
            for x in 0..<width { out[y * width + x] = bytes[y * row + x] }
        }
        return out
    }

    /// A line of text that takes its colour from the picture it is drawn into.
    private static func line(_ text: String, _ font: CTFont) -> CTLine {
        let attributes: [NSAttributedString.Key: Any] = [
            NSAttributedString.Key(rawValue: kCTFontAttributeName as String): font,
            NSAttributedString.Key(rawValue: kCTForegroundColorFromContextAttributeName as String): true,
        ]
        let words = NSAttributedString(string: text, attributes: attributes)
        return CTLineCreateWithAttributedString(words as CFAttributedString)
    }

    private static func advance(_ line: CTLine) -> Double {
        return Double(CTLineGetTypographicBounds(line, nil, nil, nil))
    }

    /// Draws the line with its left end at `x` and its baseline `baseline` px from the top of a picture `height` high.
    private static func put(_ line: CTLine, _ context: CGContext, x: Double, baseline: Double, height: Int) {
        context.textPosition = CGPoint(x: x, y: Double(height) - baseline)
        CTLineDraw(line, context)
    }

    /// Made on the main thread (it asks for the app's fonts). Nil if a picture cannot be made.
    static func make() -> IntroArt? {
        // The size at which a capital is `cap` px high.
        let probe = Theme.title(300)
        let size = 300 * cap / Swift.max(1, Double(probe.capHeight))
        let face = Theme.title(CGFloat(size)) as CTFont
        let gap = size * 0.13
        let signWidth = cap * markW / markH

        let word = ["I", "N", "V", "I", "Z"]
        var lines: [CTLine] = []
        var spans: [[Double]] = []
        var x = left
        for i in 0..<5 {
            let one = line(word[i], face)
            lines.append(one)
            let w = i == 1 ? signWidth : advance(one)
            spans.append([x, w])
            x += w + gap
        }
        let width = Int((x - gap + left).rounded()) + 1
        let letters = lines
        let places = spans
        let drawn = coverage(width: width, height: pictureHeight, draw: { (context: CGContext) -> Void in
            for i in 0..<5 {
                if i != 1 {
                    put(letters[i], context, x: places[i][0], baseline: base, height: pictureHeight)
                    continue
                }
                // N: the sign's three pieces, as high as a capital.
                let scale = cap / markH
                for piece in markPieces {
                    context.beginPath()
                    for k in 0..<(piece.count / 2) {
                        let point = CGPoint(x: places[1][0] + piece[2 * k] * scale, y: Double(pictureHeight) - (base - cap + piece[2 * k + 1] * scale))
                        if k == 0 { context.move(to: point) } else { context.addLine(to: point) }
                    }
                    context.closePath()
                    context.fillPath()
                }
            }
        })
        guard let alpha = drawn else { return nil }

        // The two digits and the cipher's signs: the system's monospace, bold.
        let mono = UIFont.monospacedSystemFont(ofSize: 58, weight: .bold) as CTFont
        let nought = line("0", mono)
        let one = line("1", mono)
        let two = coverage(width: digitsW, height: digitsH, draw: { (context: CGContext) -> Void in
            put(nought, context, x: 32 - advance(nought) / 2, baseline: 54, height: digitsH)
            put(one, context, x: 96 - advance(one) / 2, baseline: 54, height: digitsH)
        })
        guard let digits = two else { return nil }

        var glyphs: [[Float]] = []
        for sign in signs {
            let drawnSign = line(sign, mono)
            let cell = coverage(width: 40, height: 60, draw: { (context: CGContext) -> Void in
                put(drawnSign, context, x: 20 - advance(drawnSign) / 2, baseline: 52, height: 60)
            })
            var points: [Float] = []
            if let cell {
                for y in 0..<60 {
                    for px in 0..<40 where cell[y * 40 + px] > 120 {
                        points.append(Float(px - 20) / 60)
                        points.append(Float(30 - y) / 60)
                    }
                }
            }
            if points.isEmpty { points = [0, 0] }
            glyphs.append(points)
        }
        return IntroArt(width: width, height: pictureHeight, alpha: alpha, spans: spans, digits: digits, glyphs: glyphs)
    }
}

/// The intro's scene as numbers for the graphics chip: every particle's two places (in N, in the cipher) and the
/// squares the letters fall into. Built once from the word's picture; the same on every start. All motion is then
/// computed by the vertex shaders from these. Android: intro/IntroScene.kt (IntroGeometry).
final class IntroGeometry {
    /// Per particle `particle` numbers: its place in N (3), its place in the cipher (3), three chances and whether it
    /// belongs to N (4), its light in N and in the cipher (2). N's own particles come first.
    let particles: [Float]
    let count: Int
    let ownCount: Int
    /// Per corner of each square (six corners) `tile` numbers: the corner (2), the square's middle (2), when it leaves
    /// (1), which way (3) and how far (1).
    let tiles: [Float]
    let tileCount: Int
    /// The word's ends and N's sides (N's middle is x 0).
    let left: Float
    let right: Float
    let signLeft: Float
    let signRight: Float
    /// The two fronts: where each starts (outside the word) and ends (at N's side).
    let rightFrom: Float
    let rightTo: Float
    let leftFrom: Float
    let leftTo: Float
    /// The word's picture in the scene: x from, x to, y from (bottom), y to (top).
    let rect: [Float]

    static let particle: Int = 12
    static let tile: Int = 9
    /// The honeycomb N is made of: the cells' outer radius.
    static let cellRadius: Double = 0.62
    /// The squares: a letter is 17 of them high; each is drawn at 0.8 of its place.
    static let square: Double = 10.0 / 17
    static let squareFill: Double = 0.8
    /// The cipher's layers, how far behind N.
    static let layers: [Double] = [-34.0, -58.0, -82.0, -112.0, -138.0]

    init(particles: [Float], count: Int, ownCount: Int, tiles: [Float], tileCount: Int, left: Float, right: Float, signLeft: Float, signRight: Float,
         rightFrom: Float, rightTo: Float, leftFrom: Float, leftTo: Float, rect: [Float]) {
        self.particles = particles
        self.count = count
        self.ownCount = ownCount
        self.tiles = tiles
        self.tileCount = tileCount
        self.left = left
        self.right = right
        self.signLeft = signLeft
        self.signRight = signRight
        self.rightFrom = rightFrom
        self.rightTo = rightTo
        self.leftFrom = leftFrom
        self.leftTo = leftTo
        self.rect = rect
    }

    /// The nearest whole number, halves upward.
    private static func round(_ x: Double) -> Double { return (x + 0.5).rounded(.down) }

    /// Whether a point lies on the lines of the honeycomb (pointy-top cells of outer radius `r`).
    static func onLine(_ x: Double, _ y: Double, _ r: Double) -> Bool {
        let w = r * 3.0.squareRoot()
        let row = round(y / (r * 1.5))
        let odd = Int(row) % 2 != 0
        let off = odd ? w / 2 : 0.0
        let cx = round((x - off) / w) * w + off
        let cy = row * r * 1.5
        let dx = abs(x - cx)
        let dy = abs(y - cy)
        return Swift.max(dx * 0.866 + dy * 0.5, dx) > w * 0.5 * 0.84
    }

    /// The seeded chance of a square, by its middle and a number.
    private static func chance(_ cx: Double, _ cy: Double, _ k: Double) -> Double {
        let v = sin(cx * 127.1 + cy * 311.7 + k * 19.19) * 43758.5453
        return v - v.rounded(.down)
    }

    static func build(art: IntroArt, count: Int, seed: UInt32 = 21) -> IntroGeometry {
        var random = IntroModel.Random(seed: seed)
        let unit = IntroArt.unit
        let base = IntroArt.base
        let cap = IntroArt.cap
        let signX = art.spans[1][0]
        let signW = art.spans[1][1]
        let ox = signX + signW / 2
        let left = (IntroArt.left - ox) * unit
        let right = (art.wordEnd - ox) * unit

        // A point of N: mostly on the honeycomb's lines, some inside the cells.
        var pointX = 0.0
        var pointY = 5.0
        var pointLine = false
        func sign() {
            for _ in 0..<400 {
                let px = signX + random.next() * signW
                let py = base - cap + random.next() * cap
                if !art.covered(px, py) { continue }
                let x = (px - ox) * unit
                let y = (base - py) * unit
                let line = onLine(x, y, cellRadius)
                if !line && random.next() < 0.72 { continue }
                pointX = x; pointY = y; pointLine = line
                return
            }
            pointX = 0; pointY = 5; pointLine = false
        }
        var signLeft = 1e9
        var signRight = -1e9
        for _ in 0..<4000 {
            sign()
            signLeft = Swift.min(signLeft, pointX)
            signRight = Swift.max(signRight, pointX)
        }
        let rightFrom = right + 0.6
        let rightTo = signRight + 0.2
        let leftFrom = left - 0.6
        let leftTo = signLeft - 0.2

        // The cipher: rows of signs on each layer, in groups of two or four with gaps; one in six is bright.
        // Six numbers a sign: x, y, z, size, which sign, light.
        var cells: [Double] = []
        for l in 0..<layers.count {
            let z = layers[l]
            let size = 2.6 + Double(l % 3) * 0.7
            let stepX = size * 0.66
            let stepY = size * 1.25
            var y = -34.0
            while y <= 34.0 {
                var x = -22 + random.next() * 2
                while x < 22 {
                    let n = random.next() < 0.5 ? 2 : 4
                    let on = random.next() < 0.6
                    for _ in 0..<n {
                        if on {
                            // The order of the draws is the order of the numbers.
                            let cz = z + (random.next() - 0.5) * 1.5
                            let which = (random.next() * 16).rounded(.down)
                            let light = random.next() < 0.16 ? 1.0 : 0.42
                            cells.append(x); cells.append(y); cells.append(cz); cells.append(size); cells.append(which); cells.append(light)
                        }
                        x += stepX
                    }
                    x += stepX * 0.8
                }
                y += stepY
            }
        }
        let cellCount = Swift.max(1, cells.count / 6)
        if cells.isEmpty { cells = [0, 0, layers[0], 2.6, 0, 0.42] }

        let own = count / 4
        var particles = [Float](repeating: 0, count: count * particle)
        for i in 0..<count {
            let o = i * particle
            sign()
            particles[o] = Float(pointX)
            particles[o + 1] = Float(pointY)
            particles[o + 2] = Float((random.next() - 0.5) * 1.9)
            let light = pointLine ? 1.0 : 0.3
            let c = Swift.min(cellCount - 1, Int(random.next() * Double(cellCount))) * 6
            let strokes = art.glyphs[Swift.max(0, Swift.min(art.glyphs.count - 1, Int(cells[c + 4])))]
            let q = Swift.min(strokes.count / 2 - 1, Int(random.next() * Double(strokes.count / 2)))
            particles[o + 3] = Float(cells[c] + Double(strokes[2 * q]) * cells[c + 3] + (random.next() - 0.5) * 0.03)
            particles[o + 4] = Float(IntroModel.nY + cells[c + 1] + Double(strokes[2 * q + 1]) * cells[c + 3] + (random.next() - 0.5) * 0.03)
            particles[o + 5] = Float(cells[c + 2] + (random.next() - 0.5) * 0.2)
            particles[o + 6] = Float(random.next())
            particles[o + 7] = Float(random.next())
            particles[o + 8] = Float(random.next())
            particles[o + 9] = i < own ? 1 : 0
            particles[o + 10] = Float(i < own ? light : Swift.max(light, 0.55))
            particles[o + 11] = Float(cells[c + 5])
        }

        // The squares of I, V, I, Z: each waits a moment behind its front, then leaves along a straight line away from N.
        let step = cap / 17
        var tiles: [Float] = []
        let half = Float(square * squareFill / 2)
        let corners: [Float] = [-half, -half, half, -half, half, half, -half, -half, half, half, -half, half]
        for i in [0, 2, 3, 4] {
            let lx = art.spans[i][0]
            let w = art.spans[i][1]
            var py = base - cap
            while py < base - 0.01 {
                var px = lx
                while px < lx + w {
                    if art.covered(px + step / 2, py + step / 2) {
                        let cx = (px + step / 2 - ox) * unit
                        let cy = (base - py - step / 2) * unit
                        let toRight = cx > 0
                        let reached = toRight
                            ? IntroModel.crumbleStart + IntroModel.rightLength * (rightFrom - cx) / (rightFrom - rightTo)
                            : IntroModel.leftStart + IntroModel.leftLength * (cx - leftFrom) / (leftTo - leftFrom)
                        let leaves = reached + 0.05 + chance(cx, cy, 1) * chance(cx, cy, 1) * 0.5
                        let vx = toRight ? 1.0 : -1.0
                        let vy = (cy - 5) / 5 * 0.22 + (chance(cx, cy, 2) - 0.5) * 0.22
                        let vz = (chance(cx, cy, 3) - 0.5) * 0.35
                        let length = (vx * vx + vy * vy + vz * vz).squareRoot()
                        let fly = 9 + chance(cx, cy, 4) * chance(cx, cy, 4) * 46
                        for corner in 0..<6 {
                            tiles.append(corners[2 * corner]); tiles.append(corners[2 * corner + 1])
                            tiles.append(Float(cx)); tiles.append(Float(cy)); tiles.append(Float(leaves))
                            tiles.append(Float(vx / length)); tiles.append(Float(vy / length)); tiles.append(Float(vz / length)); tiles.append(Float(fly))
                        }
                    }
                    px += step
                }
                py += step
            }
        }
        let rect: [Float] = [Float((0 - ox) * unit), Float((Double(art.width) - ox) * unit), Float((base - Double(art.height)) * unit), Float(base * unit)]
        return IntroGeometry(
            particles: particles, count: count, ownCount: own, tiles: tiles, tileCount: tiles.count / (tile * 6),
            left: Float(left), right: Float(right), signLeft: Float(signLeft), signRight: Float(signRight),
            rightFrom: Float(rightFrom), rightTo: Float(rightTo), leftFrom: Float(leftFrom), leftTo: Float(leftTo), rect: rect
        )
    }
}
