import Foundation
import Metal
import QuartzCore
import simd

/// The numbers every program of the intro takes (Intro/IntroShaders.swift, `Uniforms`): three matrices and four groups
/// of four, laid out the same way on both sides.
struct IntroUniforms {
    var view: simd_float4x4 = matrix_identity_float4x4
    var proj: simd_float4x4 = matrix_identity_float4x4
    var both: simd_float4x4 = matrix_identity_float4x4
    var a: SIMD4<Float> = SIMD4<Float>(0, 0, 0, 0)
    var b: SIMD4<Float> = SIMD4<Float>(0, 0, 0, 0)
    var c: SIMD4<Float> = SIMD4<Float>(0, 0, 0, 0)
    var d: SIMD4<Float> = SIMD4<Float>(0, 0, 0, 0)
}

/// The intro's scene drawn with Metal (Intro/IntroSceneView.swift owns the layer it ends on). Light only: everything
/// is added onto a dark page, nothing hides anything. In order: the soft light behind N and the pale line of the
/// floor; the solid word behind its streak of light, with a faint mirror image; the squares the letters fall into;
/// the honeycomb layer; the particles (N, then the cipher, then the far field). Every particle and every square is
/// moved by its vertex shader from numbers given once (Intro/IntroScene.swift), so a frame sends only a few numbers.
/// The picture is drawn into a texture first: a cheap glow is added from two small blurred copies, and at the very
/// end the whole picture is replaced by a small, well blurred, dimmed copy of itself.
/// Android: intro/IntroRenderer.kt — the same order, the same numbers.
final class IntroRenderer {
    private let device: MTLDevice
    private let queue: MTLCommandQueue
    private let geometry: IntroGeometry
    /// The glow (two small blurred copies of the bright parts); off on the weakest phones.
    private let glow: Bool
    /// The scene is drawn no finer than this on the screen's short side, px.
    private let finest: Int

    private let particlePipeline: MTLRenderPipelineState
    private let wordPipeline: MTLRenderPipelineState
    private let tilePipeline: MTLRenderPipelineState
    private let spritePipeline: MTLRenderPipelineState
    private let combPipeline: MTLRenderPipelineState
    private let cutPipeline: MTLRenderPipelineState
    private let softenPipeline: MTLRenderPipelineState
    private let composePipeline: MTLRenderPipelineState

    private let particleBuffer: MTLBuffer
    private let wordBuffer: MTLBuffer
    private let tileBuffer: MTLBuffer
    private let quadBuffer: MTLBuffer
    private let wordTexture: MTLTexture
    private let digitTexture: MTLTexture

    private var scene: MTLTexture?
    private var glowA: MTLTexture?
    private var glowA2: MTLTexture?
    private var glowB: MTLTexture?
    private var glowB2: MTLTexture?
    private var softQ: MTLTexture?
    private var softA: MTLTexture?
    private var softB: MTLTexture?
    /// The screen's size, px.
    private(set) var width: Int = 0
    private(set) var height: Int = 0

    private var camera = IntroModel.Camera()
    private let gainOfCount: Float

    /// The word's ends in scene units.
    var left: Double { return Double(geometry.left) }
    var right: Double { return Double(geometry.right) }

