package expo.modules.lineaphoto

import org.junit.Assert.*
import org.junit.Test

class PhotoPixelsTest {
  private fun argb(a: Int, r: Int, g: Int, b: Int) = (a shl 24) or (r shl 16) or (g shl 8) or b
  @Test fun whiteBackgroundCompositesAlphaWithoutTurningEdgesBlack() {
    val result = PhotoPixels.whiteBackground(PixelImage(3,1,intArrayOf(0x00112233,0x80ff0000.toInt(),0xff123456.toInt())))
    assertArrayEquals(intArrayOf(-1,0xffff7f7f.toInt(),0xff123456.toInt()),result.pixels)
  }
  @Test fun blackAndWhiteDocumentRemovesASmoothShadowButPreservesText() {
    val width=160; val height=80
    val pixels=IntArray(width*height) { i -> val c=70+(i%width)*170/(width-1);argb(255,c,c,c) }
    for(y in 30..36)for(x in 15..145)pixels[y*width+x]=0xff080808.toInt()
    val result=PhotoPixels.document(PixelImage(width,height,pixels),true)
    assertTrue(result.pixels.all { it == -1 || it == 0xff000000.toInt() })
    assertEquals(-1,result.pixels[15*width+20]);assertEquals(-1,result.pixels[15*width+140])
    assertEquals(0xff000000.toInt(),result.pixels[33*width+50])
  }
  @Test fun blackAndWhiteDocumentDoesNotTurnADarkCornerIntoABlot() {
    // Bright paper with a sharp, large dark shadow in one corner (phone vignette / table edge).
    val width=320; val height=240
    val pixels=IntArray(width*height) { i -> val x=i%width;val y=i/width; if(x<110&&y<90) argb(255,95,95,95) else argb(255,205,205,205) }
    for(y in 150..156)for(x in 160..300)pixels[y*width+x]=argb(255,40,40,40)
    val result=PhotoPixels.document(PixelImage(width,height,pixels),true)
    val corner=(10 until 80).sumOf { y -> (10 until 100).count { x -> result.pixels[y*width+x]!=-1 } }
    assertTrue("dark corner turned black: $corner px",corner<70*90/50)
    assertEquals(0xff000000.toInt(),result.pixels[153*width+200])
  }
  @Test fun colorDocumentBrightensPaperAndRetainsColoredInk() {
    val width=80; val pixels=IntArray(width*80){0xff707070.toInt()}
    for(y in 30..35)for(x in 25..55)pixels[y*width+x]=0xff700909.toInt()
    val result=PhotoPixels.document(PixelImage(width,80,pixels),false)
    val background=result.pixels[10*width+10];val ink=result.pixels[32*width+40]
    assertTrue((background and 255)>235)
    assertTrue(((ink ushr 16) and 255)>(ink and 255)*3)
  }
  @Test fun brushRemovalChangesOnlySelectedPixelsAndFillsFromSurroundings() {
    val width=80;val pixels=IntArray(width*80){0xffdadada.toInt()}
    for(y in 35..44)for(x in 35..44)pixels[y*width+x]=0xff000000.toInt()
    val original=pixels.copyOf()
    val result=PhotoPixels.inpaint(PixelImage(width,80,pixels),listOf(PhotoStroke(.12,listOf(PhotoPoint(.5,.5)))))
    assertEquals(0xffdadada.toInt(),result.pixels[40*width+40]);assertEquals(original[0],result.pixels[0])
    assertArrayEquals(original,pixels)
  }
  @Test fun oversizedBrushMaskIsRejectedInsteadOfFabricatingWholeImage() {
    val strokes=(0..4).map { y -> PhotoStroke(.15,listOf(PhotoPoint(0.0,y/4.0),PhotoPoint(1.0,y/4.0))) }
    try {PhotoPixels.inpaint(PixelImage(50,50,IntArray(2500){-1}),strokes);fail("large mask accepted")}
    catch(error:PhotoFailure){assertEquals("MASK_TOO_LARGE",error.reason)}
  }
  @Test fun bicubicDoublingPreservesUniformColorAndAlpha() {
    val source=PixelImage(4,3,IntArray(12){0x80993366.toInt()})
    val result=PhotoPixels.upscale(source)
    assertEquals(8,result.width);assertEquals(6,result.height)
    assertTrue(result.pixels.all { it == 0x80993366.toInt() })
  }
  @Test fun bicubicFourfoldReallyMultipliesBothAxesAndRetainsAlpha() {
    val source=PixelImage(3,2,IntArray(6){0x80804020.toInt()})
    val result=PhotoPixels.upscale(source,4)
    assertEquals(12,result.width);assertEquals(8,result.height)
    assertTrue(result.pixels.all{it==0x80804020.toInt()})
    assertEquals(6,source.pixels.size)
  }
  @Test fun scalingRejectsUnsupportedFactorsAndOversizedOutputBeforeAllocation() {
    for(scale in listOf(0,1,3,8))try{PhotoPixels.upscale(PixelImage(1,1,intArrayOf(-1)),scale);fail("unsupported scale accepted")}
      catch(error:PhotoFailure){assertEquals("INVALID_OPTIONS",error.reason)}
    try{PhotoPixels.upscale(PixelImage(1000,1000,IntArray(1_000_000){-1}),4);fail("oversized output accepted")}
      catch(error:PhotoFailure){assertEquals("OUTPUT_TOO_LARGE",error.reason)}
  }
}
