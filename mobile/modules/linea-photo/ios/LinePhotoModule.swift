import ExpoModulesCore
import Foundation
import CoreGraphics

private struct LineaPhotoError: CodedError {
  let code: String
  let description: String
}

public final class LinePhotoModule: Module {
  private let writer=DispatchQueue(label:"app.linea.photo.writer",qos:.userInitiated)
  public func definition() -> ModuleDefinition {
    Name("LineaPhoto")
    AsyncFunction("capabilities"){PhotoBackground.capabilities()}
    AsyncFunction("prepareBackground"){PhotoBackground.capabilities()}
    AsyncFunction("inspect"){(uri:String) in try self.protect{try PhotoFiles().inspect(uri)}}
    AsyncFunction("render"){(uri:String,options:[String:Any]) in
      try self.protect{try autoreleasepool{try self.render(uri,options:PhotoOptions(options))}}
    }.runOnQueue(writer)
    AsyncFunction("dispose"){(uri:String) in try self.protect{try PhotoFiles().dispose(uri)}}.runOnQueue(writer)
    AsyncFunction("clearCache"){try self.protect{try PhotoFiles().clearCache()}}.runOnQueue(writer)
    AsyncFunction("previewFile"){(uri:String) -> Bool in
      let presenter=self.appContext?.utilities?.currentViewController()
      return try self.protect{try FilePreview.present(uri,from:presenter)}
    }.runOnQueue(.main)
  }
  private func render(_ uri: String, options: PhotoOptions) throws -> [String:Any] {
    let files=PhotoFiles();let header=try files.header(uri)
    if header.range.value != "sdr" { throw PhotoFailure("HDR_UNSUPPORTED") }
    let plan=try PhotoDimensions.plan(width:header.width,height:header.height,options:options)
    var current=try files.decode(header,plan:plan)
    if !options.strokes.isEmpty {
      current=try files.image(PhotoPixels.inpaint(files.pixels(current),strokes:options.strokes))
    }
    if options.background != "keep" { current=try PhotoBackground.foreground(current) }
    if options.background=="white" || options.document != "none" || options.scale>1 {
      var pixels=try files.pixels(current)
      if options.background=="white" { pixels=PhotoPixels.whiteBackground(pixels) }
      if options.document != "none" { pixels=PhotoPixels.document(pixels,monochrome:options.document=="bw") }
      if options.scale>1 { pixels=try PhotoPixels.upscale(pixels,scale:options.scale) }
      current=try files.image(pixels)
    }
    var output=try files.save(current,allowDownsample:options.allowDownsample,format:options.format)
    output["downsampled"]=plan.downsampled || (output["downsampled"] as? Bool == true)
    return output
  }
  private func protect<T>(_ operation: () throws -> T) throws -> T {
    do{return try operation()}
    catch {
      let reason=(error as? PhotoFailure)?.reason ?? "PROCESSING_FAILED"
      let message:String
      switch reason {
      case "DOWNSAMPLE_REQUIRED":message="Для этого режима нужно уменьшить фото. Подтвердите уменьшение в редакторе."
      case "ANIMATED_IMAGE":message="Редактор принимает статические фото. Анимации не преобразуются в один кадр."
      case "BACKGROUND_UNAVAILABLE":message="Удаление фона на iPhone требует iOS 17 или новее."
      case "NO_FOREGROUND":message="Не удалось выделить объект. Попробуйте другое фото."
      case "MASK_TOO_LARGE":message="Отметьте меньшую область: удаление доступно максимум для 20% изображения."
      case "MASK_TOO_COMPLEX":message="Слишком сложная маска. Сотрите часть штрихов и повторите."
      case "IMAGE_TOO_LARGE":message="Фото превышает ограничение размера редактора."
      case "OUTPUT_TOO_LARGE":message="Фото превышает 20 МБ. Разрешите уменьшение фото в редакторе и повторите."
      case "OUT_OF_MEMORY":message="Для обработки фото не хватает памяти. Выберите меньшее изображение."
      case "INCOMPATIBLE_OPTIONS":message="Прозрачный фон требует PNG. Режим документа и замена фона применяются отдельно."
      case "HDR_UNSUPPORTED":message="Редактор не может сохранить HDR или точность этого файла при обработке. Преобразование в SDR не выполнено."
      case "CROP_SOURCE_TOO_LARGE":message="Для точной обрезки нужен исходник до 16 Мп. Сначала сохраните уменьшенную копию без обрезки."
      default:message="Не удалось обработать фото. Исходное изображение не отправлено."
      }
      throw LineaPhotoError(code:"ERR_LINEA_PHOTO_\(reason)",description:message)
    }
  }
}