    /// Compiles everything and sends the scene's numbers to the chip. Nil if this phone cannot (the caller falls back
    /// to the still stages); why is left in the log.
    init?(device: MTLDevice, art: IntroArt, geometry: IntroGeometry, glow: Bool, finest: Int) {
        guard let queue = device.makeCommandQueue() else { return nil }
        let library: MTLLibrary
        do {
            library = try device.makeLibrary(source: IntroShaders.source, options: nil)
        } catch {
            NSLog("Linea: the intro's shaders were not made: %@", String(describing: error))
            return nil
        }
        let float = MemoryLayout<Float>.stride
        let particleLayout = IntroRenderer.layout([.float3, .float3, .float4, .float2], [0, 3 * float, 6 * float, 10 * float], stride: IntroGeometry.particle * float)
        let wordLayout = IntroRenderer.layout([.float2, .float2], [0, 2 * float], stride: 4 * float)
        let tileLayout = IntroRenderer.layout([.float2, .float3, .float4], [0, 2 * float, 5 * float], stride: IntroGeometry.tile * float)
        let quadLayout = IntroRenderer.layout([.float2], [0], stride: 2 * float)
        guard
            let particlePipeline = IntroRenderer.pipeline(device, library, "particle_vertex", "particle_fragment", particleLayout, additive: true),
            let wordPipeline = IntroRenderer.pipeline(device, library, "word_vertex", "word_fragment", wordLayout, additive: true),
            let tilePipeline = IntroRenderer.pipeline(device, library, "tile_vertex", "tile_fragment", tileLayout, additive: true),
            let spritePipeline = IntroRenderer.pipeline(device, library, "sprite_vertex", "sprite_fragment", quadLayout, additive: true),
            let combPipeline = IntroRenderer.pipeline(device, library, "sprite_vertex", "comb_fragment", quadLayout, additive: true),
            let cutPipeline = IntroRenderer.pipeline(device, library, "whole_vertex", "cut_fragment", nil, additive: false),
            let softenPipeline = IntroRenderer.pipeline(device, library, "whole_vertex", "soften_fragment", nil, additive: false),
            let composePipeline = IntroRenderer.pipeline(device, library, "whole_vertex", "compose_fragment", nil, additive: false)
        else { return nil }

        // The word's picture as a flat sheet in the scene: the place (2) and the place in the picture (2) of each corner.
        let r = geometry.rect
        let sheet: [Float] = [
            r[0], r[2], 0, 1, r[1], r[2], 1, 1, r[1], r[3], 1, 0,
            r[0], r[2], 0, 1, r[1], r[3], 1, 0, r[0], r[3], 0, 0,
        ]
        let quad: [Float] = [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5]
        let squares: [Float] = geometry.tiles.isEmpty ? [Float](repeating: 0, count: IntroGeometry.tile) : geometry.tiles
        guard
            geometry.count > 0,
            let particleBuffer = IntroRenderer.buffer(device, geometry.particles),
            let wordBuffer = IntroRenderer.buffer(device, sheet),
            let tileBuffer = IntroRenderer.buffer(device, squares),
            let quadBuffer = IntroRenderer.buffer(device, quad),
            let wordTexture = IntroRenderer.picture(device, width: art.width, height: art.height, coverage: art.alpha, mips: true),
            let digitTexture = IntroRenderer.picture(device, width: IntroArt.digitsW, height: IntroArt.digitsH, coverage: art.digits, mips: false)
        else {
            NSLog("Linea: the intro's numbers did not reach the graphics chip")
            return nil
        }

        self.device = device
        self.queue = queue
        self.geometry = geometry
        self.glow = glow
        self.finest = finest
        self.particlePipeline = particlePipeline
        self.wordPipeline = wordPipeline
        self.tilePipeline = tilePipeline
        self.spritePipeline = spritePipeline
        self.combPipeline = combPipeline
        self.cutPipeline = cutPipeline
        self.softenPipeline = softenPipeline
        self.composePipeline = composePipeline
        self.particleBuffer = particleBuffer
        self.wordBuffer = wordBuffer
        self.tileBuffer = tileBuffer
        self.quadBuffer = quadBuffer
        self.wordTexture = wordTexture
        self.digitTexture = digitTexture
        self.gainOfCount = Float(IntroModel.countGain(geometry.count))
    }

    // MARK: Making

    private static func layout(_ formats: [MTLVertexFormat], _ offsets: [Int], stride: Int) -> MTLVertexDescriptor {
        let made = MTLVertexDescriptor()
        for i in 0..<formats.count {
            made.attributes[i].format = formats[i]
            made.attributes[i].offset = offsets[i]
            made.attributes[i].bufferIndex = 0
        }
        made.layouts[0].stride = stride
        made.layouts[0].stepFunction = .perVertex
        made.layouts[0].stepRate = 1
        return made
    }

    /// A program: its two functions, the layout of its corners, and whether what it draws is added to what is there.
    private static func pipeline(_ device: MTLDevice, _ library: MTLLibrary, _ vertex: String, _ fragment: String, _ layout: MTLVertexDescriptor?, additive: Bool) -> MTLRenderPipelineState? {
        guard let vertexFunction = library.makeFunction(name: vertex), let fragmentFunction = library.makeFunction(name: fragment) else {
            NSLog("Linea: the intro's program %@ / %@ is missing", vertex, fragment)
            return nil
        }
        let wanted = MTLRenderPipelineDescriptor()
        wanted.vertexFunction = vertexFunction
        wanted.fragmentFunction = fragmentFunction
        if let layout { wanted.vertexDescriptor = layout }
        wanted.colorAttachments[0].pixelFormat = .bgra8Unorm
        if additive {
            wanted.colorAttachments[0].isBlendingEnabled = true
            wanted.colorAttachments[0].rgbBlendOperation = .add
            wanted.colorAttachments[0].alphaBlendOperation = .add
            wanted.colorAttachments[0].sourceRGBBlendFactor = .one
            wanted.colorAttachments[0].destinationRGBBlendFactor = .one
            wanted.colorAttachments[0].sourceAlphaBlendFactor = .one
            wanted.colorAttachments[0].destinationAlphaBlendFactor = .one
        }
        do {
            return try device.makeRenderPipelineState(descriptor: wanted)
        } catch {
            NSLog("Linea: the intro's program %@ / %@ was not made: %@", vertex, fragment, String(describing: error))
            return nil
        }
    }

