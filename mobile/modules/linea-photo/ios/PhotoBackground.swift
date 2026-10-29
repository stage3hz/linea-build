import Foundation
import CoreGraphics
import CoreImage
import Vision

enum PhotoBackground {
  static func capabilities() -> [String:Any] {
    var result:[String:Any]=["backgroundRemoval":false,"backgroundReady":false,"objectRemoval":"diffusion","upscale":"bicubic","maxPlainPixels":16_000_000,"maxProcessingPixels":4_000_000,"maxOutputPixels":8_000_000]
    result["hdrPreservation"]=false
    result["hdrReason"]="Эффекты редактора работают с SDR в 8 бит. HDR и неподтверждённый диапазон блокируются до преобразования пикселей."
    if #available(iOS 17.0, *) {
      result["backgroundRemoval"]=true;result["backgroundReady"]=true
    }else { result["backgroundReason"]="Удаление фона на iPhone требует iOS 17 или новее." }
    return result
  }
  static func foreground(_ image: CGImage) throws -> CGImage {
    guard #available(iOS 17.0, *) else { throw PhotoFailure("BACKGROUND_UNAVAILABLE") }
    let request=VNGenerateForegroundInstanceMaskRequest()
    let handler=VNImageRequestHandler(cgImage:image,orientation:.up,options:[:])
    try handler.perform([request])
    guard let result=request.results?.first,!result.allInstances.isEmpty else { throw PhotoFailure("NO_FOREGROUND") }
    let buffer=try result.generateMaskedImage(ofInstances:result.allInstances,from:handler,croppedToInstancesExtent:false)
    let input=CIImage(cvPixelBuffer:buffer)
    guard let space=CGColorSpace(name:CGColorSpace.sRGB) else { throw PhotoFailure("PROCESSING_FAILED") }
    let context=CIContext(options:[.workingColorSpace:space,.outputColorSpace:space])
    defer{context.clearCaches()}
    guard let foreground=context.createCGImage(input,from:CGRect(x:0,y:0,width:image.width,height:image.height),format:.RGBA8,colorSpace:space,deferred:false),
      foreground.width==image.width,foreground.height==image.height else { throw PhotoFailure("NO_FOREGROUND") }
    return foreground
  }
}
