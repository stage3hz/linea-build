import ImageIO
import UIKit
import UniformTypeIdentifiers

/// A photo made ready to send, the way the previous app's photo module did it (mobile/modules/linea-photo/ios and
/// mobile/src/photo/pipeline.ts): the picture is decoded upright and drawn into a fresh sRGB bitmap, and that
/// bitmap alone is written out — as PNG, or as JPEG when the original was a big picture without transparency.
/// Nothing of the original file is copied: no EXIF, no GPS, no camera or author data, no thumbnails, no name.
/// What was written is then passed through a gate that keeps only the picture's own parts.
enum PhotoPrepare {
    struct Prepared {
        /// The bytes that are sealed and sent.
        let bytes: Data
        let name: String
        let mimeType: String
        let width: Int
        let height: Int
        /// The small picture that rides inside the message (the core's checked object), if one could be made.
        let preview: [String: Any]?
    }

    struct Failure: Error {
        let words: String
    }

    private static let maxBytes = 20 * 1024 * 1024
    private static let maxPixels = 16_000_000
    private static let unreadable = Failure(words: "Не удалось обработать фото. Файл не отправлен.")

    /// The size a picture is worked at: its own when it has at most `limit` pixels, else scaled down to that.
    private static func fit(width: Int, height: Int, limit: Int) -> (Int, Int)? {
        guard width > 0, height > 0, width <= 20000, height <= 20000, width * height <= 100_000_000 else { return nil }
        let pixels = width * height
        if pixels <= limit { return (width, height) }
        let scale = (Double(limit) / Double(pixels)).squareRoot()
        return (max(1, Int((Double(width) * scale).rounded(.down))), max(1, Int((Double(height) * scale).rounded(.down))))
    }

    /// A fresh 8-bit sRGB bitmap of the picture at the given size.
    private static func redraw(_ image: CGImage, width: Int, height: Int, opaque: Bool) -> CGImage? {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return nil }
        context.interpolationQuality = .high
        if opaque {
            context.setFillColor(CGColor(gray: 1, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()
    }

    private static func encode(_ image: CGImage, jpeg: Bool) -> Data? {
        let data = NSMutableData()
        let type = (jpeg ? UTType.jpeg : UTType.png).identifier as CFString
        guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, type, 1, nil) else { return nil }
        // Only the bitmap is given: no properties of the source are passed on.
        let properties: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 1.0, kCGImageDestinationEmbedThumbnail: false]
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }

    /// The PNG with only the parts a still picture needs (IHDR, PLTE, tRNS, IDAT, IEND), each with a correct
    /// checksum; text, time, EXIF, colour-profile and every other side part is dropped. nil: not a sound PNG.
    /// (The reference's `sanitizePng` for an ordinary, non-HDR picture; the system writes only such here.)
    static func cleanPng(_ png: Data) -> Data? {
        let bytes = [UInt8](png)
        let signature: [UInt8] = [137, 80, 78, 71, 13, 10, 26, 10]
        guard bytes.count <= maxBytes, bytes.count > signature.count, Array(bytes[0..<8]) == signature else { return nil }
        var out = Data(signature)
        var offset = 8
        var header = false, pixels = false, ended = false
        while offset < bytes.count {
            guard !ended, bytes.count - offset >= 12 else { return nil }
            let length = Int(bytes[offset]) << 24 | Int(bytes[offset + 1]) << 16 | Int(bytes[offset + 2]) << 8 | Int(bytes[offset + 3])
            let end = offset + length + 12
            guard end <= bytes.count else { return nil }
            let kind = String(decoding: bytes[(offset + 4)..<(offset + 8)], as: UTF8.self)
            let stored = UInt32(bytes[end - 4]) << 24 | UInt32(bytes[end - 3]) << 16 | UInt32(bytes[end - 2]) << 8 | UInt32(bytes[end - 1])
            guard crc32(bytes[(offset + 4)..<(end - 4)]) == stored else { return nil }
            if !header && kind != "IHDR" { return nil }
            switch kind {
            case "IHDR":
                guard !header, length == 13 else { return nil }
                header = true
                out.append(contentsOf: bytes[offset..<end])
            case "PLTE", "tRNS":
                guard !pixels else { return nil }
                out.append(contentsOf: bytes[offset..<end])
            case "IDAT":
                pixels = true
                out.append(contentsOf: bytes[offset..<end])
            case "IEND":
                guard pixels, length == 0 else { return nil }
                ended = true
                out.append(contentsOf: bytes[offset..<end])
            case "acTL", "fcTL", "fdAT":
                return nil
            default:
                // A part the picture cannot be read without, of a kind this app does not write.
                if bytes[offset + 4] & 32 == 0 { return nil }
            }
            offset = end
        }
        return ended ? out : nil
    }

