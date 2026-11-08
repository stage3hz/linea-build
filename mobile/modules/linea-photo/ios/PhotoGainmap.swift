import Foundation

/// Pixel edits of a gain map; a port of PhotoGainmap.kt (whose JVM tests cover the same math).
/// Maps are PixelImage values with r = g = b for single-channel maps.
enum PhotoGainmap {
  private static func channel(_ p: UInt32, _ shift: UInt32) -> Int { Int((p >> shift) & 255) }
  static func grey(_ v: Int) -> UInt32 { 0xff00_0000 | UInt32(v) << 16 | UInt32(v) << 8 | UInt32(v) }

  /// Neutral stored value ("no boost") for hdrgm/ISO metadata in log2 units: the decoder uses
  /// G' = stored^(1/gamma) and log2 boost = mix(min, max, G'), so G'0 = −min/(max − min) and stored = G'0^gamma.
  static func neutral(gainMapMinLog2 low: Double, gainMapMaxLog2 high: Double, gamma: Double) -> Int {
    guard low.isFinite, high.isFinite, gamma.isFinite, gamma > 0, high - low > 1e-12 else { return 0 }
    let share = max(0, min(1, (0 - low) / (high - low)))
    return max(0, min(255, Int((255 * pow(share, gamma)).rounded())))
  }

  static func fillNeutral(_ map: PixelImage, mask: [Bool], neutral: UInt32) -> PixelImage {
    PixelImage(width: map.width, height: map.height, pixels: map.pixels.indices.map { mask[$0] ? neutral : map.pixels[$0] })
  }

  /// Under pen lines the map becomes neutral (one extra map pixel), so the colour never glows on HDR screens.
  static func neutralUnderDrawings(_ map: PixelImage, drawings: [PhotoDrawing], neutral: UInt32) throws -> PixelImage {
    if drawings.isEmpty { return map }
    let mask = try PhotoPixels.strokeMask(width: map.width, height: map.height, strokes: drawings.map { PhotoStroke(radius: $0.width / 2, points: $0.points) }, extra: 1)
    return fillNeutral(map, mask: mask, neutral: neutral)
  }

  /// Object removal: the same diffusion as the base; neutral when the map cannot be diffused.
  static func inpaintMap(_ map: PixelImage, strokes: [PhotoStroke], neutral: UInt32) throws -> PixelImage {
    if strokes.isEmpty { return map }
    do { return try PhotoPixels.inpaint(map, strokes: strokes) }
    catch is PhotoFailure { return fillNeutral(map, mask: try PhotoPixels.strokeMask(width: map.width, height: map.height, strokes: strokes, extra: 1), neutral: neutral) }
  }

  static func sampleAlpha(_ base: PixelImage, width: Int, height: Int) -> [Int] {
    var result = [Int](repeating: 255, count: width * height)
    for y in 0..<height { for x in 0..<width {
      let x0 = x * base.width / width, x1 = max(x0 + 1, (x + 1) * base.width / width)
      let y0 = y * base.height / height, y1 = max(y0 + 1, (y + 1) * base.height / height)
      var sum = 0, count = 0
      for sy in y0..<min(y1, base.height) { for sx in x0..<min(x1, base.width) { sum += channel(base.pixels[sy * base.width + sx], 24); count += 1 } }
      if count > 0 { result[y * width + x] = (sum + count / 2) / count }
    }}
    return result
  }

  static func compositeOnWhite(_ map: PixelImage, alpha: [Int], neutral: UInt32) -> PixelImage {
    PixelImage(width: map.width, height: map.height, pixels: map.pixels.indices.map { i in
      let p = map.pixels[i], a = max(0, min(255, alpha[i]))
      func mix(_ shift: UInt32) -> Int { (channel(p, shift) * a + channel(neutral, shift) * (255 - a) + 127) / 255 }
      return 0xff00_0000 | UInt32(mix(16)) << 16 | UInt32(mix(8)) << 8 | UInt32(mix(0))
    })
  }

  /// Rotation (clockwise) then horizontal mirror on the pixel grid; exact, used for the map only.
  static func transformed(_ image: PixelImage, rotation: Int, flip: Bool) -> PixelImage {
    let turned = rotation % 180 != 0
    let width = turned ? image.height : image.width, height = turned ? image.width : image.height
    var pixels = [UInt32](repeating: 0, count: width * height)
    for y in 0..<image.height { for x in 0..<image.width {
      var nx: Int, ny: Int
      switch rotation {
      case 90: nx = image.height - 1 - y; ny = x
      case 180: nx = image.width - 1 - x; ny = image.height - 1 - y
      case 270: nx = y; ny = image.width - 1 - x
      default: nx = x; ny = y
      }
      if flip { nx = width - 1 - nx }
      pixels[ny * width + nx] = image.pixels[y * image.width + x]
    }}
    return PixelImage(width: width, height: height, pixels: pixels)
  }

  /// EXIF orientation as (clockwise rotation, mirror after rotation).
  static func orientation(_ value: Int) -> (Int, Bool) {
    switch value {
    case 2: return (0, true)
    case 3: return (180, false)
    case 4: return (180, true)
    case 5: return (90, true)
    case 6: return (90, false)
    case 7: return (270, true)
    case 8: return (270, false)
    default: return (0, false)
    }
  }

  /// First (r1, f1), then (r2, f2): F2∘R2∘F1∘R1 = F(f1≠f2)∘R(f1 ? r1−r2 : r1+r2).
  static func combine(_ first: (Int, Bool), _ second: (Int, Bool)) -> (Int, Bool) {
    let rotation = first.1 ? first.0 - second.0 : first.0 + second.0
    return (((rotation % 360) + 360) % 360, first.1 != second.1)
  }

  /// Bilinear crop-and-resize of a small map; `rect` in map pixels.
  static func resampled(_ image: PixelImage, x: Int, y: Int, width: Int, height: Int, to outWidth: Int, _ outHeight: Int) -> PixelImage {
    var pixels = [UInt32](repeating: 0, count: outWidth * outHeight)
    for oy in 0..<outHeight { for ox in 0..<outWidth {
      let sx = Double(x) + (Double(ox) + 0.5) * Double(width) / Double(outWidth) - 0.5
      let sy = Double(y) + (Double(oy) + 0.5) * Double(height) / Double(outHeight) - 0.5
      let x0 = max(x, min(x + width - 1, Int(floor(sx)))), y0 = max(y, min(y + height - 1, Int(floor(sy))))
      let x1 = min(x + width - 1, x0 + 1), y1 = min(y + height - 1, y0 + 1)
      let fx = max(0, min(1, sx - Double(x0))), fy = max(0, min(1, sy - Double(y0)))
      func at(_ px: Int, _ py: Int, _ shift: UInt32) -> Double { Double(channel(image.pixels[py * image.width + px], shift)) }
      func value(_ shift: UInt32) -> UInt32 {
        let top = at(x0, y0, shift) * (1 - fx) + at(x1, y0, shift) * fx, bottom = at(x0, y1, shift) * (1 - fx) + at(x1, y1, shift) * fx
        return UInt32(max(0, min(255, Int((top * (1 - fy) + bottom * fy).rounded()))))
      }
      pixels[oy * outWidth + ox] = 0xff00_0000 | value(16) << 16 | value(8) << 8 | value(0)
    }}
    return PixelImage(width: outWidth, height: outHeight, pixels: pixels)
  }
}
