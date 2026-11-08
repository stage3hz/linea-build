package expo.modules.lineaphoto

import org.junit.Assert.*
import org.junit.Test

class PhotoOptionsTest {
  private fun options(vararg additions:Pair<String,Any?>)=mapOf<String,Any?>("background" to "keep","document" to "none","scale" to 1,"strokes" to emptyList<Any>())+additions
  private fun rejected(reason:String,operation:()->Unit) {
    try{operation();fail("invalid boundary accepted")}catch(error:PhotoFailure){assertEquals(reason,error.reason)}
  }
  @Test fun originalPixelsArePreservedUntilExplicitlyFittedToAnEffectLimit() {
    assertEquals(4000 to 3000,PhotoDimensions.fit(4000,3000,PhotoOptions.parse(options()).pixelLimit))
    assertEquals(2309 to 1732,PhotoDimensions.fit(4000,3000,PhotoOptions.parse(options("document" to "bw")).pixelLimit))
    assertEquals(1632 to 1224,PhotoDimensions.fit(4000,3000,PhotoOptions.parse(options("scale" to 2)).pixelLimit))
    assertFalse(PhotoOptions.parse(options()).allowDownsample)
    assertTrue(PhotoOptions.parse(options("allowDownsample" to true)).allowDownsample)
  }
  @Test fun nonFiniteCoordinatesAndWrongJsonShapesCannotReachRasterizer() {
    val point=mapOf("x" to Double.NaN,"y" to .5)
    rejected("INVALID_OPTIONS"){PhotoOptions.parse(options("strokes" to listOf(mapOf("radius" to .02,"points" to listOf(point))))) }
    rejected("INVALID_OPTIONS"){PhotoOptions.parse(options("scale" to true))}
    rejected("INVALID_OPTIONS"){PhotoOptions.parse(options("allowDownsample" to 1))}
    rejected("INVALID_OPTIONS"){PhotoOptions.parse(options("strokes" to null))}
    rejected("INVALID_OPTIONS"){PhotoOptions.parse(options("unexpected" to true))}
  }
  @Test fun processingLimitsRejectOversizedHeadersAndAmbiguousModes() {
    rejected("IMAGE_TOO_LARGE"){PhotoDimensions.fit(20001,1,16_000_000)}
    rejected("IMAGE_TOO_LARGE"){PhotoDimensions.fit(20000,20000,16_000_000)}
    rejected("INCOMPATIBLE_OPTIONS"){PhotoOptions.parse(options("background" to "white","document" to "color"))}
    rejected("EMPTY_MASK"){PhotoOptions.parse(options("strokes" to listOf(mapOf("radius" to .05,"points" to emptyList<Any>()))))}
  }
  @Test fun strokeWorkIsBoundedBeforeBuildingHugeGeometry() {
    val stroke=mapOf("radius" to .01,"points" to listOf(mapOf("x" to .5,"y" to .5)))
    rejected("MASK_TOO_COMPLEX"){PhotoOptions.parse(options("strokes" to List(PhotoOptions.MAX_STROKES+1){stroke}))}
    val manyPoints=List(4097){mapOf("x" to .5,"y" to .5)}
    rejected("MASK_TOO_COMPLEX"){PhotoOptions.parse(options("strokes" to listOf(mapOf("radius" to .01,"points" to manyPoints))))}
  }
  @Test fun cropThenHalfResolutionThenFourfoldHasTheRequestedDimensions() {
    val input=PhotoOptions.parse(options("crop" to mapOf("x" to .25,"y" to .25,"width" to .5,"height" to .5),"resolution" to .5,"scale" to 4))
    val result=PhotoDimensions.plan(1600,1200,input)
    assertEquals(PhotoRect(400,300,800,600),result.crop)
    assertEquals(400,result.width);assertEquals(300,result.height)
    assertEquals(1600,result.width*input.scale);assertEquals(1200,result.height*input.scale)
    assertFalse(result.downsampled)
  }
  @Test fun fractionalCropUsesCoveredPixelBoundsAndNeverShrinksBelowOnePixel() {
    val input=PhotoOptions.parse(options("crop" to mapOf("x" to .101,"y" to .151,"width" to .202,"height" to .303),"resolution" to .5))
    val result=PhotoDimensions.plan(101,99,input)
    assertEquals(PhotoRect(10,14,21,31),result.crop)
    assertEquals(10,result.width);assertEquals(15,result.height)
    val tiny=PhotoDimensions.plan(9,7,PhotoOptions.parse(options("crop" to mapOf("x" to .99,"y" to .99,"width" to .01,"height" to .01),"resolution" to .5)))
    assertEquals(1,tiny.width);assertEquals(1,tiny.height)
  }
  @Test fun halfResolutionDoesNotRequireAdditionalDownsampleConsent() {
    val input=PhotoOptions.parse(options("resolution" to .5))
    val result=PhotoDimensions.plan(6000,4000,input)
    assertEquals(3000,result.width);assertEquals(2000,result.height);assertFalse(result.downsampled)
  }
  @Test fun fourfoldExcessIsRejectedUnlessAdditionalReductionIsExplicit() {
    rejected("DOWNSAMPLE_REQUIRED"){PhotoDimensions.plan(1000,1000,PhotoOptions.parse(options("scale" to 4)))}
    val input=PhotoOptions.parse(options("scale" to 4,"allowDownsample" to true))
    val result=PhotoDimensions.plan(1000,1000,input)
    assertEquals(707,result.width);assertEquals(707,result.height);assertTrue(result.downsampled)
    assertTrue(result.width.toLong()*result.height*16<=8_000_000)
  }
  @Test fun jpegIsExplicitAndTransparencyIsNeverSilentlyFlattened() {
    assertEquals("png",PhotoOptions.parse(options()).format)
    assertEquals("jpeg",PhotoOptions.parse(options("format" to "jpeg")).format)
    rejected("INCOMPATIBLE_OPTIONS"){PhotoOptions.parse(options("background" to "transparent","format" to "jpeg"))}
  }
  @Test fun invalidCropResolutionAndScaleAreRejectedAtTheBoundary() {
    for(value in listOf(0,0.25,2,true,Double.NaN,null))rejected("INVALID_OPTIONS"){PhotoOptions.parse(options("resolution" to value))}
    for(value in listOf(0,3,8,true,Double.POSITIVE_INFINITY))rejected("INVALID_OPTIONS"){PhotoOptions.parse(options("scale" to value))}
    for(value in listOf("jpg","webp",true,null))rejected("INVALID_OPTIONS"){PhotoOptions.parse(options("format" to value))}
    for(crop in listOf(null,emptyMap<String,Any>(),mapOf("x" to -.1,"y" to 0,"width" to 1,"height" to 1),mapOf("x" to .9,"y" to 0,"width" to .2,"height" to 1),mapOf("x" to 0,"y" to 0,"width" to 0,"height" to 1),mapOf("x" to Double.NaN,"y" to 0,"width" to 1,"height" to 1),mapOf("x" to 0,"y" to 0,"width" to 1,"height" to 1,"extra" to 1)))rejected("INVALID_OPTIONS"){PhotoOptions.parse(options("crop" to crop))}
  }
  @Test fun exactCropNeverAllocatesAnUnboundedFullSourceOrResamplesBeforeCropping() {
    val options=PhotoOptions.parse(options("crop" to mapOf("x" to .25,"y" to .25,"width" to .5,"height" to .5),"resolution" to .5))
    val normal=PhotoDimensions.plan(4000,3000,options)
    assertEquals(4000 to 3000,PhotoDimensions.decodeSize(4000,3000,normal))
    val huge=PhotoDimensions.plan(6000,4000,options)
    rejected("CROP_SOURCE_TOO_LARGE"){PhotoDimensions.decodeSize(6000,4000,huge)}
  }
  @Test fun rotationMirrorDrawingsConsentAndPreviewAreParsedStrictly() {
    val parsed=PhotoOptions.parse(options("rotation" to 90,"flip" to true,"dynamicRange" to "sdr","drawings" to listOf(mapOf("color" to "#FF3B30","width" to .012,"points" to listOf(mapOf("x" to -.2,"y" to 1.1))))))
    assertEquals(90,parsed.rotation);assertTrue(parsed.flip);assertTrue(parsed.sdr)
    assertEquals(0xFFFF3B30.toInt(),parsed.drawings[0].color);assertEquals(-.2,parsed.drawings[0].points[0].x,0.0)
    assertFalse(PhotoOptions.parse(options()).sdr)
    for(value in listOf(45,360,-90,true,"90"))rejected("INVALID_OPTIONS"){PhotoOptions.parse(options("rotation" to value))}
    rejected("INVALID_OPTIONS"){PhotoOptions.parse(options("flip" to 1))}
    rejected("INVALID_OPTIONS"){PhotoOptions.parse(options("dynamicRange" to "hdr"))}
    for(color in listOf("red","#FFF","#GG0000",null))rejected("INVALID_OPTIONS"){PhotoOptions.parse(options("drawings" to listOf(mapOf("color" to color,"width" to .01,"points" to listOf(mapOf("x" to .5,"y" to .5))))))}
    rejected("INVALID_OPTIONS"){PhotoOptions.parse(options("drawings" to listOf(mapOf("color" to "#000000","width" to 3,"points" to listOf(mapOf("x" to .5,"y" to .5))))))}
    rejected("INVALID_OPTIONS"){PhotoOptions.parse(options("strokes" to listOf(mapOf("radius" to .02,"points" to listOf(mapOf("x" to 18,"y" to .5))))))}
    // A preview is reduced without consent and is always SDR; it is bounded.
    val preview=PhotoOptions.parse(options("scale" to 4,"preview" to mapOf("maxPixels" to 1_000_000)))
    assertTrue(preview.sdr);assertTrue(preview.downsampleAllowed);assertEquals(500_000,preview.pixelLimit)
    assertEquals(1_000_000,PhotoOptions.parse(options("preview" to mapOf("maxPixels" to 1_000_000))).pixelLimit)
    assertTrue(PhotoDimensions.plan(4000,3000,PhotoOptions.parse(options("preview" to mapOf("maxPixels" to 1_000_000)))).downsampled)
    for(value in listOf(mapOf("maxPixels" to 10),mapOf("maxPixels" to 9e9),mapOf("pixels" to 100_000),null))rejected("INVALID_OPTIONS"){PhotoOptions.parse(options("preview" to value))}
  }
  @Test fun rotationSwapsTheFrameBeforeTheCropAndTheDecodeSize() {
    val turned=PhotoDimensions.plan(4000,3000,PhotoOptions.parse(options("rotation" to 270,"crop" to mapOf("x" to 0,"y" to 0,"width" to .5,"height" to 1))))
    assertEquals(PhotoRect(0,0,1500,4000),turned.crop)
    assertEquals(3000 to 4000,PhotoDimensions.decodeSize(4000,3000,turned,270))
    val whole=PhotoDimensions.plan(4000,3000,PhotoOptions.parse(options("rotation" to 90)))
    assertEquals(3000,whole.width);assertEquals(4000,whole.height)
    assertEquals(3000 to 4000,PhotoDimensions.decodeSize(4000,3000,whole,90))
  }
  @Test fun sdrOnlyModesAreTheOnesThatCannotCarryAGainMap() {
    assertTrue(PhotoOptions.parse(options()).sdrOnly) // PNG is the default format.
    assertFalse(PhotoOptions.parse(options("format" to "jpeg","background" to "white")).sdrOnly)
    assertTrue(PhotoOptions.parse(options("format" to "jpeg","document" to "bw")).sdrOnly)
  }
}
