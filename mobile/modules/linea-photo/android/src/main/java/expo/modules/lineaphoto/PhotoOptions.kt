package expo.modules.lineaphoto

import kotlin.math.*

data class PhotoCrop(val x:Double,val y:Double,val width:Double,val height:Double)
data class PhotoRect(val x:Int,val y:Int,val width:Int,val height:Int)
data class PhotoPlan(val crop:PhotoRect,val width:Int,val height:Int,val downsampled:Boolean)

data class PhotoOptions(val background:String,val document:String,val scale:Int,val strokes:List<PhotoStroke>,val allowDownsample:Boolean,val format:String="png",val resolution:Double=1.0,val crop:PhotoCrop?=null) {
  val plain get() = background=="keep" && document=="none" && scale==1 && strokes.isEmpty()
  val pixelLimit get() = if(plain)16_000_000 else min(4_000_000,8_000_000/(scale*scale))
  companion object {
    fun parse(value:Map<String,Any?>):PhotoOptions {
      if(value.keys.any{it !in setOf("background","document","scale","strokes","allowDownsample","format","resolution","crop")})throw PhotoFailure("INVALID_OPTIONS")
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
      return PhotoOptions(background,document,scale.toInt(),strokes,allow,format,resolution,crop)
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
      if(raw.size>64)throw PhotoFailure("MASK_TOO_COMPLEX")
      var count=0
      return raw.map { item ->
        val objectValue=item as? Map<*,*> ?: throw PhotoFailure("INVALID_OPTIONS")
        if(objectValue.keys.toSet()!=setOf("radius","points"))throw PhotoFailure("INVALID_OPTIONS")
        val radius=number(objectValue["radius"])
        if(radius !in .001.. .15)throw PhotoFailure("INVALID_OPTIONS")
        val points=objectValue["points"] as? List<*> ?: throw PhotoFailure("INVALID_OPTIONS")
        if(points.isEmpty())throw PhotoFailure("EMPTY_MASK")
        count+=points.size;if(count>4096)throw PhotoFailure("MASK_TOO_COMPLEX")
        PhotoStroke(radius,points.map { point ->
          val p=point as? Map<*,*> ?: throw PhotoFailure("INVALID_OPTIONS")
          if(p.keys.toSet()!=setOf("x","y"))throw PhotoFailure("INVALID_OPTIONS")
          val x=number(p["x"]);val y=number(p["y"])
          if(x !in 0.0..1.0 || y !in 0.0..1.0)throw PhotoFailure("INVALID_OPTIONS")
          PhotoPoint(x,y)
        })
      }
    }
  }
}

object PhotoDimensions {
  fun plan(width:Int,height:Int,options:PhotoOptions):PhotoPlan {
    fit(width,height,16_000_000) // Validate the oriented source before geometry arithmetic.
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
    if(downsampled&&!options.allowDownsample)throw PhotoFailure("DOWNSAMPLE_REQUIRED")
    return PhotoPlan(crop,size.first,size.second,downsampled)
  }
  fun decodeSize(width:Int,height:Int,plan:PhotoPlan):Pair<Int,Int> {
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
