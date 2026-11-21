import UIKit

/// Effects: what the previous app's `SnowPhone.tsx`, `PixelTrail.tsx` and the `IceLayer` / `SnowBackLayer` /
/// `PixelTrailLayer` of `glass.tsx` did, for this app's screens. The drawing itself is the reference's native code
/// (Effects/SnowEngine.swift, Effects/TrailEngine.swift); this file switches it on and off and tells it where things are:
///  - «Снег» (`snow`): one front surface above everything in the window (caps, what is knocked off, meltwater); the
///    falling snow is drawn by a layer at the back of each screen, behind its content; the ledges it lies on are the
///    Dynamic Island, the bar at the bottom, the glass panels and the round buttons of the screen's header.
///  - «Ледяное стекло» (`ice`): rime along the rim of every glass surface (a view inside the glass, so it clips and
///    moves with it). Independent of the snow and of the animations, as in the reference.
///  - «Пиксельный след» (`pixelTrail`): a layer at the back of each screen, behind its content.
/// Snow and the trail run only while animations are allowed (Effects/Motion.swift). Nothing here ever takes a touch.
///
/// The reference reports the ledges from the components that hold snow (`<SnowLedge id …>`). This app's screens are
/// found as they are: the window is looked at a few times a second while an effect is on, and a rectangle is handed
/// over only once two looks in a row agree (a control that moves or just appeared carries no snow until it rests).
final class EffectsHost: NSObject {
    static let shared = EffectsHost()

    private weak var window: UIWindow?
    private var timer: Timer?
    private let front = SnowOverlayView(frame: .zero)
    private let backs = NSHashTable<UIView>.weakObjects()
    private let rimes = NSHashTable<SnowOverlayView>.weakObjects()
    /// The last look at every ledge (window rectangles) and what the engine was given.
    private var seen: [String: SnowLedgeSpec] = [:]
    private var given: [SnowLedgeSpec] = []
    private var settledAt: CFTimeInterval = 0
    private var snowOn = false
    private var trailOn = false
    private var iceOn = false

    private override init() {
        super.init()
        front.snowRole = 0
        front.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    }

