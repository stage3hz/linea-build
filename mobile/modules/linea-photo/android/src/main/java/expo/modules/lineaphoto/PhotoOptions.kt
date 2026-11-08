package expo.modules.lineaphoto

import kotlin.math.*

data class PhotoCrop(val x:Double,val y:Double,val width:Double,val height:Double)
data class PhotoRect(val x:Int,val y:Int,val width:Int,val height:Int)
data class PhotoPlan(val crop:PhotoRect,val width:Int,val height:Int,val downsampled:Boolean)

/**
 * Geometry order (shared with geometry.ts and the golden table): EXIF orientation, user rotation (clockwise),
 * mirror, crop in that rotated frame, resolution, pixel limit, scale. Strokes and drawings are normalized to
 * the output frame and may reach slightly outside it where a stroke crosses the crop edge.
 */
data class PhotoOptions(val background:String,val document:String,val scale:Int,val strokes:List<PhotoStroke>,val allowDownsample:Boolean,val format:String="png",val resolution:Double=1.0,val crop:PhotoCrop?=null,
  val rotation:Int=0,val flip:Boolean=false,val drawings:List<PhotoDrawing> = emptyList(),val dynamicRange:String="keep",val previewPixels:Int?=null) {
  val plain get() = background=="keep" && document=="none" && scale==1 && strokes.isEmpty()
  val pixelLimit get() = min(if(plain)16_000_000 else min(4_000_000,8_000_000/(scale*scale)),previewPixels ?: Int.MAX_VALUE)
  /** A fast preview is reduced without consent; it is shown on screen only and never uploaded. */
  val downsampleAllowed get() = allowDownsample || previewPixels!=null
  /** Explicit consent to SDR, or a preview (always SDR). */
  val sdr get() = dynamicRange=="sdr" || previewPixels!=null
  /** Modes that cannot carry a gain map: transparent PNG, document, PNG output. */
  val sdrOnly get() = background=="transparent" || document!="none" || format=="png"
  companion object {
    const val MAX_STROKES=256
    const val MAX_DRAWINGS=256
    private const val MIN_COORDINATE=-16.0
    private const val MAX_COORDINATE=17.0
    private val COLOR=Regex("#[0-9A-Fa-f]{6}")
    fun parse(value:Map<String,Any?>):PhotoOptions {
      if(value.keys.any{it !in setOf("background","document","scale","strokes","allowDownsample","format","resolution","crop","rotation","flip","drawings","dynamicRange","preview")})throw PhotoFailure("INVALID_OPTIONS")
      val background=value["background"] as? String ?: throw PhotoFailure("INVALID_OPTIONS")
      val document=value["document"] as? String ?: throw PhotoFailure("INVALID_OPTIONS")
      val scale=number(value["scale"])
      if(background !in setOf("keep","transparent","white") || document !in setOf("none","bw","color") || scale !in setOf(1.0,2.0,4.0))throw PhotoFailure("INVALID_OPTIONS")
      val format=if(value.containsKey("format"))value["format"] as? String ?: throw PhotoFailure("INVALID_OPTIONS") else "png"
      val resolution=if(value.containsKey("resolution"))number(value["resolution"]) else 1.0
      if(format !in setOf("png","jpeg") || resolution !in setOf(1.0,.5))throw PhotoFailure("INVALID_OPTIONS")
      if(document!="none" && background!="keep")throw PhotoFailure("INCOMPATIBLE_OPTIONS")
      if(format=="jpeg" && background=="transparent")throw PhotoFailure("INCOMPATIBLE_OPTIONS")
      val allow=if(value.containsKey("allowDownsample"))value["allowDownsample"] else false
      if(allow !is Boolean)throw PhotoFailure("INVALID_OPTIONS")
      val strokes=parseStrokes(value["strokes"])
      val crop=if(value.containsKey("crop"))parseCrop(value["crop"]) else null
      val rotation=if(value.containsKey("rotation"))number(value["rotation"]) else 0.0
      if(rotation !in setOf(0.0,90.0,180.0,270.0))throw PhotoFailure("INVALID_OPTIONS")
      val flip=if(value.containsKey("flip"))value["flip"] else false
      if(flip !is Boolean)throw PhotoFailure("INVALID_OPTIONS")
      val drawings=if(value.containsKey("drawings"))parseDrawings(value["drawings"]) else emptyList()
      val range=if(value.containsKey("dynamicRange"))value["dynamicRange"] as? String ?: throw PhotoFailure("INVALID_OPTIONS") else "keep"
      if(range !in setOf("keep","sdr"))throw PhotoFailure("INVALID_OPTIONS")
      val preview=if(value.containsKey("preview"))parsePreview(value["preview"]) else null
      return PhotoOptions(background,document,scale.toInt(),strokes,allow,format,resolution,crop,rotation.toInt(),flip,drawings,range,preview)
    }
    private fun parsePreview(value:Any?):Int {
      val raw=value as? Map<*,*> ?: throw PhotoFailure("INVALID_OPTIONS")
      if(raw.keys.toSet()!=setOf("maxPixels"))throw PhotoFailure("INVALID_OPTIONS")
      val pixels=number(raw["maxPixels"])
      if(pixels<65_536 || pixels>4_000_000 || pixels!=floor(pixels))throw PhotoFailure("INVALID_OPTIONS")
      return pixels.toInt()
    }
    private fun parsePoints(value:Any?):List<PhotoPoint> {
      val points=value as? List<*> ?: throw PhotoFailure("INVALID_OPTIONS")
      if(points.isEmpty())throw PhotoFailure("EMPTY_MASK")
      return points.map { point ->
        val p=point as? Map<*,*> ?: throw PhotoFailure("INVALID_OPTIONS")
        if(p.keys.toSet()!=setOf("x","y"))throw PhotoFailure("INVALID_OPTIONS")
        val x=number(p["x"]);val y=number(p["y"])
        if(x !in MIN_COORDINATE..MAX_COORDINATE || y !in MIN_COORDINATE..MAX_COORDINATE)throw PhotoFailure("INVALID_OPTIONS")
        PhotoPoint(x,y)
      }
    }
    private fun parseDrawings(value:Any?):List<PhotoDrawing> {
      val raw=value as? List<*> ?: throw PhotoFailure("INVALID_OPTIONS")
      if(raw.size>MAX_DRAWINGS)throw PhotoFailure("MASK_TOO_COMPLEX")
      var count=0
      return raw.map { item ->
        val objectValue=item as? Map<*,*> ?: throw PhotoFailure("INVALID_OPTIONS")
        if(objectValue.keys.toSet()!=setOf("color","width","points"))throw PhotoFailure("INVALID_OPTIONS")
        val color=objectValue["color"] as? String ?: throw PhotoFailure("INVALID_OPTIONS")
        if(!COLOR.matches(color))throw PhotoFailure("INVALID_OPTIONS")
        val width=number(objectValue["width"])
        if(width<.0005 || width>2.0)throw PhotoFailure("INVALID_OPTIONS")
        val points=parsePoints(objectValue["points"])
        count+=points.size;if(count>8192)throw PhotoFailure("MASK_TOO_COMPLEX")
        PhotoDrawing((0xff shl 24) or color.substring(1).toInt(16),width,points)
      }
    }
    private fun number(value:Any?):Double {
      val number=(value as? Number)?.toDouble() ?: throw PhotoFailure("INVALID_OPTIONS")
      if(!number.isFinite())throw PhotoFailure("INVALID_OPTIONS")
      return number
    }
    private fun parseCrop(value:Any?):PhotoCrop {
      val raw=value as? Map<*,*> ?: throw PhotoFailure("INVALID_OPTIONS")
      if(raw.keys.toSet()!=setOf("x","y","width","height"))throw PhotoFailure("INVALID_OPTIONS")
      val x=number(raw["x"]);val y=number(raw["y"])
      val width=number(raw["width"]);val height=number(raw["height"])
      if(x<0 || y<0 || x>=1 || y>=1 || width<=0 || height<=0 || x+width>1.0+1e-9 || y+height>1.0+1e-9)throw PhotoFailure("INVALID_OPTIONS")
      return PhotoCrop(x,y,width,height)
    }
    private fun parseStrokes(value:Any?):List<PhotoStroke> {
      val raw=value as? List<*> ?: throw PhotoFailure("INVALID_OPTIONS")
      if(raw.size>MAX_STROKES)throw PhotoFailure("MASK_TOO_COMPLEX")
      var count=0
      return raw.map { item ->
        val objectValue=item as? Map<*,*> ?: throw PhotoFailure("INVALID_OPTIONS")
        if(objectValue.keys.toSet()!=setOf("radius","points"))throw PhotoFailure("INVALID_OPTIONS")
        val radius=number(objectValue["radius"])
        // A crop rescales the brush: a source-relative radius grows relative to a small crop.
        if(radius<.0005 || radius>2.0)throw PhotoFailure("INVALID_OPTIONS")
        val points=parsePoints(objectValue["points"])
        count+=points.size;if(count>4096)throw PhotoFailure("MASK_TOO_COMPLEX")
        PhotoStroke(radius,points)
      }
    }
  }
}

