package expo.modules.lineaphoto

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** The same golden table as test/photo-geometry.test.mjs: preview geometry (TS) == native plan (Kotlin). */
class PhotoGeometryGoldenTest {
  /** Walks up from the working directory (jvm-tests, android module or repo root) to mobile/test/fixtures. */
  private fun golden():Map<*,*> {
    System.getProperty("geometry.golden")?.let{File(it)}?.takeIf{it.isFile}?.let{return MiniJson(it.readText()).value() as Map<*,*>}
    var dir:File?=File(System.getProperty("user.dir")).absoluteFile
    while(dir!=null) {
      for(candidate in listOf(File(dir,"test/fixtures/geometry-cases.json"),File(dir,"mobile/test/fixtures/geometry-cases.json")))
        if(candidate.isFile)return MiniJson(candidate.readText()).value() as Map<*,*>
      dir=dir.parentFile
    }
    fail("geometry-cases.json not found above ${System.getProperty("user.dir")}");throw IllegalStateException()
  }
  private fun int(value:Any?)=(value as Double).toInt()

  @Test fun everyGoldenCaseMatchesPhotoDimensions() {
    val cases=golden()["cases"] as List<*>
    assertTrue(cases.size>=100)
    for(raw in cases) {
      val item=raw as Map<*,*>;val source=item["source"] as Map<*,*>;val expected=item["expected"] as Map<*,*>
      val options=mutableMapOf<String,Any?>("background" to "keep","document" to if(item["effects"]==true)"color" else "none","scale" to item["scale"],"strokes" to emptyList<Any>(),
        "allowDownsample" to true,"resolution" to item["resolution"],"rotation" to item["rotation"],"flip" to item["flip"])
      item["crop"]?.let{options["crop"]=it}
      val parsed=PhotoOptions.parse(options)
      val plan=PhotoDimensions.plan(int(source["width"]),int(source["height"]),parsed)
      val crop=expected["crop"] as Map<*,*>
      val label=item.toString()
      assertEquals(label,PhotoRect(int(crop["x"]),int(crop["y"]),int(crop["width"]),int(crop["height"])),plan.crop)
      assertEquals(label,int(expected["width"]),plan.width);assertEquals(label,int(expected["height"]),plan.height)
      assertEquals(label,expected["downsampled"],plan.downsampled)
      // Touch points (brush and pen) map to the same output coordinates as in the TS preview.
      for(rawPoint in item["points"] as List<*>) {
        val point=rawPoint as Map<*,*>;val src=point["source"] as Map<*,*>;val rot=point["rotated"] as Map<*,*>;val out=point["output"] as Map<*,*>
        val (rx,ry)=PhotoDimensions.mapPoint(src["x"] as Double,src["y"] as Double,parsed.rotation,parsed.flip)
        assertEquals(label,rot["x"] as Double,rx,1e-6);assertEquals(label,rot["y"] as Double,ry,1e-6)
        val (ox,oy)=PhotoDimensions.outputPoint(src["x"] as Double,src["y"] as Double,int(source["width"]),int(source["height"]),parsed.rotation,parsed.flip,plan.crop)
        assertEquals(label,out["x"] as Double,ox,1e-6);assertEquals(label,out["y"] as Double,oy,1e-6)
      }
      if(expected["cropSourceTooLarge"]==true) {
        try{PhotoDimensions.decodeSize(int(source["width"]),int(source["height"]),plan,parsed.rotation);fail(label)}catch(error:PhotoFailure){assertEquals("CROP_SOURCE_TOO_LARGE",error.reason)}
      } else {
        val decode=PhotoDimensions.decodeSize(int(source["width"]),int(source["height"]),plan,parsed.rotation)
        assertEquals(label,int(expected["decodeWidth"]) to int(expected["decodeHeight"]),decode)
      }
    }
  }
}

/** Minimal JSON reader for the golden file (objects, arrays, numbers, strings, booleans, null). */
class MiniJson(private val text:String) {
  private var at=0
  fun value():Any? {
    space()
    return when(val c=text[at]) {
      '{'->{at++;val result=linkedMapOf<String,Any?>();space();if(text[at]=='}'){at++;return result}
        while(true){space();val key=string();space();expect(':');result[key]=value();space();if(text[at]==','){at++;continue};expect('}');return result}}
      '['->{at++;val result=ArrayList<Any?>();space();if(text[at]==']'){at++;return result}
        while(true){result.add(value());space();if(text[at]==','){at++;continue};expect(']');return result}}
      '"'->string()
      't'->{at+=4;true}
      'f'->{at+=5;false}
      'n'->{at+=4;null}
      else->{val start=at;while(at<text.length&&(text[at].isDigit()||text[at] in "+-.eE"))at++;if(start==at)error("bad JSON at $at: $c");text.substring(start,at).toDouble()}
    }
  }
  private fun string():String {expect('"');val out=StringBuilder();while(text[at]!='"'){if(text[at]=='\\'){at++;out.append(when(text[at]){'n'->'\n';'t'->'\t';else->text[at]})}else out.append(text[at]);at++};at++;return out.toString()}
  private fun expect(c:Char){if(text[at]!=c)error("expected $c at $at");at++}
  private fun space(){while(at<text.length&&text[at].isWhitespace())at++}
}