    /// Called once with the app's window (SceneDelegate).
    func attach(_ window: UIWindow) {
        self.window = window
        Motion.start()
        let centre = NotificationCenter.default
        centre.addObserver(self, selector: #selector(update), name: Motion.changed, object: nil)
        centre.addObserver(self, selector: #selector(update), name: DevicePreferences.changed, object: nil)
        centre.addObserver(self, selector: #selector(update), name: ThemeStore.changed, object: nil)
        update()
    }

    /// The switches of «Оформление» as they are now.
    static var wantsSnow: Bool { return allowed && (DevicePreferences.flag("snow") ?? true) && Motion.enabled }
    static var wantsTrail: Bool { return allowed && (DevicePreferences.flag("pixelTrail") ?? true) && Motion.enabled }
    static var wantsIce: Bool { return allowed && (DevicePreferences.flag("ice") ?? true) }

    /// On the simulator the effects run only when a shot asks for them (`-effects 1`): falling snow in every other
    /// screenshot would make them differ from run to run.
    private static var allowed: Bool {
        #if targetEnvironment(simulator)
        return UserDefaults.standard.bool(forKey: "effects")
        #else
        return true
        #endif
    }

    @objc func update() {
        let snow = EffectsHost.wantsSnow, trail = EffectsHost.wantsTrail, ice = EffectsHost.wantsIce
        let dark = Theme.dark
        // White tiles on dark themes, black on light ones (pixelTrailModel.ts, trailColor).
        TrailHub.shared.color = dark ? .white : .black
        if snow || ice { SnowEngine.shared.setDark(dark) }
        if snow != snowOn {
            snowOn = snow
            SnowEngine.shared.setEnabled(snow)
            if snow {
                settledAt = CACurrentMediaTime() + 0.5
                seen = [:]
                given = []
                #if targetEnvironment(simulator)
                let heat = UserDefaults.standard.double(forKey: "snowheat")
                if heat > 0 { SnowEngine.shared.setHeat(heat) }
                #endif
            }
        }
        if trail != trailOn {
            trailOn = trail
            TrailHub.shared.enabled = trail
        }
        iceOn = ice
        let wanted = snow || trail || ice
        if wanted && timer == nil {
            let made = Timer(timeInterval: 0.4, target: self, selector: #selector(look), userInfo: nil, repeats: true)
            RunLoop.main.add(made, forMode: .common)
            timer = made
        } else if !wanted, let running = timer {
            running.invalidate()
            timer = nil
        }
        look()
    }

    // MARK: A look at the window

    @objc private func look() {
        guard let window else { return }
        placeFront(in: window)
        placeBacks(in: window)
        placeRime(in: window)
        if snowOn { reportLedges(in: window) }
    }

    /// The front surface: the window's last subview, above every screen and every presented sheet.
    private func placeFront(in window: UIWindow) {
        guard snowOn else {
            if front.superview != nil { front.removeFromSuperview() }
            return
        }
        if front.superview !== window {
            front.frame = window.bounds
            window.addSubview(front)
        } else if window.subviews.last !== front {
            window.bringSubviewToFront(front)
        }
        if front.frame != window.bounds { front.frame = window.bounds }
    }

    /// The screens on the screen right now: the views of the topmost controllers that have no child of their own on
    /// top (the sections of the shell, a pushed screen, a presented sheet).
    private func screens(in window: UIWindow) -> [UIView] {
        guard var top = window.rootViewController else { return [] }
        var found: [UIView] = []
        while let shown = top.presentedViewController, !shown.isBeingDismissed { top = shown }
        collect(top, into: &found)
        return found
    }

    private func collect(_ controller: UIViewController, into found: inout [UIView]) {
        if let stack = controller as? UINavigationController {
            if let shown = stack.topViewController { collect(shown, into: &found) }
            return
        }
        guard controller.isViewLoaded, controller.view.window != nil else { return }
        let shownChildren = controller.children.filter { (child: UIViewController) -> Bool in
            child.isViewLoaded && child.view.window != nil && !child.view.isHidden && child.view.alpha > 0.01
        }
        if shownChildren.isEmpty {
            found.append(controller.view)
        } else {
            for child in shownChildren { collect(child, into: &found) }
        }
    }

    /// The falling snow and the trail: at the back of each screen, right over its background colour.
    private func placeBacks(in window: UIWindow) {
        let wanted = snowOn || trailOn
        var keep = Set<ObjectIdentifier>()
        if wanted {
            for screen in screens(in: window) {
                let layer = backLayer(of: screen)
                keep.insert(ObjectIdentifier(layer))
            }
        }
        for layer in backs.allObjects where !keep.contains(ObjectIdentifier(layer)) {
            layer.removeFromSuperview()
            backs.remove(layer)
        }
        for layer in backs.allObjects {
            guard let holder = layer as? EffectsBackLayer else { continue }
            holder.show(snow: snowOn, trail: trailOn)
        }
    }

    private func backLayer(of screen: UIView) -> UIView {
        for sub in screen.subviews {
            if let made = sub as? EffectsBackLayer {
                if screen.subviews.first !== made { screen.sendSubviewToBack(made) }
                if made.frame != screen.bounds { made.frame = screen.bounds }
                return made
            }
        }
        let made = EffectsBackLayer(frame: screen.bounds)
        screen.insertSubview(made, at: 0)
        backs.add(made)
        return made
    }

    /// «Ледяное стекло»: a rime view inside every glass surface with a rounded rim.
    private func placeRime(in window: UIWindow) {
        var keep = Set<ObjectIdentifier>()
        if iceOn {
            var glass: [UIVisualEffectView] = []
            gatherGlass(window, depth: 0, into: &glass)
            for surface in glass {
                let radius = EffectsHost.radius(of: surface)
                guard radius > 0, surface.bounds.width >= 24, surface.bounds.height >= 24 else { continue }
                // A backdrop over the whole screen (a menu's dimming) is not a glass surface.
                if surface.bounds.width > window.bounds.width * 0.98 && surface.bounds.height > window.bounds.height * 0.5 { continue }
                var rime: SnowOverlayView? = nil
                for sub in surface.contentView.subviews {
                    if let made = sub as? SnowOverlayView { rime = made }
                }
                if rime == nil {
                    let made = SnowOverlayView(frame: surface.contentView.bounds)
                    made.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                    made.snowRole = 2
                    surface.contentView.insertSubview(made, at: 0)
                    rimes.add(made)
                    rime = made
                }
                if let rime {
                    if rime.snowRadius != Double(radius) { rime.snowRadius = Double(radius) }
                    keep.insert(ObjectIdentifier(rime))
                }
            }
        }
        for rime in rimes.allObjects where !keep.contains(ObjectIdentifier(rime)) {
            // Out of the window (another screen on top) the view stays where it is, asleep; with the setting off it goes.
            if !iceOn || rime.window == nil && rime.superview == nil {
                rime.removeFromSuperview()
                rimes.remove(rime)
            }
        }
    }

    private static func radius(of surface: UIView) -> CGFloat {
        var radius = surface.layer.cornerRadius
        if radius <= 0, let parent = surface.superview, parent.bounds.size == surface.bounds.size { radius = parent.layer.cornerRadius }
        if radius <= 0 && surface.superview is TabBarView { radius = surface.bounds.height / 2 }
        return min(radius, min(surface.bounds.width, surface.bounds.height) / 2)
    }

    /// The glass of the screens (not inside rows of long lists, not hidden).
    private func gatherGlass(_ view: UIView, depth: Int, into found: inout [UIVisualEffectView]) {
        if depth > 40 || view.isHidden || view.alpha < 0.01 { return }
        if view === front || view is EffectsBackLayer || view is SnowOverlayView { return }
        if let glass = view as? UIVisualEffectView {
            found.append(glass)
            return
        }
        if view is UITableViewCell || view is UICollectionViewCell { return }
        for sub in view.subviews { gatherGlass(sub, depth: depth + 1, into: &found) }
    }

    // MARK: Ledges

    private func reportLedges(in window: UIWindow) {
        let now = CACurrentMediaTime()
        guard now >= settledAt else { return }
        var current: [String: SnowLedgeSpec] = [:]
        // The Dynamic Island (snowModel.ts, islandLedge): derived from the top inset, portrait only.
        let size = window.bounds.size
        let top = Double(window.safeAreaInsets.top)
        if size.width > 0 && size.height > size.width && top >= 59 && top <= 70 {
            var island = SnowLedgeSpec()
            island.id = "island"
            island.width = 126
            island.height = 37.33
            island.x = (Double(size.width) - island.width) / 2
            island.y = top - 48
            island.radius = island.height / 2
            island.maxCap = 5
            island.glass = false
            current[island.id] = island
        }
        var holders: [(UIView, Double)] = []
        for screen in screens(in: window) { gatherLedges(screen, depth: 0, window: window, into: &holders) }
        // The bar at the bottom lives on the shell's own view, beside the sections.
        if let root = window.rootViewController {
            var shell = root
            if let stack = root as? UINavigationController, let first = stack.viewControllers.first { shell = first }
            if shell.isViewLoaded, shell.view.window != nil, root.presentedViewController == nil {
                for sub in shell.view.subviews where sub is TabBarView && !sub.isHidden && sub.alpha > 0.01 { holders.append((sub, 7)) }
            }
        }
        for (view, cap) in holders {
            let rect = view.convert(view.bounds, to: window)
            guard rect.width > 8, rect.height > 8, rect.minX.isFinite, rect.minY.isFinite, rect.maxY > 0, rect.minY < size.height else { continue }
            var spec = SnowLedgeSpec()
            spec.id = "v" + String(UInt(bitPattern: ObjectIdentifier(view).hashValue))
            spec.x = Double(rect.minX)
            spec.y = Double(rect.minY)
            spec.width = Double(rect.width)
            spec.height = Double(rect.height)
            let radius = view is TabBarView ? rect.height / 2 : max(view.layer.cornerRadius, EffectsHost.radius(of: view))
            spec.radius = Double(min(radius, rect.height / 2, rect.width / 2))
            spec.maxCap = cap
            spec.glass = true
            current[spec.id] = spec
        }
        // Reported only once two looks in a row agree; a moving or new control is left out until it rests.
        var steady: [SnowLedgeSpec] = []
        for (id, spec) in current {
            if let before = seen[id], EffectsHost.same(before, spec) { steady.append(spec) }
        }
        seen = current
        steady.sort { (a: SnowLedgeSpec, b: SnowLedgeSpec) -> Bool in a.id < b.id }
        let changed = steady.count != given.count || zip(steady, given).contains { (pair: (SnowLedgeSpec, SnowLedgeSpec)) -> Bool in
            pair.0.id != pair.1.id || !EffectsHost.same(pair.0, pair.1)
        }
        if changed {
            given = steady
            SnowEngine.shared.setLedges(steady)
        }
    }

    private static func same(_ a: SnowLedgeSpec, _ b: SnowLedgeSpec) -> Bool {
        return abs(a.x - b.x) < 0.5 && abs(a.y - b.y) < 0.5 && abs(a.width - b.width) < 0.5 && abs(a.height - b.height) < 0.5 && a.radius == b.radius && a.maxCap == b.maxCap
    }

    /// Where snow lies on a screen: glass panels and pills (6 pt caps), round glass buttons (4 pt), and the round
    /// or pill buttons of the header (the upper quarter of the window).
    private func gatherLedges(_ view: UIView, depth: Int, window: UIWindow, into found: inout [(UIView, Double)]) {
        if depth > 40 || view.isHidden || view.alpha < 0.01 { return }
        if view === front || view is EffectsBackLayer || view is SnowOverlayView { return }
        if view is UITableViewCell || view is UICollectionViewCell { return }
        if view is TabBarView { return }
        let size = view.bounds.size
        let round = abs(size.width - size.height) < 2
        if let glass = view as? UIVisualEffectView {
            let radius = EffectsHost.radius(of: glass)
            if radius > 0 && size.height >= 24 && size.height <= 96 && size.width >= 24 && size.width < window.bounds.width * 0.98 {
                found.append((glass, round ? 4 : 6))
            }
            return
        }
        if view is UIControl, size.height >= 28, size.height <= 64, size.width <= 220,
           view.layer.cornerRadius >= min(size.width, size.height) * 0.45,
           let colour = view.backgroundColor, colour.cgColor.alpha > 0.05 {
            let top = view.convert(CGPoint.zero, to: window).y
            if top < window.bounds.height * 0.25 {
                found.append((view, round ? 4 : 6))
                return
            }
        }
        for sub in view.subviews { gatherLedges(sub, depth: depth + 1, window: window, into: &found) }
    }
}

/// The back of one screen: the trail's surface and the falling snow, under everything else on the screen.
final class EffectsBackLayer: UIView {
    private let trail = TrailBackgroundView(frame: .zero)
    private let flakes = SnowOverlayView(frame: .zero)

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        isAccessibilityElement = false
        accessibilityElementsHidden = true
        autoresizingMask = [.flexibleWidth, .flexibleHeight]
        trail.frame = bounds
        trail.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        flakes.frame = bounds
        flakes.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        flakes.snowRole = 1
    }

    required init?(coder: NSCoder) { return nil }

    func show(snow: Bool, trail on: Bool) {
        if on && trail.superview == nil { addSubview(trail) }
        if !on && trail.superview != nil { trail.removeFromSuperview() }
        if snow && flakes.superview == nil { addSubview(flakes) }
        if !snow && flakes.superview != nil { flakes.removeFromSuperview() }
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { return nil }
}
