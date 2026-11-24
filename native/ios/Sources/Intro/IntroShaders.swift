import Foundation

/// The intro's shaders, in the Metal Shading Language, compiled when the scene is made (Intro/IntroRenderer.swift), so
/// the build has no step of its own for them. Every program takes the same block of numbers (`Uniforms`): three
/// matrices and four groups of four, whose meaning each program names at its top.
/// Android: the same programs in intro/IntroRenderer.kt.
enum IntroShaders {
    static let source: String = """
#include <metal_stdlib>
using namespace metal;

struct Uniforms {
    float4x4 view;
    float4x4 proj;
    float4x4 both;
    float4 a;
    float4 b;
    float4 c;
    float4 d;
};

constexpr sampler plainSampler(mag_filter::linear, min_filter::linear, address::clamp_to_edge);
constexpr sampler mipSampler(mag_filter::linear, min_filter::linear, mip_filter::linear, address::clamp_to_edge);

static inline float3 blend3(float3 x, float3 y, float t) { return x + (y - x) * t; }
static inline float2 wrap2(float2 x, float2 y) { return x - y * floor(x / y); }

// ---- The particles ----

struct ParticleIn {
    float3 pN [[attribute(0)]];
    float3 pC [[attribute(1)]];
    float4 rd [[attribute(2)]];
    float2 info [[attribute(3)]];
};

struct ParticleOut {
    float4 position [[position]];
    float size [[point_size]];
    float vA;
    float vS;
    float vR;
    float vK;
};

vertex ParticleOut particle_vertex(ParticleIn in [[stage_in]], constant Uniforms &u [[buffer(1)]]) {
    float uT = u.a.x;
    float uBC = u.a.y;
    float uCD = u.a.z;
    float uMirror = u.a.w;
    float uScale = u.b.x;
    float uRef = u.b.y;
    float uGain = u.b.z;
    float uNvis = u.b.w;
    float3 rd = in.rd.xyz;
    float own = in.rd.w;
    // each particle goes a little on its own
    float bc = smoothstep(0.0, 1.0, clamp(uBC * 1.45 - rd.y * 0.45, 0.0, 1.0));
    float cd = smoothstep(0.0, 1.0, clamp(uCD * 1.5 - rd.z * 0.5, 0.0, 1.0));
    float3 p = blend3(in.pN, in.pC, bc);
    float f2 = bc * (1.0 - bc) * 4.0;
    p += float3(sin(rd.y * 50.0 + uT), cos(rd.x * 44.0 + uT * 1.2), 0.0) * (f2 * 3.0);
    // its place in the far field at the end
    float3 pD = float3((fract(rd.x * 71.37 + rd.z * 13.1) - 0.5) * 70.0, 5.0 + (fract(rd.y * 53.71 + rd.x * 29.3) - 0.5) * 130.0, -242.0 - fract(rd.z * 37.9 + rd.y * 17.7) * 90.0);
    p = blend3(p, pD, cd);
    float f3 = cd * (1.0 - cd) * 4.0;
    p += float3(sin(rd.z * 60.0 + uT * 1.4), cos(rd.y * 52.0 + uT), sin(rd.x * 33.0)) * (f3 * 6.0);
    p += float3(sin(uT * 0.7 + rd.x * 30.0), cos(uT * 0.6 + rd.y * 30.0), sin(uT * 0.5 + rd.z * 30.0)) * (0.035 * (1.0 + 3.0 * bc));
    if (uMirror > 0.5) { p.y = -p.y; }
    float4 mv = u.view * float4(p, 1.0);
    float dist = -mv.z;
    float world = mix(mix(0.07, 0.105, bc), 0.03, cd);
    float sz = world * uScale / max(dist, 0.05);
    float vS = sz * uRef;
    float vis = own > 0.5 ? uNvis : smoothstep(0.0, 0.35, bc);
    float br = mix(mix(in.info.x, in.info.y * 2.1, bc) * vis, 0.3, cd);
    float tw = 0.75 + 0.25 * sin(uT * (2.0 + rd.x * 4.0) + rd.y * 40.0);
    float fade = mix(smoothstep(2.0, 11.0, dist), smoothstep(0.5, 4.0, dist), bc) * (1.0 - smoothstep(150.0, 330.0, dist) * 0.75);
    float mirrored = uMirror > 0.5 ? 0.22 * (1.0 - bc) : 1.0;
    float vA = br * tw * fade * uGain * min(1.0, vS / 1.2) * mirrored;
    ParticleOut out;
    out.vA = vA;
    out.vS = vS;
    out.vR = rd.x;
    out.vK = rd.z;
    out.size = clamp(sz, 1.2 / uRef, 120.0 / uRef);
    // a particle that gives no light is not drawn at all
    if (vA < 0.004 || dist < 0.05) {
        out.position = float4(2.0, 2.0, 2.0, 1.0);
    } else {
        out.position = u.proj * mv;
    }
    return out;
}

fragment float4 particle_fragment(ParticleOut in [[stage_in]], float2 pc [[point_coord]], constant Uniforms &u [[buffer(1)]], texture2d<float> digits [[texture(0)]]) {
    float uSharp = u.c.x;
    float r = length(pc - float2(0.5, 0.5));
    float soft = 1.0 - smoothstep(mix(0.08, 0.4, uSharp), 0.5, r);
    // close up a particle is a nought or a one
    float shift = in.vK < 0.5 ? 0.0 : 0.5;
    float digit = digits.sample(plainSampler, float2((pc.x * 0.62 + 0.19) * 0.5 + shift, pc.y)).r;
    float a = mix(soft, digit, smoothstep(9.0, 20.0, in.vS)) * in.vA;
    if (a < 0.004) { discard_fragment(); }
    float3 tint = blend3(float3(0.62, 0.78, 1.0), float3(1.0, 1.0, 1.0), smoothstep(0.35, 0.9, in.vR));
    return float4(tint * a, 1.0);
}

// ---- The word ----
// a: uReveal, uFR, uFL, uNL.  b: uNR, uNk, uMir, uK.  c.x: uFlip.

struct WordIn {
    float2 place [[attribute(0)]];
    float2 uv [[attribute(1)]];
};

struct WordOut {
    float4 position [[position]];
    float2 uv;
    float2 place;
};

vertex WordOut word_vertex(WordIn in [[stage_in]], constant Uniforms &u [[buffer(1)]]) {
    WordOut out;
    out.uv = in.uv;
    out.place = in.place;
    out.position = u.both * float4(in.place.x, in.place.y * u.c.x, 0.0, 1.0);
    return out;
}

fragment float4 word_fragment(WordOut in [[stage_in]], constant Uniforms &u [[buffer(1)]], texture2d<float> map [[texture(0)]]) {
    float uReveal = u.a.x;
    float uFR = u.a.y;
    float uFL = u.a.z;
    float uNL = u.a.w;
    float uNR = u.b.x;
    float uNk = u.b.y;
    float uMir = u.b.z;
    float uK = u.b.w;
    // the edge stays sharp however near the camera is
    float t = map.sample(mipSampler, in.uv).r;
    float w = clamp(fwidth(t) * 0.75, 0.02, 0.5);
    float a = clamp((t - 0.5) / (2.0 * w) + 0.5, 0.0, 1.0);
    float x = in.place.x;
    float own = step(uNL, x) * step(x, uNR);
    float keep = mix(step(x, uFR) * step(uFL, x), uNk, own);
    float rev = 1.0 - smoothstep(uReveal - 0.6, uReveal + 0.6, x);
    float e = (x - uReveal) / 1.6;
    float edge = exp(-e * e) * 1.3;
    float v = a * keep * rev * (1.0 + edge) * uK;
    if (uMir > 0.5) { v *= 0.2 * (1.0 - smoothstep(0.0, 11.0, in.place.y)); }
    if (v < 0.004) { discard_fragment(); }
    return float4(float3(0.97, 0.985, 1.0) * v, 1.0);
}

// ---- The squares ----
// a.x: uTime, a.y: uMirror.

struct TileIn {
    float2 corner [[attribute(0)]];
    float3 home [[attribute(1)]];
    float4 fly [[attribute(2)]];
};

struct TileOut {
    float4 position [[position]];
    float vB;
};

vertex TileOut tile_vertex(TileIn in [[stage_in]], constant Uniforms &u [[buffer(1)]]) {
    float uTime = u.a.x;
    float uMirror = u.a.y;
    // it stands in its place behind the front, then leaves along a straight line, shrinking and dimming to nothing
    float k = clamp(uTime - in.home.z, 0.0, 1.0);
    float lit = step(in.home.z - 0.5, uTime) * step(k, 0.9999);
    float f = in.fly.w * k * k;
    float3 p = float3(in.home.xy, 0.0) + in.fly.xyz * f + float3(in.corner * sqrt(1.0 - k), 0.0);
    if (uMirror > 0.5) { p.y = -p.y; }
    TileOut out;
    out.vB = lit * (1.0 - k * k) * 0.95 * (uMirror > 0.5 ? 0.2 : 1.0);
    if (lit > 0.5) {
        out.position = u.both * float4(p, 1.0);
    } else {
        out.position = float4(2.0, 2.0, 2.0, 1.0);
    }
    return out;
}

fragment float4 tile_fragment(TileOut in [[stage_in]]) {
    return float4(in.vB, in.vB, in.vB, 1.0);
}

// ---- The soft lights and the honeycomb layer ----
// a.xyz: uCentre, a.w: uOpacity.  b.xy: uSize.  c.xyz: uInner.  d.xyz: uOuter.

struct SpriteIn {
    float2 place [[attribute(0)]];
};

struct SpriteOut {
    float4 position [[position]];
    float2 uv;
};

vertex SpriteOut sprite_vertex(SpriteIn in [[stage_in]], constant Uniforms &u [[buffer(1)]]) {
    SpriteOut out;
    out.uv = in.place * 2.0;
    out.position = u.both * float4(u.a.xyz + float3(in.place * u.b.xy, 0.0), 1.0);
    return out;
}

fragment float4 sprite_fragment(SpriteOut in [[stage_in]], constant Uniforms &u [[buffer(1)]]) {
    float a = max(0.0, 1.0 - length(in.uv));
    return float4(blend3(u.d.xyz, u.c.xyz, a) * (a * u.a.w), 1.0);
}

fragment float4 comb_fragment(SpriteOut in [[stage_in]], constant Uniforms &u [[buffer(1)]]) {
    // thin lines of a honeycomb with a little light round them
    float2 p = in.uv * 45.0;
    float r = 2.6;
    float w = r * 1.7320508;
    float2 s = float2(w, 3.0 * r);
    float2 a = wrap2(p, s) - s * 0.5;
    float2 b = wrap2(p + s * 0.5, s) - s * 0.5;
    float2 q = dot(a, a) < dot(b, b) ? abs(a) : abs(b);
    float d = w * 0.5 - max(q.x, q.x * 0.5 + q.y * 0.8660254);
    float line = 1.0 - smoothstep(0.057, 0.057 + max(fwidth(d), 0.001), d);
    float light = 0.3 * exp(-d * d / 0.07);
    float v = u.a.w * (1.0 - smoothstep(0.8, 1.0, max(abs(in.uv.x), abs(in.uv.y))));
    return float4((float3(0.875, 0.918, 1.0) * line + float3(0.56, 0.706, 1.0) * light) * v, 1.0);
}

// ---- The whole picture: smaller copies, the blur, and the picture onto the screen ----

struct WholeOut {
    float4 position [[position]];
    float2 uv;
};

vertex WholeOut whole_vertex(uint vid [[vertex_id]]) {
    float2 p = float2(float((vid << 1) & 2), float(vid & 2));
    WholeOut out;
    out.uv = float2(p.x, 1.0 - p.y);
    out.position = float4(p * 2.0 - float2(1.0, 1.0), 0.0, 1.0);
    return out;
}

// a.xy: uTexel, a.z: uCut.
fragment float4 cut_fragment(WholeOut in [[stage_in]], constant Uniforms &u [[buffer(1)]], texture2d<float> tex [[texture(0)]]) {
    float2 texel = u.a.xy;
    float3 c = (tex.sample(plainSampler, in.uv + texel * float2(-1.0, -1.0)).rgb + tex.sample(plainSampler, in.uv + texel * float2(1.0, -1.0)).rgb
        + tex.sample(plainSampler, in.uv + texel * float2(-1.0, 1.0)).rgb + tex.sample(plainSampler, in.uv + texel).rgb) * 0.25;
    float l = max(c.r, max(c.g, c.b));
    return float4(c * mix(1.0, smoothstep(0.32, 0.85, l), u.a.z), 1.0);
}

// a.xy: uStep.
fragment float4 soften_fragment(WholeOut in [[stage_in]], constant Uniforms &u [[buffer(1)]], texture2d<float> tex [[texture(0)]]) {
    float2 along = u.a.xy;
    float3 c = tex.sample(plainSampler, in.uv).rgb * 0.227;
    c += (tex.sample(plainSampler, in.uv + along * 1.385).rgb + tex.sample(plainSampler, in.uv - along * 1.385).rgb) * 0.316;
    c += (tex.sample(plainSampler, in.uv + along * 3.231).rgb + tex.sample(plainSampler, in.uv - along * 3.231).rgb) * 0.0703;
    return float4(c, 1.0);
}

// a: uBloom, uFlash, uSoftK, uDim.  b.x: uLift, b.yz: uShape.
fragment float4 compose_fragment(WholeOut in [[stage_in]], constant Uniforms &u [[buffer(1)]], texture2d<float> scene [[texture(0)]],
                                 texture2d<float> glowA [[texture(1)]], texture2d<float> glowB [[texture(2)]], texture2d<float> soft [[texture(3)]]) {
    float uBloom = u.a.x;
    float uFlash = u.a.y;
    float uSoftK = u.a.z;
    float uDim = u.a.w;
    float uLift = u.b.x;
    float2 c = (in.uv - float2(0.5, 0.5)) * u.b.yz;
    float r2 = dot(c, c);
    float3 col = scene.sample(plainSampler, in.uv).rgb;
    col += (glowA.sample(plainSampler, in.uv).rgb * 0.75 + glowB.sample(plainSampler, in.uv).rgb * 1.1) * float3(0.92, 0.97, 1.1) * uBloom;
    col += float3(0.75, 0.86, 1.0) * (uFlash * (1.0 - r2 * 0.6));
    col = max(col, float3(0.0, 0.0, 0.0));
    col = col / (float3(1.0, 1.0, 1.0) + col * 0.22);
    col = pow(col, float3(0.94, 0.94, 0.94));
    float l = dot(col, float3(0.3, 0.59, 0.11));
    col = blend3(col, col * float3(0.9, 0.97, 1.12), 0.55 * (1.0 - l));
    col *= 1.0 - 0.62 * smoothstep(0.25, 1.5, r2);
    // the soft copy is lifted a little, so the end is a dim haze and not plain black
    col = blend3(col, soft.sample(plainSampler, in.uv).rgb * uLift, uSoftK);
    return float4(col * uDim, 1.0);
}
"""
}
