import AVFoundation
import UIKit

/// Gets a video ready to leave the phone: it is written anew as an MP4 (H.264 + AAC) with no metadata — no place,
/// no camera model, no dates, not the original name — and a small picture of it is made for the row.
///
/// Reference: mobile/src/media/pipeline.ts (`prepareVideo`: metadata removed, the result described by
/// `media {width, height, durationMs, hdr}`) and mobile/src/media/thumbnail.ts (`makeThumbnail`: a frame at
/// min(600 ms, a sixth of the length), then the small JPEG the core checks). The reference copies the picture
/// samples and cleans the container itself; here the system's exporter encodes the video again (at most
/// 1920×1080), which leaves nothing of the original file's metadata in the result.
enum VideoPrepare {
    struct Prepared {
        let file: URL
        let media: [String: Any]
        let preview: [String: Any]?
        let durationMs: Int
    }

    static let failed = "Не удалось обработать видео. Файл не отправлен."

    /// A new file of this app's own in the temporary area (removed by the caller when the upload is over).
    static func freshFile(_ ending: String) -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("invizent-video-" + UUID().uuidString.lowercased() + "." + ending)
    }

    /// Removes what an interrupted recording or export left behind.
    static func sweep() {
        let manager = FileManager.default
        let names = (try? manager.contentsOfDirectory(atPath: manager.temporaryDirectory.path)) ?? []
        for name in names where name.hasPrefix("invizent-video-") || name.hasPrefix("invizent-voice-") {
            try? manager.removeItem(at: manager.temporaryDirectory.appendingPathComponent(name))
        }
    }

    /// The size a video is shown in (its track's size turned as the track says) and its length.
    private static func measure(_ asset: AVAsset) -> (width: Int, height: Int, durationMs: Int)? {
        guard let track = asset.tracks(withMediaType: .video).first else { return nil }
        let box = CGRect(origin: .zero, size: track.naturalSize).applying(track.preferredTransform)
        let width = Int(abs(box.width).rounded()), height = Int(abs(box.height).rounded())
        let seconds = CMTimeGetSeconds(asset.duration)
        guard width > 0, height > 0, width <= 16384, height <= 16384, seconds.isFinite, seconds >= 0, seconds <= 86400 else { return nil }
        return (width, height, Int((seconds * 1000).rounded()))
    }

    /// The small picture of a video: a frame a little after its start (the very first one is often black).
    static func preview(of asset: AVAsset, durationMs: Int) -> [String: Any]? {
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 480, height: 480)
        let at = durationMs > 0 ? min(600.0, Double(durationMs) / 6) : 400.0
        guard let frame = try? generator.copyCGImage(at: CMTime(value: CMTimeValue(at), timescale: 1000), actualTime: nil) else { return nil }
        return PhotoPrepare.preview(of: frame)
    }

    /// Describes a file this app itself has just written (a round video from its own camera): nothing is encoded
    /// again. Call on a background queue.
    static func describe(own file: URL) -> Result<Prepared, FileCore.Failure> {
        let asset = AVURLAsset(url: file)
        guard let measured = measure(asset) else { return .failure(FileCore.Failure(words: failed)) }
        let media: [String: Any] = ["width": measured.width, "height": measured.height, "durationMs": measured.durationMs, "hdr": "sdr"]
        return .success(Prepared(file: file, media: media, preview: preview(of: asset, durationMs: measured.durationMs), durationMs: measured.durationMs))
    }

    /// Writes the video at `source` anew, without metadata. `done` comes on a background queue; the source is
    /// not touched. Gives the export session's way to stop through `started`.
    static func prepare(source: URL, small: Bool = false, started: (AVAssetExportSession) -> Void, done: @escaping (Result<Prepared, FileCore.Failure>) -> Void) {
        let asset = AVURLAsset(url: source)
        guard asset.tracks(withMediaType: .video).first != nil else { return done(.failure(FileCore.Failure(words: failed))) }
        // A round video is 480×640, as the reference's camera writes it.
        let wanted = small ? [AVAssetExportPreset640x480, AVAssetExportPresetMediumQuality] : [AVAssetExportPreset1920x1080, AVAssetExportPresetMediumQuality]
        let known = AVAssetExportSession.exportPresets(compatibleWith: asset)
        guard let preset = wanted.first(where: { known.contains($0) }), let export = AVAssetExportSession(asset: asset, presetName: preset) else {
            return done(.failure(FileCore.Failure(words: failed)))
        }
        let target = freshFile("mp4")
        export.outputURL = target
        export.outputFileType = .mp4
        export.shouldOptimizeForNetworkUse = true
        // Nothing of the source's description is carried over: no place, no device, no dates.
        export.metadata = []
        export.metadataItemFilter = AVMetadataItemFilter.forSharing()
        started(export)
        export.exportAsynchronously {
            guard export.status == .completed else {
                try? FileManager.default.removeItem(at: target)
                return done(.failure(FileCore.Failure(words: export.status == .cancelled ? BigFiles.cancelled : failed)))
            }
            switch describe(own: target) {
            case .success(let prepared): done(.success(prepared))
            case .failure(let failure):
                try? FileManager.default.removeItem(at: target)
                done(.failure(failure))
            }
        }
    }
}