object PhotoDimensions {
  /** The oriented source turned by the user's rotation. */
  fun rotated(width:Int,height:Int,rotation:Int)=if(rotation%180==0)width to height else height to width
  fun plan(sourceWidth:Int,sourceHeight:Int,options:PhotoOptions):PhotoPlan {
    fit(sourceWidth,sourceHeight,16_000_000) // Validate the oriented source before geometry arithmetic.
    val (width,height)=rotated(sourceWidth,sourceHeight,options.rotation)
    val crop=options.crop?.let {
      val left=floor(it.x*width).toInt().coerceIn(0,width-1)
      val top=floor(it.y*height).toInt().coerceIn(0,height-1)
      val right=ceil((it.x+it.width)*width).toInt().coerceIn(left+1,width)
      val bottom=ceil((it.y+it.height)*height).toInt().coerceIn(top+1,height)
      PhotoRect(left,top,right-left,bottom-top)
    } ?: PhotoRect(0,0,width,height)
    val requestedWidth=max(1,floor(crop.width*options.resolution).toInt())
    val requestedHeight=max(1,floor(crop.height*options.resolution).toInt())
    val size=fit(requestedWidth,requestedHeight,options.pixelLimit)
    val downsampled=size.first!=requestedWidth||size.second!=requestedHeight
    if(downsampled&&!options.downsampleAllowed)throw PhotoFailure("DOWNSAMPLE_REQUIRED")
    return PhotoPlan(crop,size.first,size.second,downsampled)
  }
  /** Normalized source point → normalized rotated frame (clockwise rotation, then mirror); same as geometry.ts mapPoint. */
  fun mapPoint(x:Double,y:Double,rotation:Int,flip:Boolean):Pair<Double,Double> {
    val (rx,ry)=when(rotation){90->(1-y) to x;180->(1-x) to (1-y);270->y to (1-x);else->x to y}
    return (if(flip)1-rx else rx) to ry
  }
  /** Normalized source point → normalized output (inside the outward-rounded crop); same as geometry.ts sourceToOutput. */
  fun outputPoint(x:Double,y:Double,sourceWidth:Int,sourceHeight:Int,rotation:Int,flip:Boolean,crop:PhotoRect):Pair<Double,Double> {
    val (width,height)=rotated(sourceWidth,sourceHeight,rotation)
    val (px,py)=mapPoint(x,y,rotation,flip)
    return (px*width-crop.x)/crop.width to (py*height-crop.y)/crop.height
  }
  /** Size requested from the decoder in the rotated frame, before the crop. */
  fun decodeSize(sourceWidth:Int,sourceHeight:Int,plan:PhotoPlan,rotation:Int=0):Pair<Int,Int> {
    val (width,height)=rotated(sourceWidth,sourceHeight,rotation)
    if(plan.crop==PhotoRect(0,0,width,height))return plan.width to plan.height
    // Crop the original pixels first, so interpolation cannot sample outside
    // the selected frame. ImageIO has no public bounded region decoder.
    if(width.toLong()*height>16_000_000)throw PhotoFailure("CROP_SOURCE_TOO_LARGE")
    return width to height
  }
  fun fit(width:Int,height:Int,limit:Int):Pair<Int,Int> {
    if(width<=0 || height<=0 || width>20000 || height>20000 || width.toLong()*height>100_000_000L)throw PhotoFailure("IMAGE_TOO_LARGE")
    val pixels=width.toLong()*height
    if(pixels<=limit)return width to height
    val scale=sqrt(limit.toDouble()/pixels)
    return max(1,floor(width*scale).toInt()) to max(1,floor(height*scale).toInt())
  }
}
