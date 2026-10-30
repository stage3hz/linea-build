import Foundation
import QuickLook
import UIKit

/// In-app document preview (Quick Look), as Telegram shows PDF, Word, Excel and other files
/// without leaving the chat. Holds itself alive until the preview is dismissed.
final class FilePreview: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
  private static var current: FilePreview?
  private let url: URL
  private init(url: URL) { self.url = url }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
  func previewControllerDidDismiss(_ controller: QLPreviewController) { FilePreview.current = nil }

  /// Returns false when Quick Look cannot show this file type (the caller falls back to «Открыть в…»).
  static func present(_ uri: String, from presenter: UIViewController?) throws -> Bool {
    guard let url = URL(string: uri), url.isFileURL else { throw PhotoFailure("INVALID_URI") }
    guard FileManager.default.fileExists(atPath: url.path) else { throw PhotoFailure("NOT_FOUND") }
    guard QLPreviewController.canPreview(url as NSURL), var top = presenter else { return false }
    while let next = top.presentedViewController, !next.isBeingDismissed { top = next }
    let preview = FilePreview(url: url)
    current = preview
    let controller = QLPreviewController()
    controller.dataSource = preview
    controller.delegate = preview
    controller.modalPresentationStyle = .fullScreen
    top.present(controller, animated: true)
    return true
  }
}
