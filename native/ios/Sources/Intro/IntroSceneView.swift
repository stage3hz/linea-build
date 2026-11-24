import UIKit
import MetalKit

/// The intro's scene on the screen: a Metal layer the scene is drawn onto (Intro/IntroRenderer.swift). It draws only
/// when told (`paint`, once per frame of the screen), so nothing is drawn while the app is away. The scene's numbers
/// and programs are made off the main thread; `onReady` says the first picture is on the screen. If the phone cannot
/// do it, `onFailed` — the caller shows the still stages instead. Android: intro/IntroGlView.kt.
final class IntroSceneView: UIView, MTKViewDelegate {
    /// The first frame has been drawn; the word's ends in scene units.
    var onReady: ((Double, Double) -> Void)?
    var onFailed: (() -> Void)?

    private let canvas: MTKView
    private var renderer: IntroRenderer?
    private var released = false
    private var announced = false
    private var drew = false

    // What to draw.
    private var time: Double = 0
    private var progress: Double = 0
    private var clock: Double = 0
    private var speed: Double = 0
    private var squares: Double = 0

    init(frame: CGRect, device: MTLDevice, art: IntroArt, count: Int, glow: Bool, finest: Int) {
        canvas = MTKView(frame: CGRect(origin: .zero, size: frame.size), device: device)
        super.init(frame: frame)
        isOpaque = true
        isUserInteractionEnabled = false
        backgroundColor = UIColor(red: CGFloat(IntroModel.background[0] / 255), green: CGFloat(IntroModel.background[1] / 255), blue: CGFloat(IntroModel.background[2] / 255), alpha: 1)
        canvas.colorPixelFormat = .bgra8Unorm
        canvas.framebufferOnly = true
        canvas.isOpaque = true
        canvas.isUserInteractionEnabled = false
        canvas.clearColor = MTLClearColor(red: IntroModel.background[0] / 255, green: IntroModel.background[1] / 255, blue: IntroModel.background[2] / 255, alpha: 1)
        // Drawn only when `paint` says so.
        canvas.isPaused = true
        canvas.enableSetNeedsDisplay = false
        canvas.autoResizeDrawable = true
        canvas.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        canvas.delegate = self
        addSubview(canvas)

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let geometry = IntroGeometry.build(art: art, count: count)
            let made = IntroRenderer(device: device, art: art, geometry: geometry, glow: glow, finest: finest)
            DispatchQueue.main.async {
                guard let self, !self.released else { return }
                if let made {
                    self.renderer = made
                } else {
                    self.fail("the scene was not made")
                }
            }
        }
    }

    required init?(coder: NSCoder) { return nil }

    /// Draw this moment (called once per frame of the screen). True if a picture went to the screen.
    @discardableResult
    func paint(t: Double, p: Double, clock: Double, speed: Double, squares: Double) -> Bool {
        if released || renderer == nil { return false }
        time = t
        progress = p
        self.clock = clock
        self.speed = speed
        self.squares = squares
        drew = false
        canvas.draw()
        return drew
    }

    /// The overlay is gone: everything of the graphics chip is given back.
    func letGo() {
        if released { return }
        released = true
        onReady = nil
        onFailed = nil
        canvas.delegate = nil
        canvas.removeFromSuperview()
        renderer = nil
    }

    /// The still stages take over; why is left in the log.
    private func fail(_ why: String) {
        NSLog("Linea: intro: %@", why)
        let tell = onFailed
        letGo()
        tell?()
    }

    // MARK: MTKViewDelegate

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        guard !released, let renderer else { return }
        let size = view.drawableSize
        let w = Int(size.width)
        let h = Int(size.height)
        if w < 1 || h < 1 { return }
        // The screen's size is new (the first frame, a rotation): the textures are made anew.
        if renderer.width != w || renderer.height != h { renderer.resize(width: w, height: h) }
        guard let drawable = view.currentDrawable else { return }
        drew = renderer.draw(t: time, p: progress, clock: clock, speed: speed, squares: squares, drawable: drawable)
        if drew && !announced {
            announced = true
            onReady?(renderer.left, renderer.right)
        }
    }
}