    private static let crcTable: [UInt32] = (0..<256).map { value -> UInt32 in
        var crc = UInt32(value)
        for _ in 0..<8 { crc = crc & 1 == 1 ? 0xedb8_8320 ^ (crc >> 1) : crc >> 1 }
        return crc
    }

    private static func crc32(_ bytes: ArraySlice<UInt8>) -> UInt32 {
        var crc: UInt32 = 0xffff_ffff
        for byte in bytes { crc = crcTable[Int((crc ^ UInt32(byte)) & 255)] ^ (crc >> 8) }
        return crc ^ 0xffff_ffff
    }

    /// Whether the bytes are a picture the system can decode (a photo picked as a file is prepared as a photo).
    static func isPicture(_ source: CGImageSource) -> Bool {
        // A PDF is a document even though the system could draw its first page.
        guard let type = CGImageSourceGetType(source), let kind = UTType(type as String), kind.conforms(to: .image) else { return false }
        return CGImageSourceGetCount(source) > 0 && CGImageSourceGetStatus(source) == .statusComplete
    }

    /// Prepares the picture of an image file. `fileSize`: the size of the original, which decides the format.
    /// Attachments: `format` — the photo editor's «JPEG» / «PNG» choice for an edited picture (nil: decided here).
    static func prepare(_ source: CGImageSource, fileSize: Int, format: String? = nil) -> Result<Prepared, Failure> {
        guard isPicture(source), let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let pixelWidth = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue, let pixelHeight = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              let size = fit(width: pixelWidth, height: pixelHeight, limit: maxPixels) else { return .failure(unreadable) }
        // Decoded upright (the orientation is applied to the pixels, then forgotten) at the working size.
        let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                        kCGImageSourceThumbnailMaxPixelSize: max(size.0, size.1), kCGImageSourceShouldCacheImmediately: true]
        guard let decoded = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return .failure(unreadable) }
        let hasAlpha = ![CGImageAlphaInfo.none, .noneSkipFirst, .noneSkipLast].contains(decoded.alphaInfo)
        // A big original without transparency (a camera JPEG, HEIC, RAW) becomes JPEG, so it stays sharp within
        // 20 MiB; everything else is PNG, exact to the pixel.
        let jpeg = format.map { $0 == "jpeg" } ?? (fileSize > maxBytes && !hasAlpha)
        guard var current = redraw(decoded, width: decoded.width, height: decoded.height, opaque: jpeg) else { return .failure(unreadable) }
        for _ in 0..<4 {
            guard let written = encode(current, jpeg: jpeg) else { return .failure(unreadable) }
            if written.count <= maxBytes {
                let clean: Data
                if jpeg {
                    guard case .success(let gated) = FileCore.cleanJpeg(written) else { return .failure(unreadable) }
                    clean = gated
                } else {
                    guard let gated = cleanPng(written) else { return .failure(unreadable) }
                    clean = gated
                }
                return .success(Prepared(bytes: clean, name: jpeg ? "photo.jpg" : "photo.png", mimeType: jpeg ? "image/jpeg" : "image/png",
                                         width: current.width, height: current.height, preview: preview(of: current)))
            }
            // Sending never fails on size: a picture whose clean file is over 20 MiB is scaled down and written again.
            let factor = min(0.9, (Double(maxBytes) / Double(written.count)).squareRoot() * 0.9)
            let width = max(1, Int((Double(current.width) * factor).rounded(.down))), height = max(1, Int((Double(current.height) * factor).rounded(.down)))
            guard let smaller = redraw(current, width: width, height: height, opaque: jpeg) else { return .failure(unreadable) }
            current = smaller
        }
        return .failure(Failure(words: "Фото больше 20 МиБ. Выбери уменьшение и повтори обработку."))
    }

    /// The small picture for inside the message: a JPEG of the cleaned bitmap, tried at three sizes until the
    /// core's gate (at most 256 px a side and 8 KiB, cleaned, checked) takes one. Never the original.
    static func preview(of image: CGImage) -> [String: Any]? {
        let steps: [(CGFloat, CGFloat)] = [(240, 0.6), (160, 0.4), (96, 0.3)]
        for (edge, quality) in steps {
            let wide = image.width >= image.height
            let scale = edge / CGFloat(wide ? image.width : image.height)
            let size = CGSize(width: max(1, (CGFloat(image.width) * scale).rounded()), height: max(1, (CGFloat(image.height) * scale).rounded()))
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            format.opaque = true
            format.preferredRange = .standard
            let small = UIGraphicsImageRenderer(size: size, format: format).image { (context: UIGraphicsImageRendererContext) -> Void in
                UIColor.white.setFill()
                context.fill(CGRect(origin: .zero, size: size))
                UIImage(cgImage: image).draw(in: CGRect(origin: .zero, size: size))
            }
            guard let jpeg = small.jpegData(compressionQuality: quality) else { continue }
            if let made = FileCore.call("preview", [jpeg.base64EncodedString()]) as? [String: Any] { return made }
        }
        return nil
    }
}
