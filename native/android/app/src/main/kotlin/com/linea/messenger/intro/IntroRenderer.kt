package com.linea.messenger.intro

import android.opengl.GLES30
import android.opengl.Matrix
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.tan

/** The intro's scene drawn with OpenGL ES 3.0 on the thread that owns the context (intro/IntroGlView.kt). Light only:
 *  everything is added onto a dark page, nothing hides anything. In order: the soft light behind N and the pale line
 *  of the floor; the solid word behind its streak of light, with a faint mirror image; the squares the letters fall
 *  into; the honeycomb layer; the particles (N, then the cipher, then the far field). Every particle and every square
 *  is moved by its vertex shader from numbers given once (intro/IntroScene.kt), so a frame sends only a few uniforms.
 *  The picture is drawn into a texture first: a cheap glow is added from two small blurred copies, and at the very
 *  end the whole picture is replaced by a small, well blurred, dimmed copy of itself. */
internal class IntroRenderer(
  private val art: IntroArt,
  private val geometry: IntroGeometry,
  /** The glow (two small blurred copies of the bright parts); off on the weakest phones. */
  private val glow: Boolean,
  /** The scene is drawn no finer than this on the screen's short side, px. */
  private val finest: Int,
) {
  private companion object { const val UNKNOWN = Int.MIN_VALUE }

  private class Target(val width: Int, val height: Int) { var frame = 0; var texture = 0 }

  private var particles = 0; private var word = 0; private var tiles = 0; private var sprite = 0; private var comb = 0
  private var cut = 0; private var soften = 0; private var compose = 0
  private val programs = IntArray(8); private var made = 0
  /** Each program's uniforms' places, found once: UNKNOWN until asked for. */
  private val places = IntArray(8 * 16) { UNKNOWN }
  private val arrays = IntArray(5) // particles, word, tiles, quad, none
  private val buffers = IntArray(4)
  private val textures = IntArray(2) // the word, the digits
  private var scene: Target? = null
  private var glowA: Target? = null; private var glowA2: Target? = null; private var glowB: Target? = null; private var glowB2: Target? = null
  private var softQ: Target? = null; private var softA: Target? = null; private var softB: Target? = null
  private var width = 1; private var height = 1
  private var failed = false

  private val camera = IntroModel.Camera()
  private val view = FloatArray(16); private val turned = FloatArray(16); private val turn = FloatArray(16)
  private val projection = FloatArray(16); private val both = FloatArray(16)
  private val gainOfCount = IntroModel.countGain(geometry.count).toFloat()

  // ---- The shaders ----

  private val head = "#version 300 es\nprecision highp float;\n"

  private val particleVertex = head + """
    layout(location=0) in vec3 pN; layout(location=1) in vec3 pC; layout(location=2) in vec4 rd; layout(location=3) in vec2 info;
    uniform mat4 uView; uniform mat4 uProj; uniform float uT, uBC, uCD, uMirror, uScale, uRef, uGain, uNvis;
    out float vA; out float vS; out float vR; out float vK;
    void main(){
      float own = rd.w;
      // each particle goes a little on its own
      float bc = smoothstep(0., 1., clamp(uBC * 1.45 - rd.y * 0.45, 0., 1.));
      float cd = smoothstep(0., 1., clamp(uCD * 1.5 - rd.z * 0.5, 0., 1.));
      vec3 p = mix(pN, pC, bc);
      float f2 = bc * (1. - bc) * 4.; p += vec3(sin(rd.y * 50. + uT), cos(rd.x * 44. + uT * 1.2), 0.) * f2 * 3.;
      // its place in the far field at the end
      vec3 pD = vec3((fract(rd.x * 71.37 + rd.z * 13.1) - 0.5) * 70., 5. + (fract(rd.y * 53.71 + rd.x * 29.3) - 0.5) * 130., -242. - fract(rd.z * 37.9 + rd.y * 17.7) * 90.);
      p = mix(p, pD, cd);
      float f3 = cd * (1. - cd) * 4.; p += vec3(sin(rd.z * 60. + uT * 1.4), cos(rd.y * 52. + uT), sin(rd.x * 33.)) * f3 * 6.;
      p += vec3(sin(uT * 0.7 + rd.x * 30.), cos(uT * 0.6 + rd.y * 30.), sin(uT * 0.5 + rd.z * 30.)) * 0.035 * (1. + 3. * bc);
      if (uMirror > 0.5) p.y = -p.y;
      vec4 mv = uView * vec4(p, 1.);
      float d = -mv.z;
      float world = mix(mix(0.07, 0.105, bc), 0.03, cd);
      float sz = world * uScale / max(d, 0.05);
      vS = sz * uRef;
      float vis = own > 0.5 ? uNvis : smoothstep(0., 0.35, bc);
      float br = mix(mix(info.x, info.y * 2.1, bc) * vis, 0.3, cd);
      float tw = 0.75 + 0.25 * sin(uT * (2. + rd.x * 4.) + rd.y * 40.);
      float fade = mix(smoothstep(2., 11., d), smoothstep(0.5, 4., d), bc) * (1. - smoothstep(150., 330., d) * 0.75);
      vA = br * tw * fade * uGain * min(1., vS / 1.2) * (uMirror > 0.5 ? 0.22 * (1. - bc) : 1.);
      vR = rd.x; vK = rd.z;
      gl_PointSize = clamp(sz, 1.2 / uRef, 120. / uRef);
      // a particle that gives no light is not drawn at all
      gl_Position = (vA < 0.004 || d < 0.05) ? vec4(2., 2., 2., 1.) : uProj * mv;
    }"""

  private val particleFragment = head + """
    uniform float uSharp; uniform sampler2D uDigits;
    in float vA; in float vS; in float vR; in float vK; out vec4 color;
    void main(){
      float r = length(gl_PointCoord - 0.5);
      float soft = 1. - smoothstep(mix(0.08, 0.4, uSharp), 0.5, r);
      // close up a particle is a nought or a one
      float digit = texture(uDigits, vec2((gl_PointCoord.x * 0.62 + 0.19) * 0.5 + (vK < 0.5 ? 0. : 0.5), gl_PointCoord.y)).r;
      float a = mix(soft, digit, smoothstep(9., 20., vS)) * vA;
      if (a < 0.004) discard;
      color = vec4(mix(vec3(0.62, 0.78, 1.0), vec3(1.0), smoothstep(0.35, 0.9, vR)) * a, 1.);
    }"""

  private val wordVertex = head + """
    layout(location=0) in vec2 aPlace; layout(location=1) in vec2 aUv;
    uniform mat4 uBoth; uniform float uFlip; out vec2 vUv; out vec2 vP;
    void main(){ vUv = aUv; vP = aPlace; gl_Position = uBoth * vec4(aPlace.x, aPlace.y * uFlip, 0., 1.); }"""

  private val wordFragment = head + """
    uniform sampler2D uMap; uniform float uReveal, uFR, uFL, uNL, uNR, uNk, uMir, uK;
    in vec2 vUv; in vec2 vP; out vec4 color;
    void main(){
      // the edge stays sharp however near the camera is
      float t = texture(uMap, vUv).r; float w = clamp(fwidth(t) * 0.75, 0.02, 0.5); float a = clamp((t - 0.5) / (2. * w) + 0.5, 0., 1.);
      float x = vP.x; float own = step(uNL, x) * step(x, uNR);
      float keep = mix(step(x, uFR) * step(uFL, x), uNk, own);
      float rev = 1. - smoothstep(uReveal - 0.6, uReveal + 0.6, x);
      float e = (x - uReveal) / 1.6; float edge = exp(-e * e) * 1.3;
      float v = a * keep * rev * (1. + edge) * uK;
      if (uMir > 0.5) v *= 0.2 * (1. - smoothstep(0., 11., vP.y));
      if (v < 0.004) discard;
      color = vec4(vec3(0.97, 0.985, 1.) * v, 1.);
    }"""

  private val tileVertex = head + """
    layout(location=0) in vec2 aCorner; layout(location=1) in vec3 aHome; layout(location=2) in vec4 aFly;
    uniform mat4 uBoth; uniform float uTime, uMirror; out float vB;
    void main(){
      // it stands in its place behind the front, then leaves along a straight line, shrinking and dimming to nothing
      float u = clamp(uTime - aHome.z, 0., 1.);
      float on = step(aHome.z - 0.5, uTime) * step(u, 0.9999);
      float f = aFly.w * u * u;
      vec3 p = vec3(aHome.xy, 0.) + aFly.xyz * f + vec3(aCorner * sqrt(1. - u), 0.);
      if (uMirror > 0.5) p.y = -p.y;
      vB = on * (1. - u * u) * 0.95 * (uMirror > 0.5 ? 0.2 : 1.);
      gl_Position = on > 0.5 ? uBoth * vec4(p, 1.) : vec4(2., 2., 2., 1.);
    }"""

  private val tileFragment = head + "in float vB; out vec4 color; void main(){ color = vec4(vec3(vB), 1.); }"

  private val spriteVertex = head + """
    layout(location=0) in vec2 aPlace;
    uniform mat4 uBoth; uniform vec3 uCentre; uniform vec2 uSize; out vec2 vUv;
    void main(){ vUv = aPlace * 2.; gl_Position = uBoth * vec4(uCentre + vec3(aPlace * uSize, 0.), 1.); }"""

  private val spriteFragment = head + """
    uniform vec3 uInner; uniform vec3 uOuter; uniform float uOpacity; in vec2 vUv; out vec4 color;
    void main(){ float a = max(0., 1. - length(vUv)); color = vec4(mix(uOuter, uInner, a) * a * uOpacity, 1.); }"""

  private val combFragment = head + """
    uniform float uOpacity; in vec2 vUv; out vec4 color;
    void main(){
      // thin lines of a honeycomb with a little light round them
      vec2 p = vUv * 45.; float r = 2.6; float w = r * 1.7320508; vec2 s = vec2(w, 3. * r);
      vec2 a = mod(p, s) - s * 0.5; vec2 b = mod(p + s * 0.5, s) - s * 0.5; vec2 q = abs(dot(a, a) < dot(b, b) ? a : b);
      float d = w * 0.5 - max(q.x, q.x * 0.5 + q.y * 0.8660254);
      float line = 1. - smoothstep(0.057, 0.057 + max(fwidth(d), 0.001), d);
      float light = 0.3 * exp(-d * d / 0.07);
      float v = uOpacity * (1. - smoothstep(0.8, 1., max(abs(vUv.x), abs(vUv.y))));
      color = vec4((vec3(0.875, 0.918, 1.) * line + vec3(0.56, 0.706, 1.) * light) * v, 1.);
    }"""

  private val wholeVertex = head + """
    out vec2 vUv;
    void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUv = p; gl_Position = vec4(p * 2. - 1., 0., 1.); }"""

  private val cutFragment = head + """
    uniform sampler2D uTex; uniform vec2 uTexel; uniform float uCut; in vec2 vUv; out vec4 color;
    void main(){
      vec3 c = (texture(uTex, vUv + uTexel * vec2(-1., -1.)).rgb + texture(uTex, vUv + uTexel * vec2(1., -1.)).rgb
        + texture(uTex, vUv + uTexel * vec2(-1., 1.)).rgb + texture(uTex, vUv + uTexel).rgb) * 0.25;
      float l = max(c.r, max(c.g, c.b));
      color = vec4(c * mix(1., smoothstep(0.32, 0.85, l), uCut), 1.);
    }"""

  private val softenFragment = head + """
    uniform sampler2D uTex; uniform vec2 uStep; in vec2 vUv; out vec4 color;
    void main(){
      vec3 c = texture(uTex, vUv).rgb * 0.227;
      c += (texture(uTex, vUv + uStep * 1.385).rgb + texture(uTex, vUv - uStep * 1.385).rgb) * 0.316;
      c += (texture(uTex, vUv + uStep * 3.231).rgb + texture(uTex, vUv - uStep * 3.231).rgb) * 0.0703;
      color = vec4(c, 1.);
    }"""

  private val composeFragment = head + """
    uniform sampler2D uScene; uniform sampler2D uGlowA; uniform sampler2D uGlowB; uniform sampler2D uSoft;
    uniform float uBloom, uFlash, uSoftK, uDim, uLift; uniform vec2 uShape; in vec2 vUv; out vec4 color;
    void main(){
      vec2 c = (vUv - 0.5) * uShape; float r2 = dot(c, c);
      vec3 col = texture(uScene, vUv).rgb;
      col += (texture(uGlowA, vUv).rgb * 0.75 + texture(uGlowB, vUv).rgb * 1.1) * vec3(0.92, 0.97, 1.1) * uBloom;
      col += uFlash * vec3(0.75, 0.86, 1.) * (1. - r2 * 0.6);
      col = max(col, 0.); col = col / (1. + 0.22 * col); col = pow(col, vec3(0.94));
      float l = dot(col, vec3(0.3, 0.59, 0.11)); col = mix(col, col * vec3(0.9, 0.97, 1.12), 0.55 * (1. - l));
      col *= 1. - 0.62 * smoothstep(0.25, 1.5, r2);
      // the soft copy is lifted a little, so the end is a dim haze and not plain black
      col = mix(col, texture(uSoft, vUv).rgb * uLift, uSoftK);
      color = vec4(col * uDim, 1.);
    }"""

  // ---- Making ----

  /** Compiles everything and sends the scene's numbers to the chip. False if this phone cannot (the caller falls
   *  back to the still stages). */
  fun create(): Boolean {
    try {
      particles = program(particleVertex, particleFragment)
      word = program(wordVertex, wordFragment)
      tiles = program(tileVertex, tileFragment)
      sprite = program(spriteVertex, spriteFragment)
      comb = program(spriteVertex, combFragment)
      cut = program(wholeVertex, cutFragment)
      soften = program(wholeVertex, softenFragment)
      compose = program(wholeVertex, composeFragment)
      if (failed) return false

      GLES30.glGenVertexArrays(arrays.size, arrays, 0)
      GLES30.glGenBuffers(buffers.size, buffers, 0)
      val float = 4

      GLES30.glBindVertexArray(arrays[0])
      fill(buffers[0], geometry.particles)
      val particle = IntroGeometry.PARTICLE * float
      attribute(0, 3, particle, 0); attribute(1, 3, particle, 3 * float); attribute(2, 4, particle, 6 * float); attribute(3, 2, particle, 10 * float)

      // The word's picture as a flat sheet in the scene.
      val r = geometry.rect
      GLES30.glBindVertexArray(arrays[1])
      fill(buffers[1], floatArrayOf(
        r[0], r[2], 0f, 1f, r[1], r[2], 1f, 1f, r[1], r[3], 1f, 0f,
        r[0], r[2], 0f, 1f, r[1], r[3], 1f, 0f, r[0], r[3], 0f, 0f,
      ))
      attribute(0, 2, 4 * float, 0); attribute(1, 2, 4 * float, 2 * float)

      GLES30.glBindVertexArray(arrays[2])
      fill(buffers[2], if (geometry.tiles.isEmpty()) FloatArray(IntroGeometry.TILE) else geometry.tiles)
      val tile = IntroGeometry.TILE * float
      attribute(0, 2, tile, 0); attribute(1, 3, tile, 2 * float); attribute(2, 4, tile, 5 * float)

      GLES30.glBindVertexArray(arrays[3])
      fill(buffers[3], floatArrayOf(-0.5f, -0.5f, 0.5f, -0.5f, 0.5f, 0.5f, -0.5f, -0.5f, 0.5f, 0.5f, -0.5f, 0.5f))
      attribute(0, 2, 2 * float, 0)
      GLES30.glBindVertexArray(0)

      GLES30.glGenTextures(textures.size, textures, 0)
      GLES30.glPixelStorei(GLES30.GL_UNPACK_ALIGNMENT, 1)
      picture(textures[0], art.width, art.height, art.alpha, mips = true)
      picture(textures[1], IntroArt.DIGITS_W, IntroArt.DIGITS_H, art.digits, mips = false)
      return GLES30.glGetError() == GLES30.GL_NO_ERROR
    } catch (_: Throwable) {
      return false
    }
  }

  private fun program(vertex: String, fragment: String): Int {
    val made = GLES30.glCreateProgram()
    val shaders = intArrayOf(shader(GLES30.GL_VERTEX_SHADER, vertex), shader(GLES30.GL_FRAGMENT_SHADER, fragment))
    var good = made != 0 && shaders[0] != 0 && shaders[1] != 0
    if (good) {
      GLES30.glAttachShader(made, shaders[0]); GLES30.glAttachShader(made, shaders[1])
      GLES30.glLinkProgram(made)
      val status = IntArray(1)
      GLES30.glGetProgramiv(made, GLES30.GL_LINK_STATUS, status, 0)
      good = status[0] == GLES30.GL_TRUE
    }
    for (one in shaders) if (one != 0) GLES30.glDeleteShader(one)
    if (!good) { if (made != 0) GLES30.glDeleteProgram(made); failed = true; return 0 }
    if (this.made < programs.size) programs[this.made++] = made
    return made
  }

  private fun shader(kind: Int, source: String): Int {
    val made = GLES30.glCreateShader(kind)
    if (made == 0) return 0
    GLES30.glShaderSource(made, source)
    GLES30.glCompileShader(made)
    val status = IntArray(1)
    GLES30.glGetShaderiv(made, GLES30.GL_COMPILE_STATUS, status, 0)
    if (status[0] != GLES30.GL_TRUE) { GLES30.glDeleteShader(made); return 0 }
    return made
  }

  private fun fill(buffer: Int, numbers: FloatArray) {
    val bytes = ByteBuffer.allocateDirect(numbers.size * 4).order(ByteOrder.nativeOrder())
    bytes.asFloatBuffer().put(numbers)
    GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, buffer)
    GLES30.glBufferData(GLES30.GL_ARRAY_BUFFER, numbers.size * 4, bytes, GLES30.GL_STATIC_DRAW)
  }

  private fun attribute(index: Int, size: Int, stride: Int, offset: Int) {
    GLES30.glEnableVertexAttribArray(index)
    GLES30.glVertexAttribPointer(index, size, GLES30.GL_FLOAT, false, stride, offset)
  }

  private fun picture(texture: Int, w: Int, h: Int, coverage: ByteArray, mips: Boolean) {
    GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texture)
    GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_R8, w, h, 0, GLES30.GL_RED, GLES30.GL_UNSIGNED_BYTE, ByteBuffer.wrap(coverage))
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, if (mips) GLES30.GL_LINEAR_MIPMAP_LINEAR else GLES30.GL_LINEAR)
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)
    if (mips) GLES30.glGenerateMipmap(GLES30.GL_TEXTURE_2D)
  }

  /** The screen is `w` × `h` px now (also after a rotation): the textures the picture is drawn into are made anew. */
  fun resize(w: Int, h: Int) {
    width = max(1, w); height = max(1, h)
    drop()
    val scale = min(1f, finest.toFloat() / min(width, height))
    val sw = max(16, (width * scale).roundToInt()); val sh = max(16, (height * scale).roundToInt())
    scene = target(sw, sh)
    if (glow) {
      glowA = target(sw / 4, sh / 4); glowA2 = target(sw / 4, sh / 4)
      glowB = target(sw / 16, sh / 16); glowB2 = target(sw / 16, sh / 16)
    }
    softQ = target(sw / 4, sh / 4); softA = target(sw / 16, sh / 16); softB = target(sw / 16, sh / 16)
    GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
  }

  private fun target(w: Int, h: Int): Target {
    val made = Target(max(1, w), max(1, h))
    val one = IntArray(1)
    GLES30.glGenTextures(1, one, 0); made.texture = one[0]
    GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, made.texture)
    GLES30.glTexImage2D(GLES30.GL_TEXTURE_2D, 0, GLES30.GL_RGBA8, made.width, made.height, 0, GLES30.GL_RGBA, GLES30.GL_UNSIGNED_BYTE, null)
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
    GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)
    GLES30.glGenFramebuffers(1, one, 0); made.frame = one[0]
    GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, made.frame)
    GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0, GLES30.GL_TEXTURE_2D, made.texture, 0)
    return made
  }

  private fun drop() {
    val one = IntArray(1)
    for (t in arrayOf(scene, glowA, glowA2, glowB, glowB2, softQ, softA, softB)) {
      if (t == null) continue
      one[0] = t.frame; GLES30.glDeleteFramebuffers(1, one, 0)
      one[0] = t.texture; GLES30.glDeleteTextures(1, one, 0)
    }
    scene = null; glowA = null; glowA2 = null; glowB = null; glowB2 = null; softQ = null; softA = null; softB = null
  }

  /** Everything made here is given back (the context is still current). */
  fun release() {
    try {
      drop()
      for (i in 0 until made) GLES30.glDeleteProgram(programs[i])
      made = 0; places.fill(UNKNOWN)
      GLES30.glDeleteVertexArrays(arrays.size, arrays, 0)
      GLES30.glDeleteBuffers(buffers.size, buffers, 0)
      GLES30.glDeleteTextures(textures.size, textures, 0)
    } catch (_: Throwable) { /* the context is going anyway */ }
  }

  // ---- A frame ----

  /** A uniform's place, looked up once (`name` is one of the fixed names below, by its number). */
  private fun at(program: Int, id: Int, name: String): Int {
    var index = 0
    while (index < made && programs[index] != program) index++
    val slot = index * 16 + id
    if (places[slot] == UNKNOWN) places[slot] = GLES30.glGetUniformLocation(program, name)
    return places[slot]
  }

  private fun set(program: Int, id: Int, name: String, value: Float) = GLES30.glUniform1f(at(program, id, name), value)

  /** One frame for the ident's time `t`, the progress `p`, the running time `clock`, the speed of the step and the
   *  squares' own time (it runs on a little after the ident, so the last squares finish leaving). */
  fun draw(t: Double, p: Double, clock: Double, speed: Double, squares: Double) {
    val into = scene ?: return
    val g = geometry
    val aspect = width.toDouble() / height
    IntroModel.camera(t, p, clock, speed, g.left.toDouble(), g.right.toDouble(), aspect, camera)
    Matrix.setLookAtM(view, 0, camera.x.toFloat(), camera.y.toFloat(), camera.z.toFloat(), camera.lookX.toFloat(), camera.lookY.toFloat(), camera.lookZ.toFloat(), 0f, 1f, 0f)
    Matrix.setRotateM(turn, 0, (-camera.roll * 180 / PI).toFloat(), 0f, 0f, 1f)
    Matrix.multiplyMM(turned, 0, turn, 0, view, 0)
    Matrix.perspectiveM(projection, 0, camera.fov.toFloat(), aspect.toFloat(), 0.05f, 2000f)
    Matrix.multiplyMM(both, 0, projection, 0, turned, 0)

    GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, into.frame)
    GLES30.glViewport(0, 0, into.width, into.height)
    GLES30.glDisable(GLES30.GL_DEPTH_TEST); GLES30.glDisable(GLES30.GL_CULL_FACE)
    GLES30.glClearColor(5 / 255f, 6 / 255f, 10 / 255f, 1f)
    GLES30.glClear(GLES30.GL_COLOR_BUFFER_BIT)
    GLES30.glEnable(GLES30.GL_BLEND)
    GLES30.glBlendFunc(GLES30.GL_ONE, GLES30.GL_ONE)

    // The soft light behind N, the pale line where the floor ends, the streak of light.
    val lit = IntroModel.ease((t - 0.4) / 1.2)
    GLES30.glUseProgram(sprite)
    GLES30.glBindVertexArray(arrays[3])
    GLES30.glUniformMatrix4fv(at(sprite, 0, "uBoth"), 1, false, both, 0)
    val halo = 0.05 * lit * (1 - IntroModel.clamp(p, 0.0, 1.0))
    if (halo > 0.001) soft(0f, 5f, -6f, 46f, 46f, 0.47f, 0.63f, 1f, 0.47f, 0.63f, 1f, halo.toFloat())
    val floor = 0.06 * lit * (1 - IntroModel.clamp(p * 1.5, 0.0, 1.0))
    if (floor > 0.001) soft(0f, 0.5f, -160f, 520f, 10f, 0.43f, 0.59f, 1f, 0.43f, 0.59f, 1f, floor.toFloat())
    val streak = IntroModel.sweep(t)
    val streakAt = IntroModel.lerp(g.left - 6.0, g.right + 6.0, IntroModel.reveal(t)).toFloat()
    if (streak > 0.001 && p <= 0) soft(streakAt, 5f, 0.5f, 5f, 34f, 1f, 1f, 1f, 0.67f, 0.78f, 1f, streak.toFloat())

    // The solid word, cut by the two fronts; N stays until it has turned into particles.
    val grain = IntroModel.grain(t)
    if (p < 0.3) {
      GLES30.glUseProgram(word)
      GLES30.glBindVertexArray(arrays[1])
      GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
      GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, textures[0])
      GLES30.glUniform1i(at(word, 0, "uMap"), 0)
      GLES30.glUniformMatrix4fv(at(word, 1, "uBoth"), 1, false, both, 0)
      val right = IntroModel.rightFront(t); val left = IntroModel.leftFront(t)
      val gone = if (p > 0.02) 1 - IntroModel.ease((p - 0.02) / 0.25) else 1.0
      set(word, 2, "uReveal", if (t > IntroModel.REVEAL_END) 999f else streakAt)
      set(word, 3, "uFR", (g.rightFrom + (g.rightTo - g.rightFrom) * right - (if (right >= 1) 60 else 0)).toFloat())
      set(word, 4, "uFL", (g.leftFrom + (g.leftTo - g.leftFrom) * left + (if (left >= 1) 60 else 0)).toFloat())
      set(word, 5, "uNL", g.signLeft - 0.15f); set(word, 6, "uNR", g.signRight + 0.15f)
      set(word, 7, "uNk", ((1 - grain) * gone).toFloat()); set(word, 8, "uK", 0.92f)
      set(word, 9, "uMir", 1f); set(word, 10, "uFlip", -1f)
      GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 6)
      set(word, 9, "uMir", 0f); set(word, 10, "uFlip", 1f)
      GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 6)
    }

    // The squares.
    if (p < 0.3 && g.tileCount > 0 && squares > IntroModel.CRUMBLE_START - 0.6 && squares < IntroModel.IDENT_END + 1.5) {
      GLES30.glUseProgram(tiles)
      GLES30.glBindVertexArray(arrays[2])
      GLES30.glUniformMatrix4fv(at(tiles, 0, "uBoth"), 1, false, both, 0)
      set(tiles, 1, "uTime", squares.toFloat())
      set(tiles, 2, "uMirror", 1f)
      GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, g.tileCount * 6)
      set(tiles, 2, "uMirror", 0f)
      GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, g.tileCount * 6)
    }

    // The honeycomb layer in front of N.
    val layer = IntroModel.shield(p, camera.z)
    if (layer > 0.004) {
      GLES30.glUseProgram(comb)
      GLES30.glBindVertexArray(arrays[3])
      GLES30.glUniformMatrix4fv(at(comb, 0, "uBoth"), 1, false, both, 0)
      GLES30.glUniform3f(at(comb, 1, "uCentre"), 0f, 5f, IntroModel.SHIELD_Z.toFloat())
      GLES30.glUniform2f(at(comb, 2, "uSize"), 90f, 90f)
      set(comb, 3, "uOpacity", layer.toFloat())
      GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 6)
    }

    // The particles: N's own while N stands alone, all of them once they spread into the cipher.
    val seen = if (p > 0) 1.0 else grain
    val spread = IntroModel.spread(p)
    if (seen > 0.001) {
      GLES30.glUseProgram(particles)
      GLES30.glBindVertexArray(arrays[0])
      GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
      GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, textures[1])
      GLES30.glUniform1i(at(particles, 0, "uDigits"), 0)
      GLES30.glUniformMatrix4fv(at(particles, 1, "uView"), 1, false, turned, 0)
      GLES30.glUniformMatrix4fv(at(particles, 2, "uProj"), 1, false, projection, 0)
      set(particles, 3, "uT", (clock % 3600.0).toFloat())
      set(particles, 4, "uBC", spread.toFloat())
      set(particles, 5, "uCD", IntroModel.melt(p).toFloat())
      set(particles, 6, "uScale", (into.height / (2 * tan(camera.fov / 2 * PI / 180))).toFloat())
      set(particles, 7, "uRef", 1950f / into.height)
      set(particles, 8, "uGain", (IntroModel.gain(t, p) * gainOfCount).toFloat())
      set(particles, 9, "uNvis", seen.toFloat())
      set(particles, 10, "uSharp", IntroModel.sharp(p).toFloat())
      val many = if (spread > 0) g.count else g.ownCount
      if (p < 1.4) { set(particles, 11, "uMirror", 1f); GLES30.glDrawArrays(GLES30.GL_POINTS, 0, many) }
      set(particles, 11, "uMirror", 0f)
      GLES30.glDrawArrays(GLES30.GL_POINTS, 0, many)
    }

    // The glow, the soft end, and the picture onto the screen.
    GLES30.glDisable(GLES30.GL_BLEND)
    GLES30.glBindVertexArray(arrays[4])
    val a = glowA; val a2 = glowA2; val b = glowB; val b2 = glowB2
    if (a != null && a2 != null && b != null && b2 != null) {
      small(into, a, 1f)
      smooth(a, a2, 1f / a.width, 0f); smooth(a2, a, 0f, 1f / a.height)
      small(a, b, 0f)
      smooth(b, b2, 1f / b.width, 0f); smooth(b2, b, 0f, 1f / b.height)
    }
    val end = IntroModel.blur(p)
    val q = softQ; val s = softA; val s2 = softB
    if (end > 0.001 && q != null && s != null && s2 != null) {
      small(into, q, 0f); small(q, s, 0f)
      val k = (0.5 + 0.5 * end).toFloat()
      smooth(s, s2, 1.5f * k / s.width, 0f); smooth(s2, s, 0f, 1.5f * k / s.height)
      smooth(s, s2, 2.5f * k / s.width, 0f); smooth(s2, s, 0f, 2.5f * k / s.height)
    }
    GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
    GLES30.glViewport(0, 0, width, height)
    GLES30.glUseProgram(compose)
    bind(0, into.texture); bind(1, (a ?: into).texture); bind(2, (b ?: into).texture); bind(3, (s ?: into).texture)
    GLES30.glUniform1i(at(compose, 0, "uScene"), 0); GLES30.glUniform1i(at(compose, 1, "uGlowA"), 1)
    GLES30.glUniform1i(at(compose, 2, "uGlowB"), 2); GLES30.glUniform1i(at(compose, 3, "uSoft"), 3)
    set(compose, 4, "uBloom", if (a == null) 0f else if (p <= 0) 0.42f else min(1.0, 0.6 + p * 0.6).toFloat())
    set(compose, 5, "uFlash", IntroModel.flash(p, camera.z).toFloat())
    set(compose, 6, "uSoftK", IntroModel.ease(end / 0.4).toFloat())
    set(compose, 7, "uDim", (1 - 0.4 * end).toFloat())
    set(compose, 9, "uLift", (1 + 2.2 * end).toFloat())
    if (width < height) GLES30.glUniform2f(at(compose, 8, "uShape"), 1f, height.toFloat() / width)
    else GLES30.glUniform2f(at(compose, 8, "uShape"), width.toFloat() / height, 1f)
    GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
    GLES30.glActiveTexture(GLES30.GL_TEXTURE0)
  }

  private fun soft(x: Float, y: Float, z: Float, w: Float, h: Float, r: Float, g: Float, b: Float, r2: Float, g2: Float, b2: Float, opacity: Float) {
    GLES30.glUniform3f(at(sprite, 1, "uCentre"), x, y, z)
    GLES30.glUniform2f(at(sprite, 2, "uSize"), w, h)
    GLES30.glUniform3f(at(sprite, 3, "uInner"), r, g, b)
    GLES30.glUniform3f(at(sprite, 4, "uOuter"), r2, g2, b2)
    set(sprite, 5, "uOpacity", opacity)
    GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 6)
  }

  private fun bind(unit: Int, texture: Int) {
    GLES30.glActiveTexture(GLES30.GL_TEXTURE0 + unit)
    GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texture)
  }

  /** A four times smaller copy; with `bright` 1 only of the bright parts. */
  private fun small(from: Target, to: Target, bright: Float) {
    GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, to.frame)
    GLES30.glViewport(0, 0, to.width, to.height)
    GLES30.glUseProgram(cut)
    bind(0, from.texture)
    GLES30.glUniform1i(at(cut, 0, "uTex"), 0)
    GLES30.glUniform2f(at(cut, 1, "uTexel"), 1f / from.width, 1f / from.height)
    set(cut, 2, "uCut", bright)
    GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
  }

  /** One pass of the blur along (dx, dy). */
  private fun smooth(from: Target, to: Target, dx: Float, dy: Float) {
    GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, to.frame)
    GLES30.glViewport(0, 0, to.width, to.height)
    GLES30.glUseProgram(soften)
    bind(0, from.texture)
    GLES30.glUniform1i(at(soften, 0, "uTex"), 0)
    GLES30.glUniform2f(at(soften, 1, "uStep"), dx, dy)
    GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)
  }
}
