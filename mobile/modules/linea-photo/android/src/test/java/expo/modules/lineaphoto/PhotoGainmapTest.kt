package expo.modules.lineaphoto

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.*

class PhotoGainmapTest {
  private fun grey(v:Int)=(255 shl 24) or (v shl 16) or (v shl 8) or v
  private fun map(width:Int,height:Int,value:Int)=PixelImage(width,height,IntArray(width*height){grey(value)})
  private fun level(pixel:Int)=(pixel ushr 16) and 255

  @Test fun neutralValueIsTheNoBoostPointOfTheCurve() {
    assertEquals(0,PhotoGainmap.neutral(1.0,4.0,1.0)) // ratioMin = 1: no boost at G = 0.
    assertEquals((255*(1/5.0)).roundToInt(),PhotoGainmap.neutral(.5,16.0,1.0)) // ln .5 … ln 16: 1/5 of the way.
    assertEquals(51,PhotoGainmap.neutral(.5,16.0,1.0))
    // gamma ≠ 1: G0 = share^(1/gamma).
    assertEquals((255*(.2).pow(1/2.2)).roundToInt(),PhotoGainmap.neutral(.5,16.0,2.2))
    // Round trip with Android's formula: L(G0) = mix(ln min, ln max, (G0/255)^gamma) ≈ 0.
    for((min,max,gamma) in listOf(Triple(.25,8.0,1.0),Triple(.8,3.0,.5),Triple(.5,16.0,2.2))) {
      val g=PhotoGainmap.neutral(min,max,gamma)/255.0
      val log=ln(min)+(ln(max)-ln(min))*g.pow(gamma)
      assertTrue("residual $log",abs(log)<(ln(max)-ln(min))*0.01)
    }
    // Invalid metadata never yields a boost.
    for(values in listOf(Triple(0.0,2.0,1.0),Triple(2.0,2.0,1.0),Triple(.5,2.0,0.0),Triple(Double.NaN,2.0,1.0)))assertEquals(0,PhotoGainmap.neutral(values.first,values.second,values.third))
    // ratioMin above 1 has no neutral point inside the curve: the lowest code is used.
    assertEquals(0,PhotoGainmap.neutral(2.0,8.0,1.0))
    val pixel=PhotoGainmap.neutralPixel(doubleArrayOf(.5,1.0,.5),doubleArrayOf(16.0,4.0,16.0),doubleArrayOf(1.0))
    assertEquals(listOf(51,0,51),listOf((pixel ushr 16) and 255,(pixel ushr 8) and 255,pixel and 255))
  }

  @Test fun penLinesMakeTheMapNeutralWithOneExtraPixel() {
    val drawing=PhotoDrawing(-1,.1,listOf(PhotoPoint(.5,0.0),PhotoPoint(.5,1.0)))
    val result=PhotoGainmap.neutralUnderDrawings(map(40,40,200),listOf(drawing),grey(7))
    assertEquals(7,level(result.pixels[20*40+20]))
    // Half width 2 px + 1 px dilation: x = 19.5 ± 3 is neutral, x = 10 untouched.
    assertEquals(7,level(result.pixels[20*40+17]))
    assertEquals(200,level(result.pixels[20*40+10]))
    val untouched=map(4,4,1);assertSame(untouched,PhotoGainmap.neutralUnderDrawings(untouched,emptyList(),grey(7)))
  }

  @Test fun objectRemovalDiffusesTheMapAndFallsBackToNeutral() {
    val image=PixelImage(30,30,IntArray(900){i->if(i%30<15)grey(40) else grey(240)})
    val stroke=PhotoStroke(.06,listOf(PhotoPoint(.2,.5)))
    val filled=PhotoGainmap.inpaintMap(image,listOf(stroke),grey(9))
    assertEquals(40,level(filled.pixels[15*30+6])) // Surrounded by the dark half.
    // A mask over most of a tiny map cannot be diffused: neutral instead of a failure.
    val huge=PhotoGainmap.inpaintMap(map(4,4,100),listOf(PhotoStroke(.9,listOf(PhotoPoint(.5,.5)))),grey(9))
    assertTrue(huge.pixels.all{level(it)==9})
  }

  @Test fun whiteBackgroundKeepsTheSubjectAndNeutralisesTheBackground() {
    val base=PixelImage(4,2,IntArray(8){i->if(i%4<2)(255 shl 24) else 0}) // left half opaque subject
    val alpha=PhotoGainmap.sampleAlpha(base,2,1)
    assertArrayEquals(intArrayOf(255,0),alpha)
    val result=PhotoGainmap.compositeOnWhite(map(2,1,180),alpha,grey(12))
    assertEquals(180,level(result.pixels[0]));assertEquals(12,level(result.pixels[1]))
  }

  @Test fun rotationCropAndScaleOfTheMapFollowTheBase() {
    // A map at 1/4 size: a 4000×3000 base cropped to 1000×800 keeps a 250×200 map.
    assertEquals(250 to 200,PhotoGainmap.mapSize(1000,800,4000,3000,1000,750))
    // Upscale by the same factor as the base.
    val up=PhotoGainmap.upscale(map(10,8,77),2)
    assertEquals(20,up.width);assertEquals(16,up.height);assertEquals(77,level(up.pixels[0]))
    // The mask is in normalized coordinates, so the same stroke lands on the same relative spot of a smaller map.
    val stroke=listOf(PhotoStroke(.1,listOf(PhotoPoint(.25,.25))))
    val big=PhotoPixels.strokeMask(400,400,stroke);val small=PhotoPixels.strokeMask(100,100,stroke)
    assertTrue(big[100*400+100]);assertTrue(small[25*100+25]);assertFalse(small[75*100+75])
    // Points outside the crop (allowed for strokes crossing its edge) are skipped, not an error.
    assertFalse(PhotoPixels.strokeMask(10,10,listOf(PhotoStroke(.01,listOf(PhotoPoint(5.0,5.0))))).any{it})
  }

  @Test fun toneMappingIsMonotonicKeepsWhiteAndReachesWhiteOnlyAtThePeak() {
    val peak=8.0
    var previous=-1.0
    for(i in 0..800){val v=i/100.0;val mapped=PhotoToneMap.curve(v,peak);assertTrue(mapped>=previous);previous=mapped}
    assertEquals(.5,PhotoToneMap.curve(.5,peak),1e-12) // Below the knee nothing changes.
    assertEquals(1.0,PhotoToneMap.curve(peak,peak),1e-9)
    assertTrue(PhotoToneMap.curve(peak*.9,peak)<1.0) // No clipping before the peak.
    assertEquals(.9,PhotoToneMap.curve(.9,1.0),1e-12) // SDR content stays exact.
    val image=PhotoToneMap.map(floatArrayOf(1f,1f,1f,1f, 8f,8f,8f,1f, 0f,0f,0f,1f),3,1,8.0)
    assertTrue(level(image.pixels[0]) in 200..254);assertEquals(255,level(image.pixels[1]));assertEquals(0,level(image.pixels[2]))
    assertEquals(1.0,PhotoToneMap.peak(floatArrayOf(.2f,.2f,.2f,1f)),1e-12)
    assertEquals(64.0,PhotoToneMap.peak(floatArrayOf(1000f,1000f,1000f,1f)),1e-12)
  }
}