    private static func buffer(_ device: MTLDevice, _ numbers: [Float]) -> MTLBuffer? {
        if numbers.isEmpty { return nil }
        return numbers.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) -> MTLBuffer? in
            guard let base = bytes.baseAddress else { return nil }
            return device.makeBuffer(bytes: base, length: bytes.count, options: .storageModeShared)
        }
    }

    /// A picture of one byte a point (the coverage), with its smaller copies when `mips`.
    private static func picture(_ device: MTLDevice, width: Int, height: Int, coverage: [UInt8], mips: Bool) -> MTLTexture? {
        if width <= 0 || height <= 0 || coverage.count < width * height { return nil }
        let wanted = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .r8Unorm, width: width, height: height, mipmapped: mips)
        wanted.usage = .shaderRead
        guard let made = device.makeTexture(descriptor: wanted) else { return nil }
        var level = coverage
        var w = width
        var h = height
        for index in 0..<made.mipmapLevelCount {
            level.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) -> Void in
                if let base = bytes.baseAddress {
                    made.replace(region: MTLRegionMake2D(0, 0, w, h), mipmapLevel: index, withBytes: base, bytesPerRow: w)
                }
            }
            if index + 1 >= made.mipmapLevelCount { break }
            // The next copy: half the size, each point the mean of four.
            let nw = max(1, w / 2)
            let nh = max(1, h / 2)
            var next = [UInt8](repeating: 0, count: nw * nh)
            for y in 0..<nh {
                let y0 = min(h - 1, 2 * y)
                let y1 = min(h - 1, 2 * y + 1)
                for x in 0..<nw {
                    let x0 = min(w - 1, 2 * x)
                    let x1 = min(w - 1, 2 * x + 1)
                    let sum = Int(level[y0 * w + x0]) + Int(level[y0 * w + x1]) + Int(level[y1 * w + x0]) + Int(level[y1 * w + x1])
                    next[y * nw + x] = UInt8((sum + 2) / 4)
                }
            }
            level = next
            w = nw
            h = nh
        }
        return made
    }

    /// The screen is `w` × `h` px now (also after a rotation): the textures the picture is drawn into are made anew.
    func resize(width w: Int, height h: Int) {
        width = max(1, w)
        height = max(1, h)
        let scale = min(1.0, Double(finest) / Double(min(width, height)))
        let sw = max(16, Int((Double(width) * scale).rounded()))
        let sh = max(16, Int((Double(height) * scale).rounded()))
        scene = target(sw, sh)
        if glow {
            glowA = target(sw / 4, sh / 4)
            glowA2 = target(sw / 4, sh / 4)
            glowB = target(sw / 16, sh / 16)
            glowB2 = target(sw / 16, sh / 16)
        }
        softQ = target(sw / 4, sh / 4)
        softA = target(sw / 16, sh / 16)
        softB = target(sw / 16, sh / 16)
    }

    private func target(_ w: Int, _ h: Int) -> MTLTexture? {
        let wanted = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: max(1, w), height: max(1, h), mipmapped: false)
        wanted.usage = [.renderTarget, .shaderRead]
        wanted.storageMode = .private
        return device.makeTexture(descriptor: wanted)
    }

    // MARK: The camera's matrices

    private static func lookAt(eye: SIMD3<Float>, centre: SIMD3<Float>, up: SIMD3<Float>) -> simd_float4x4 {
        let f = simd_normalize(centre - eye)
        let s = simd_normalize(simd_cross(f, up))
        let u = simd_cross(s, f)
        return simd_float4x4(columns: (
            SIMD4<Float>(s.x, u.x, -f.x, 0),
            SIMD4<Float>(s.y, u.y, -f.y, 0),
            SIMD4<Float>(s.z, u.z, -f.z, 0),
            SIMD4<Float>(-simd_dot(s, eye), -simd_dot(u, eye), simd_dot(f, eye), 1)
        ))
    }

    /// A turn about the view axis, radians.
    private static func turn(_ angle: Float) -> simd_float4x4 {
        let c = cos(angle)
        let s = sin(angle)
        return simd_float4x4(columns: (
            SIMD4<Float>(c, s, 0, 0),
            SIMD4<Float>(-s, c, 0, 0),
            SIMD4<Float>(0, 0, 1, 0),
            SIMD4<Float>(0, 0, 0, 1)
        ))
    }

    /// The perspective for a vertical field of view in degrees; depth runs 0 (near) … 1 (far).
    private static func perspective(fov: Float, aspect: Float, near: Float, far: Float) -> simd_float4x4 {
        let f = 1 / tan(fov * Float.pi / 360)
        return simd_float4x4(columns: (
            SIMD4<Float>(f / aspect, 0, 0, 0),
            SIMD4<Float>(0, f, 0, 0),
            SIMD4<Float>(0, 0, far / (near - far), -1),
            SIMD4<Float>(0, 0, near * far / (near - far), 0)
        ))
    }

    // MARK: A frame

    /// One frame for the ident's time `t`, the progress `p`, the running time `clock`, the speed of the step and the
    /// squares' own time (it runs on a little after the ident, so the last squares finish leaving), onto `drawable`.
    /// False if nothing was drawn.
    func draw(t: Double, p: Double, clock: Double, speed: Double, squares: Double, drawable: CAMetalDrawable) -> Bool {
        guard let into = scene, let commands = queue.makeCommandBuffer() else { return false }
        let g = geometry
        let aspect = Double(width) / Double(height)
        IntroModel.camera(t: t, p: p, clock: clock, speed: speed, left: Double(g.left), right: Double(g.right), aspect: aspect, out: &camera)
        let view = IntroRenderer.lookAt(
            eye: SIMD3<Float>(Float(camera.x), Float(camera.y), Float(camera.z)),
            centre: SIMD3<Float>(Float(camera.lookX), Float(camera.lookY), Float(camera.lookZ)),
            up: SIMD3<Float>(0, 1, 0)
        )
        let turned = IntroRenderer.turn(Float(-camera.roll)) * view
        let projection = IntroRenderer.perspective(fov: Float(camera.fov), aspect: Float(aspect), near: 0.05, far: 2000)
        var u = IntroUniforms()
        u.view = turned
        u.proj = projection
        u.both = projection * turned

        let first = MTLRenderPassDescriptor()
        first.colorAttachments[0].texture = into
        first.colorAttachments[0].loadAction = .clear
        first.colorAttachments[0].storeAction = .store
        first.colorAttachments[0].clearColor = MTLClearColor(red: IntroModel.background[0] / 255, green: IntroModel.background[1] / 255, blue: IntroModel.background[2] / 255, alpha: 1)
        guard let encoder = commands.makeRenderCommandEncoder(descriptor: first) else { return false }

        // The soft light behind N, the pale line where the floor ends, the streak of light.
        let lit = IntroModel.ease((t - 0.4) / 1.2)
        encoder.setRenderPipelineState(spritePipeline)
        encoder.setVertexBuffer(quadBuffer, offset: 0, index: 0)
        let halo = 0.05 * lit * (1 - IntroModel.clamp(p, 0, 1))
        if halo > 0.001 {
            soft(encoder, &u, centre: SIMD3<Float>(0, 5, -6), size: SIMD2<Float>(46, 46), inner: SIMD3<Float>(0.47, 0.63, 1), outer: SIMD3<Float>(0.47, 0.63, 1), opacity: Float(halo))
        }
        let floor = 0.06 * lit * (1 - IntroModel.clamp(p * 1.5, 0, 1))
        if floor > 0.001 {
            soft(encoder, &u, centre: SIMD3<Float>(0, 0.5, -160), size: SIMD2<Float>(520, 10), inner: SIMD3<Float>(0.43, 0.59, 1), outer: SIMD3<Float>(0.43, 0.59, 1), opacity: Float(floor))
        }
        let streak = IntroModel.sweep(t)
        let streakAt = Float(IntroModel.lerp(Double(g.left) - 6.0, Double(g.right) + 6.0, IntroModel.reveal(t)))
        if streak > 0.001 && p <= 0 {
            soft(encoder, &u, centre: SIMD3<Float>(streakAt, 5, 0.5), size: SIMD2<Float>(5, 34), inner: SIMD3<Float>(1, 1, 1), outer: SIMD3<Float>(0.67, 0.78, 1), opacity: Float(streak))
        }

        // The solid word, cut by the two fronts; N stays until it has turned into particles.
        let grain = IntroModel.grain(t)
        if p < 0.3 {
            encoder.setRenderPipelineState(wordPipeline)
            encoder.setVertexBuffer(wordBuffer, offset: 0, index: 0)
            encoder.setFragmentTexture(wordTexture, index: 0)
            let right = IntroModel.rightFront(t)
            let left = IntroModel.leftFront(t)
            let gone = p > 0.02 ? 1 - IntroModel.ease((p - 0.02) / 0.25) : 1.0
            let reveal: Float = t > IntroModel.revealEnd ? 999 : streakAt
            let frontRight = Double(g.rightFrom) + Double(g.rightTo - g.rightFrom) * right - (right >= 1 ? 60 : 0)
            let frontLeft = Double(g.leftFrom) + Double(g.leftTo - g.leftFrom) * left + (left >= 1 ? 60 : 0)
            u.a = SIMD4<Float>(reveal, Float(frontRight), Float(frontLeft), g.signLeft - 0.15)
            u.b = SIMD4<Float>(g.signRight + 0.15, Float((1 - grain) * gone), 1, 0.92)
            u.c = SIMD4<Float>(-1, 0, 0, 0)
            send(encoder, &u)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 6)
            u.b.z = 0
            u.c.x = 1
            send(encoder, &u)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 6)
        }

        // The squares.
        if p < 0.3 && g.tileCount > 0 && squares > IntroModel.crumbleStart - 0.6 && squares < IntroModel.identEnd + 1.5 {
            encoder.setRenderPipelineState(tilePipeline)
            encoder.setVertexBuffer(tileBuffer, offset: 0, index: 0)
            u.a = SIMD4<Float>(Float(squares), 1, 0, 0)
            send(encoder, &u)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: g.tileCount * 6)
            u.a.y = 0
            send(encoder, &u)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: g.tileCount * 6)
        }

        // The honeycomb layer in front of N.
        let layer = IntroModel.shield(p, cameraZ: camera.z)
        if layer > 0.004 {
            encoder.setRenderPipelineState(combPipeline)
            encoder.setVertexBuffer(quadBuffer, offset: 0, index: 0)
            u.a = SIMD4<Float>(0, 5, Float(IntroModel.shieldZ), Float(layer))
            u.b = SIMD4<Float>(90, 90, 0, 0)
            send(encoder, &u)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 6)
        }

        // The particles: N's own while N stands alone, all of them once they spread into the cipher.
        let seen = p > 0 ? 1.0 : grain
        let spread = IntroModel.spread(p)
        if seen > 0.001 {
            encoder.setRenderPipelineState(particlePipeline)
            encoder.setVertexBuffer(particleBuffer, offset: 0, index: 0)
            encoder.setFragmentTexture(digitTexture, index: 0)
            let scale = Double(into.height) / (2 * tan(camera.fov / 2 * Double.pi / 180))
            u.a = SIMD4<Float>(Float(clock.truncatingRemainder(dividingBy: 3600.0)), Float(spread), Float(IntroModel.melt(p)), 1)
            u.b = SIMD4<Float>(Float(scale), 1950 / Float(into.height), Float(IntroModel.gain(t, p)) * gainOfCount, Float(seen))
            u.c = SIMD4<Float>(Float(IntroModel.sharp(p)), 0, 0, 0)
            let many = spread > 0 ? g.count : g.ownCount
            if many > 0 {
                if p < 1.4 {
                    send(encoder, &u)
                    encoder.drawPrimitives(type: .point, vertexStart: 0, vertexCount: many)
                }
                u.a.w = 0
                send(encoder, &u)
                encoder.drawPrimitives(type: .point, vertexStart: 0, vertexCount: many)
            }
        }
        encoder.endEncoding()

        // The glow, the soft end, and the picture onto the screen.
        if let a = glowA, let a2 = glowA2, let b = glowB, let b2 = glowB2 {
            small(commands, from: into, to: a, bright: 1)
            smooth(commands, from: a, to: a2, dx: 1 / Float(a.width), dy: 0)
            smooth(commands, from: a2, to: a, dx: 0, dy: 1 / Float(a.height))
            small(commands, from: a, to: b, bright: 0)
            smooth(commands, from: b, to: b2, dx: 1 / Float(b.width), dy: 0)
            smooth(commands, from: b2, to: b, dx: 0, dy: 1 / Float(b.height))
        }
        let end = IntroModel.blur(p)
        if end > 0.001, let q = softQ, let s = softA, let s2 = softB {
            small(commands, from: into, to: q, bright: 0)
            small(commands, from: q, to: s, bright: 0)
            let k = Float(0.5 + 0.5 * end)
            smooth(commands, from: s, to: s2, dx: 1.5 * k / Float(s.width), dy: 0)
            smooth(commands, from: s2, to: s, dx: 0, dy: 1.5 * k / Float(s.height))
            smooth(commands, from: s, to: s2, dx: 2.5 * k / Float(s.width), dy: 0)
            smooth(commands, from: s2, to: s, dx: 0, dy: 2.5 * k / Float(s.height))
        }
        let bloom: Float = glowA == nil ? 0 : (p <= 0 ? 0.42 : Float(min(1.0, 0.6 + p * 0.6)))
        var last = IntroUniforms()
        last.a = SIMD4<Float>(bloom, Float(IntroModel.flash(p, cameraZ: camera.z)), Float(IntroModel.ease(end / 0.4)), Float(1 - 0.4 * end))
        if width < height {
            last.b = SIMD4<Float>(Float(1 + 2.2 * end), 1, Float(height) / Float(width), 0)
        } else {
            last.b = SIMD4<Float>(Float(1 + 2.2 * end), Float(width) / Float(height), 1, 0)
        }
        whole(commands, &last, to: drawable.texture, pipeline: composePipeline, first: into, second: glowA ?? into, third: glowB ?? into, fourth: softA ?? into)
        commands.present(drawable)
        commands.commit()
        return true
    }

    /// The numbers for the next thing drawn.
    private func send(_ encoder: MTLRenderCommandEncoder, _ u: inout IntroUniforms) {
        let length = MemoryLayout<IntroUniforms>.stride
        encoder.setVertexBytes(&u, length: length, index: 1)
        encoder.setFragmentBytes(&u, length: length, index: 1)
    }

    /// A soft spot of light: a flat sheet at `centre`, `size` wide and high.
    private func soft(_ encoder: MTLRenderCommandEncoder, _ u: inout IntroUniforms, centre: SIMD3<Float>, size: SIMD2<Float>, inner: SIMD3<Float>, outer: SIMD3<Float>, opacity: Float) {
        u.a = SIMD4<Float>(centre.x, centre.y, centre.z, opacity)
        u.b = SIMD4<Float>(size.x, size.y, 0, 0)
        u.c = SIMD4<Float>(inner.x, inner.y, inner.z, 0)
        u.d = SIMD4<Float>(outer.x, outer.y, outer.z, 0)
        send(encoder, &u)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 6)
    }

    /// One pass over a whole texture: `pipeline` reads up to four textures and writes `to`.
    private func whole(_ commands: MTLCommandBuffer, _ u: inout IntroUniforms, to: MTLTexture, pipeline: MTLRenderPipelineState, first: MTLTexture, second: MTLTexture? = nil, third: MTLTexture? = nil, fourth: MTLTexture? = nil) {
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = to
        pass.colorAttachments[0].loadAction = .dontCare
        pass.colorAttachments[0].storeAction = .store
        guard let encoder = commands.makeRenderCommandEncoder(descriptor: pass) else { return }
        encoder.setRenderPipelineState(pipeline)
        encoder.setFragmentTexture(first, index: 0)
        if let second { encoder.setFragmentTexture(second, index: 1) }
        if let third { encoder.setFragmentTexture(third, index: 2) }
        if let fourth { encoder.setFragmentTexture(fourth, index: 3) }
        encoder.setFragmentBytes(&u, length: MemoryLayout<IntroUniforms>.stride, index: 1)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
    }

    /// A four times smaller copy; with `bright` 1 only of the bright parts.
    private func small(_ commands: MTLCommandBuffer, from: MTLTexture, to: MTLTexture, bright: Float) {
        var u = IntroUniforms()
        u.a = SIMD4<Float>(1 / Float(from.width), 1 / Float(from.height), bright, 0)
        whole(commands, &u, to: to, pipeline: cutPipeline, first: from)
    }

    /// One pass of the blur along (dx, dy).
    private func smooth(_ commands: MTLCommandBuffer, from: MTLTexture, to: MTLTexture, dx: Float, dy: Float) {
        var u = IntroUniforms()
        u.a = SIMD4<Float>(dx, dy, 0, 0)
        whole(commands, &u, to: to, pipeline: softenPipeline, first: from)
    }
}
