package expo.modules.lineavideo

import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaCodecList
import java.io.File
import java.nio.ByteBuffer

data class VideoTracks(val video:Int,val audio:Int?,val format:MediaFormat,val hdr:String,val durationUs:Long,val rotation:Int,val removed:Int) {
  val hevc get()=format.getString(MediaFormat.KEY_MIME)=="video/hevc"
  fun info(bytes:Long):Map<String,Any> = mapOf(
    "width" to format.getInteger(MediaFormat.KEY_WIDTH),"height" to format.getInteger(MediaFormat.KEY_HEIGHT),
    "durationMs" to durationUs/1000.0,"rotation" to rotation,"videoCodec" to if(hevc)"hevc" else "avc",
    "hasAudio" to (audio!=null),"hdr" to hdr,"inputBytes" to bytes,"removedTrackCount" to removed
  )
  companion object {
    fun open(file:File):MediaExtractor {
      val extractor=MediaExtractor()
      try {
        extractor.setDataSource(file.absolutePath)
        if(extractor.drmInitData!=null||!extractor.psshInfo.isNullOrEmpty())throw VideoFailure("DRM_UNSUPPORTED")
        return extractor
      }catch(error:Throwable){extractor.release();throw error}
    }
    fun inspect(extractor:MediaExtractor):VideoTracks {
      if(extractor.trackCount !in 1..32)throw VideoFailure("UNSUPPORTED_TRACKS")
      val video=ArrayList<Int>();val audio=ArrayList<Int>()
      for(index in 0 until extractor.trackCount) {
        val mime=extractor.getTrackFormat(index).getString(MediaFormat.KEY_MIME) ?: ""
        if(mime.startsWith("video/"))video.add(index)
        if(mime.startsWith("audio/"))audio.add(index)
      }
      if(video.isEmpty()&&audio.isNotEmpty()&&audio.size==extractor.trackCount) {
        val codecs=MediaCodecList(MediaCodecList.REGULAR_CODECS)
        if(audio.all{codecs.findDecoderForFormat(extractor.getTrackFormat(it))!=null})throw VideoFailure("NO_VIDEO_TRACK")
      }
      if(video.size!=1||audio.size>1)throw VideoFailure("UNSUPPORTED_TRACKS")
      val format=extractor.getTrackFormat(video[0]);val mime=format.getString(MediaFormat.KEY_MIME)
      if(mime !in setOf("video/avc","video/hevc"))throw VideoFailure("UNSUPPORTED_CODEC")
      VideoPolicy.dimensions(format.getInteger(MediaFormat.KEY_WIDTH),format.getInteger(MediaFormat.KEY_HEIGHT))
      val duration=if(format.containsKey(MediaFormat.KEY_DURATION))format.getLong(MediaFormat.KEY_DURATION) else 0
      if(duration<=0||duration>VideoPolicy.MAX_DURATION_US)throw VideoFailure("UNSUPPORTED_DURATION")
      val rotation=(integer(format,MediaFormat.KEY_ROTATION,0)%360+360)%360
      if(rotation !in setOf(0,90,180,270))throw VideoFailure("UNSUPPORTED_TRANSFORM")
      if(format.containsKey("hdr10-plus-info")||integer(format,MediaFormat.KEY_PROFILE,0)==8192)throw VideoFailure("DYNAMIC_HDR_UNSUPPORTED")
      // Android only documents muxing this descriptor into WebM, not MP4.
      if(format.containsKey(MediaFormat.KEY_HDR_STATIC_INFO))throw VideoFailure("HDR_CONTAINER_UNSUPPORTED")
      val hdr=VideoPolicy.hdr(integer(format,MediaFormat.KEY_COLOR_TRANSFER,0),integer(format,MediaFormat.KEY_COLOR_STANDARD,0))
      return VideoTracks(video[0],audio.firstOrNull(),format,hdr,duration,rotation,extractor.trackCount-video.size-audio.size)
    }
    fun integer(format:MediaFormat,key:String,fallback:Int):Int=if(format.containsKey(key))format.getInteger(key) else fallback
    fun bytes(format:MediaFormat,key:String):ByteArray? {
      val data=if(format.containsKey(key))format.getByteBuffer(key)?.duplicate() else null
      if(data==null)return null
      if(data.remaining()>VideoPolicy.MAX_SAMPLE)throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")
      return ByteArray(data.remaining()).also{data.get(it)}
    }
    fun videoFormat(tracks:VideoTracks):MediaFormat {
      val source=tracks.format
      val output=MediaFormat.createVideoFormat(source.getString(MediaFormat.KEY_MIME)!!,source.getInteger(MediaFormat.KEY_WIDTH),source.getInteger(MediaFormat.KEY_HEIGHT))
      var configs=0;val parameterSets=ArrayList<ByteArray>()
      for(index in 0..2) {
        val key="csd-$index";val data=bytes(source,key) ?: continue
        val clean=VideoNal.cleanConfig(data,tracks.hevc,tracks.hdr)
        parameterSets.addAll(VideoNal.annexUnits(clean))
        output.setByteBuffer(key,ByteBuffer.wrap(clean));configs++
      }
      if(configs==0)throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")
      val sps=parameterSets.filter{if(tracks.hevc)((it[0].toInt() ushr 1) and 63)==33 else (it[0].toInt() and 31)==7}
      if(sps.isEmpty())throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")
      for(nal in sps)VideoPolicy.validateDepth(VideoBits.depth(nal,tracks.hevc),tracks.hdr,integer(source,MediaFormat.KEY_COLOR_TRANSFER,0)!=0)
      for(key in listOf(MediaFormat.KEY_COLOR_STANDARD,MediaFormat.KEY_COLOR_TRANSFER,MediaFormat.KEY_COLOR_RANGE,"sar-width","sar-height")) {
        if(source.containsKey(key))output.setInteger(key,source.getInteger(key))
      }
      return output
    }
    /** Called only for output produced by our fresh AAC encoder. */
    fun audioFormat(source:MediaFormat):MediaFormat {
      val output=MediaFormat.createAudioFormat("audio/mp4a-latm",source.getInteger(MediaFormat.KEY_SAMPLE_RATE),source.getInteger(MediaFormat.KEY_CHANNEL_COUNT))
      val config=bytes(source,"csd-0") ?: throw VideoFailure("AUDIO_CONFIG_FAILED")
      if(config.size !in 2..64)throw VideoFailure("AUDIO_CONFIG_FAILED")
      output.setByteBuffer("csd-0",ByteBuffer.wrap(config))
      for(key in listOf(MediaFormat.KEY_BIT_RATE,MediaFormat.KEY_AAC_PROFILE,MediaFormat.KEY_ENCODER_DELAY,MediaFormat.KEY_ENCODER_PADDING)) {
        if(source.containsKey(key))output.setInteger(key,source.getInteger(key))
      }
      return output
    }
  }
}
