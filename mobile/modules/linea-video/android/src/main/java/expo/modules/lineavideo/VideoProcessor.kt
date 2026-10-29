package expo.modules.lineavideo

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaMuxer
import android.net.Uri
import android.os.SystemClock
import java.io.File
import java.nio.ByteBuffer

class VideoProcessor(private val files:VideoFiles) {
  fun inspect(uri:String):Map<String,Any> {
    val source=files.snapshot(uri)
    try { val extractor=VideoTracks.open(source);try{return VideoTracks.inspect(extractor).info(source.length())}finally{extractor.release()} }
    finally{files.remove(source)}
  }
  fun sanitize(uri:String):Map<String,Any> {
    val source=files.snapshot(uri);val temporary=ArrayList<File>();temporary.add(source)
    try {
      val extractor=VideoTracks.open(source)
      try {
        val tracks=VideoTracks.inspect(extractor)
        val audio=tracks.audio?.let { index -> files.newFile("audio","m4a").also { temporary.add(it);VideoAudio(source,index,it).run();files.validateOutput(it) } }
        val output=files.newFile("video","mp4");temporary.add(output)
        remux(extractor,tracks,audio,output);files.validateOutput(output)
        val result=tracks.info(source.length())+mapOf("uri" to Uri.fromFile(output).toString(),"mimeType" to "video/mp4","outputBytes" to output.length(),"audioTranscoded" to (audio!=null))
        temporary.filter{it!=output}.forEach{files.remove(it)}
        return result
      }finally{extractor.release()}
    }catch(error:Throwable){temporary.forEach{runCatching{files.remove(it)}};throw error}
  }
  private fun remux(video:MediaExtractor,tracks:VideoTracks,audioFile:File?,output:File) {
    val videoFormat=VideoTracks.videoFormat(tracks)
    var audio:MediaExtractor?=null;var muxer:MediaMuxer?=null
    try {
      audio=audioFile?.let{VideoTracks.open(it)}
      muxer=MediaMuxer(output.absolutePath,MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      val videoTrack=muxer.addTrack(videoFormat)
      val audioTrack=audio?.let {
        if(it.trackCount!=1)throw VideoFailure("AUDIO_ENCODE_FAILED")
        it.selectTrack(0);muxer.addTrack(VideoTracks.audioFormat(it.getTrackFormat(0)))
      }
      muxer.setOrientationHint(tracks.rotation);muxer.start();video.selectTrack(tracks.video)
      copyTrack(video,muxer,videoTrack,tracks)
      if(audio!=null&&audioTrack!=null)copyTrack(audio,muxer,audioTrack,null)
      muxer.stop()
    }finally{runCatching{muxer?.release()};audio?.release()}
  }
  private fun copyTrack(extractor:MediaExtractor,muxer:MediaMuxer,track:Int,video:VideoTracks?) {
    val buffer=ByteBuffer.allocateDirect(VideoPolicy.MAX_SAMPLE);val info=MediaCodec.BufferInfo()
    var written=0L;var samples=0;val started=SystemClock.elapsedRealtime()
    while(true) {
      buffer.clear();val size=extractor.readSampleData(buffer,0);if(size<0)break
      if(size<=0||size>VideoPolicy.MAX_SAMPLE||++samples>1000000)throw VideoFailure("MALFORMED_VIDEO")
      if(extractor.sampleFlags and (MediaExtractor.SAMPLE_FLAG_ENCRYPTED or MediaExtractor.SAMPLE_FLAG_PARTIAL_FRAME)!=0)throw VideoFailure("UNSUPPORTED_SAMPLE")
      val timestamp=extractor.sampleTime
      if(timestamp<0||timestamp>VideoPolicy.MAX_DURATION_US)throw VideoFailure("UNSUPPORTED_TIMESTAMP")
      val source=ByteArray(size);buffer.position(0);buffer.get(source)
      val clean=if(video!=null)VideoNal.cleanSample(source,video.hevc,video.hdr) else source
      written+=clean.size;if(written>VideoPolicy.MAX_OUTPUT)throw VideoFailure("OUTPUT_TOO_LARGE")
      if(clean.isNotEmpty()) {
        info.set(0,clean.size,timestamp,extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC)
        muxer.writeSampleData(track,ByteBuffer.wrap(clean),info)
      }
      if(SystemClock.elapsedRealtime()-started>600000)throw VideoFailure("CODEC_TIMEOUT")
      extractor.advance()
    }
    if(samples==0)throw VideoFailure("EMPTY_TRACK")
  }
}
