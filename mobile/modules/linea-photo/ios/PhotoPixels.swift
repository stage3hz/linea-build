import Foundation

struct PhotoFailure: Error { let reason: String; init(_ reason: String) { self.reason = reason } }
struct PixelImage { let width: Int; let height: Int; let pixels: [UInt32] }
struct PhotoPoint { let x: Double; let y: Double }
struct PhotoStroke { let radius: Double; let points: [PhotoPoint] }

enum PhotoPixels {
  private static func channel(_ p: UInt32, _ shift: UInt32) -> Int { Int((p >> shift) & 255) }
  private static func color(_ a: Int, _ r: Int, _ g: Int, _ b: Int) -> UInt32 {
    UInt32(a) << 24 | UInt32(r) << 16 | UInt32(g) << 8 | UInt32(b)
  }
  private static func byte(_ value: Double) -> Int { max(0,min(255,Int(value.rounded()))) }
  static func whiteBackground(_ image: PixelImage) -> PixelImage {
    let output = image.pixels.map { pixel -> UInt32 in
      let a = channel(pixel,24)
      func blend(_ shift: UInt32) -> Int { (channel(pixel,shift)*a+255*(255-a)+127)/255 }
      return color(255,blend(16),blend(8),blend(0))
    }
    return PixelImage(width:image.width,height:image.height,pixels:output)
  }
  static func document(_ image: PixelImage, monochrome: Bool) -> PixelImage {
    let opaque = whiteBackground(image)
    let luma = opaque.pixels.map { pixel in UInt8((channel(pixel,16)*77+channel(pixel,8)*150+channel(pixel,0)*29+128)/256) }
    let side = min(image.width,image.height)
    // Paper brightness: local maximum, then a blur no wider than that maximum,
    // so the estimate never spills from bright paper into shadows or the table.
    let closeRadius = max(2,side/40)
    let localMax = maxFilter(luma,width:image.width,height:image.height,radius:closeRadius)
    let illumination = boxBlur(localMax,width:image.width,height:image.height,radius:max(2,closeRadius/2))
    let normalized = luma.indices.map { i in min(Float(255),Float(luma[i])*255/max(16,illumination[i])) }
    // Black-and-white: a pixel is ink only when it is clearly darker than its neighbourhood
    // (or simply very dark). Large uniformly dark areas therefore stay white instead of becoming blots.
    let neighbourhood = monochrome ? blurFloat(normalized,width:image.width,height:image.height,radius:max(4,side/24)) : normalized
    let output = opaque.pixels.enumerated().map { index, pixel -> UInt32 in
      let divisor = max(16,Double(illumination[index]))
      if monochrome {
        let value = normalized[index]; let mean = neighbourhood[index]
        return (value < mean*0.90 && mean-value > 8) || value < 150 ? 0xff000000 : 0xffffffff
      }
      return color(255,byte(Double(channel(pixel,16))*255/divisor),byte(Double(channel(pixel,8))*255/divisor),byte(Double(channel(pixel,0))*255/divisor))
    }
    return PixelImage(width:image.width,height:image.height,pixels:output)
  }
  private static func maxFilter(_ input: [UInt8], width: Int, height: Int, radius: Int) -> [UInt8] {
    var horizontal = [UInt8](repeating:0,count:input.count)
    var output = horizontal
    for y in 0..<height { maxLine(length:width,radius:radius,read:{Int(input[y*width+$0])},write:{horizontal[y*width+$0]=UInt8($1)}) }
    for x in 0..<width { maxLine(length:height,radius:radius,read:{Int(horizontal[$0*width+x])},write:{output[$0*width+x]=UInt8($1)}) }
    return output
  }
  private static func maxLine(length: Int, radius: Int, read: (Int)->Int, write: (Int,Int)->Void) {
    var queue = [Int](repeating:0,count:length)
    var head = 0; var tail = 0; var added = -1
    for position in 0..<length {
      let end = min(length-1,position+radius)
      while added < end {
        added += 1
        while tail > head && read(queue[tail-1]) <= read(added) { tail -= 1 }
        queue[tail] = added; tail += 1
      }
      while tail > head && queue[head] < position-radius { head += 1 }
      write(position,read(queue[head]))
    }
  }
  private static func blurFloat(_ input: [Float], width: Int, height: Int, radius: Int) -> [Float] {
    var horizontal = [Float](repeating:0,count:input.count)
    var output = horizontal
    for y in 0..<height { blurLine(length:width,radius:radius,read:{input[y*width+$0]},write:{horizontal[y*width+$0]=$1}) }
    for x in 0..<width { blurLine(length:height,radius:radius,read:{horizontal[$0*width+x]},write:{output[$0*width+x]=$1}) }
    return output
  }
  private static func boxBlur(_ input: [UInt8], width: Int, height: Int, radius: Int) -> [Float] {
    var horizontal = [Float](repeating:0,count:input.count)
    var output = horizontal
    for y in 0..<height { blurLine(length:width,radius:radius,read:{Float(input[y*width+$0])},write:{horizontal[y*width+$0]=$1}) }
    for x in 0..<width { blurLine(length:height,radius:radius,read:{horizontal[$0*width+x]},write:{output[$0*width+x]=$1}) }
    return output
  }
  private static func blurLine(length: Int, radius: Int, read: (Int)->Float, write: (Int,Float)->Void) {
    var sum = 0.0; var start = 0; var end = -1
    for position in 0..<length {
      let desiredEnd = min(length-1,position+radius)
      while end < desiredEnd { end += 1; sum += Double(read(end)) }
      let desiredStart = max(0,position-radius)
      while start < desiredStart { sum -= Double(read(start)); start += 1 }
      write(position,Float(sum/Double(end-start+1)))
    }
  }
  static func inpaint(_ image: PixelImage, strokes: [PhotoStroke]) throws -> PixelImage {
    if strokes.isEmpty { return image }
    let mask = try strokeMask(width:image.width,height:image.height,strokes:strokes)
    let count = mask.filter{$0}.count
    if count == 0 { throw PhotoFailure("EMPTY_MASK") }
    if count*5 > mask.count { throw PhotoFailure("MASK_TOO_LARGE") }
    var output = image.pixels; var scratch = image.pixels
    var known = mask.map{!$0}; var queued = [Bool](repeating:false,count:mask.count)
    var queue = [Int](); queue.reserveCapacity(count)
    for i in mask.indices where mask[i] {
      if hasKnownNeighbor(i,width:image.width,height:image.height,known:known) { queue.append(i); queued[i]=true }
    }
    var head = 0
    while head < queue.count {
      let at = queue[head]; head += 1
      output[at] = try neighborColor(at,width:image.width,height:image.height,pixels:output,known:known)
      known[at] = true
      neighbors(at,width:image.width,height:image.height) { next in
        if mask[next] && !queued[next] { queued[next]=true; queue.append(next) }
      }
    }
    if head != count { throw PhotoFailure("EMPTY_BOUNDARY") }
    for _ in 0..<4 {
      for i in queue { scratch[i] = try neighborColor(i,width:image.width,height:image.height,pixels:output,known:nil) }
      swap(&output,&scratch)
    }
    return PixelImage(width:image.width,height:image.height,pixels:output)
  }
  private static func strokeMask(width: Int, height: Int, strokes: [PhotoStroke]) throws -> [Bool] {
    var mask = [Bool](repeating:false,count:width*height); var budget = 0
    for stroke in strokes {
      let radius = max(1,stroke.radius*Double(min(width,height)))
      let segments = max(1,stroke.points.count-1)
      for index in 0..<segments {
        let start = stroke.points[index]; let end = stroke.points[min(index+1,stroke.points.count-1)]
        let ax = start.x*Double(width-1); let ay = start.y*Double(height-1)
        let bx = end.x*Double(width-1); let by = end.y*Double(height-1)
        let x0 = max(0,Int(floor(min(ax,bx)-radius))); let x1 = min(width-1,Int(ceil(max(ax,bx)+radius)))
        let y0 = max(0,Int(floor(min(ay,by)-radius))); let y1 = min(height-1,Int(ceil(max(ay,by)+radius)))
        budget += (x1-x0+1)*(y1-y0+1)
        if budget > 60_000_000 { throw PhotoFailure("MASK_TOO_COMPLEX") }
        let dx = bx-ax; let dy = by-ay; let squared = dx*dx+dy*dy
        for y in y0...y1 { for x in x0...x1 {
          let distance = squared == 0 ? 0 : ((Double(x)-ax)*dx+(Double(y)-ay)*dy)/squared
          let t = max(0,min(1,distance)); let px = Double(x)-ax-t*dx; let py = Double(y)-ay-t*dy
          if px*px+py*py <= radius*radius { mask[y*width+x]=true }
        }}
      }
    }
    return mask
  }
  private static func neighbors(_ index: Int, width: Int, height: Int, visit: (Int)->Void) {
    let x = index%width; let y = index/width
    for dy in -1...1 { for dx in -1...1 {
      let nx = x+dx; let ny = y+dy
      if (dx != 0 || dy != 0) && nx >= 0 && nx < width && ny >= 0 && ny < height { visit(ny*width+nx) }
    }}
  }
  private static func hasKnownNeighbor(_ at: Int, width: Int, height: Int, known: [Bool]) -> Bool {
    var found = false; neighbors(at,width:width,height:height){if known[$0]{found=true}}; return found
  }
  private static func neighborColor(_ at: Int, width: Int, height: Int, pixels: [UInt32], known: [Bool]?) throws -> UInt32 {
    var a=0; var r=0; var g=0; var b=0; var count=0
    neighbors(at,width:width,height:height) { index in
      if known == nil || known![index] {
        let p=pixels[index]; a += channel(p,24); r += channel(p,16); g += channel(p,8); b += channel(p,0); count += 1
      }
    }
    if count == 0 { throw PhotoFailure("EMPTY_BOUNDARY") }
    return color((a+count/2)/count,(r+count/2)/count,(g+count/2)/count,(b+count/2)/count)
  }
  private static func cubic(_ x: Double) -> Double {
    let t=abs(x)
    if t <= 1 { return (1.5*t-2.5)*t*t+1 }
    if t < 2 { return ((-0.5*t+2.5)*t-4)*t+2 }
    return 0
  }
  static func upscale(_ image: PixelImage, scale:Int=2) throws -> PixelImage {
    if scale != 2 && scale != 4 { throw PhotoFailure("INVALID_OPTIONS") }
    let width=image.width*scale; let height=image.height*scale
    if width*height > 8_000_000 { throw PhotoFailure("OUTPUT_TOO_LARGE") }
    var output=[UInt32](repeating:0,count:width*height)
    for y in 0..<height { for x in 0..<width {
      output[y*width+x]=bicubicPixel(image,x:(Double(x)+0.5)/Double(scale)-0.5,y:(Double(y)+0.5)/Double(scale)-0.5)
    }}
    return PixelImage(width:width,height:height,pixels:output)
  }
  private static func bicubicPixel(_ image: PixelImage, x: Double, y: Double) -> UInt32 {
    let ix=Int(floor(x)); let iy=Int(floor(y)); var alpha=0.0; var r=0.0; var g=0.0; var b=0.0
    for dy in -1...2 { for dx in -1...2 {
      let weight=cubic(x-Double(ix+dx))*cubic(y-Double(iy+dy))
      let pixel=image.pixels[max(0,min(image.height-1,iy+dy))*image.width+max(0,min(image.width-1,ix+dx))]
      let a=Double(channel(pixel,24)); alpha += a*weight
      r += Double(channel(pixel,16))*a*weight; g += Double(channel(pixel,8))*a*weight; b += Double(channel(pixel,0))*a*weight
    }}
    if alpha <= 0.5 { return 0 }
    return color(byte(alpha),byte(r/alpha),byte(g/alpha),byte(b/alpha))
  }
}
