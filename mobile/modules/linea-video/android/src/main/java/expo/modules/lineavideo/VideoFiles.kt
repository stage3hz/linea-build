package expo.modules.lineavideo

import android.content.Context
import android.net.Uri
import java.io.File
import java.util.UUID

/** A private snapshot avoids reading a changing content provider during remux. */
class VideoFiles(private val context:Context) {
  private val names=Regex("linea-native-(video|input|audio)-[0-9a-fA-F-]{36}\\.(mp4|bin|m4a)")
  private val folder:File get()=File(context.cacheDir,"linea-video").apply {
    if(!exists()&&!mkdirs())throw VideoFailure("WRITE_FAILED")
  }.canonicalFile
  fun newFile(kind:String,extension:String):File=File(folder,"linea-native-$kind-${UUID.randomUUID()}.$extension")
  fun snapshot(uri:String):File {
    val parsed=Uri.parse(uri)
    if(parsed.scheme !in setOf("file","content"))throw VideoFailure("LOCAL_FILE_REQUIRED")
    if(parsed.scheme=="file"&&(!parsed.host.isNullOrEmpty()||parsed.query!=null||parsed.fragment!=null))throw VideoFailure("LOCAL_FILE_REQUIRED")
    val file=newFile("input","bin")
    try {
      val input=context.contentResolver.openInputStream(parsed) ?: throw VideoFailure("READ_FAILED")
      input.use { source -> file.outputStream().use { output ->
        val buffer=ByteArray(65536);var total=0L
        while(true) {
          val count=source.read(buffer);if(count<0)break
          total+=count;if(total>VideoPolicy.MAX_INPUT)throw VideoFailure("INPUT_TOO_LARGE")
          output.write(buffer,0,count)
        }
        if(total==0L)throw VideoFailure("READ_FAILED")
      } }
      return file
    } catch(error:Throwable) { file.delete();throw error }
  }
  fun validateOutput(file:File) {
    if(file.length()<=0)throw VideoFailure("WRITE_FAILED")
    if(file.length()>VideoPolicy.MAX_OUTPUT)throw VideoFailure("OUTPUT_TOO_LARGE")
  }
  fun remove(file:File) {
    if(file.canonicalFile.parentFile!=folder||!names.matches(file.name))throw VideoFailure("INVALID_OUTPUT")
    if(file.exists()&&!file.delete())throw VideoFailure("DELETE_FAILED")
  }
  fun dispose(uri:String) {
    val parsed=Uri.parse(uri)
    if(parsed.scheme!="file"||!parsed.host.isNullOrEmpty()||parsed.query!=null||parsed.fragment!=null)throw VideoFailure("INVALID_OUTPUT")
    val file=File(parsed.path ?: throw VideoFailure("INVALID_OUTPUT"))
    if(!file.name.startsWith("linea-native-video-")||file.extension!="mp4")throw VideoFailure("INVALID_OUTPUT")
    remove(file)
  }
  fun clearCache() { folder.listFiles()?.filter{it.isFile&&names.matches(it.name)}?.forEach{remove(it)} }
}
