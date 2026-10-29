package expo.modules.lineavideo

import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.SystemClock
import java.io.File

/** Source compressed audio is never copied: only fresh PCM is sent to AAC. */
class VideoAudio(private val input:File,private val track:Int,private val output:File) {
  private lateinit var extractor:MediaExtractor
  private var decoder:MediaCodec?=null
  private var encoder:MediaCodec?=null
  private var muxer:MediaMuxer?=null
  private var muxerTrack=-1
  private var inputDone=false
  private var decodedDone=false
  private var encodedDone=false
  private var pending:ByteArray?=null
  private var pendingOffset=0
  private var pendingTime=0L
  private var pendingEnd=false
  private var channels=0
  private var rate=0
  private var written=0L
  private val info=MediaCodec.BufferInfo()

  fun run() {
    extractor=VideoTracks.open(input)
    try {
      extractor.selectTrack(track)
      val format=extractor.getTrackFormat(track)
      val name=MediaCodecList(MediaCodecList.REGULAR_CODECS).findDecoderForFormat(format) ?: throw VideoFailure("AUDIO_DECODER_UNAVAILABLE")
      format.setInteger(MediaFormat.KEY_PCM_ENCODING,AudioFormat.ENCODING_PCM_16BIT)
      decoder=MediaCodec.createByCodecName(name)
      decoder!!.configure(format,null,null,0);decoder!!.start()
      muxer=MediaMuxer(output.absolutePath,MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      val started=SystemClock.elapsedRealtime();var lastProgress=started
      while(!encodedDone) {
        var progress=feedDecoder()
        if(drainDecoder())progress=true
        if(feedEncoder())progress=true
        if(drainEncoder())progress=true
        val now=SystemClock.elapsedRealtime()
        if(progress)lastProgress=now
        if(now-lastProgress>30000||now-started>600000)throw VideoFailure("CODEC_TIMEOUT")
      }
      if(muxerTrack<0||written==0L)throw VideoFailure("AUDIO_ENCODE_FAILED")
      muxer!!.stop()
    } finally {
      runCatching{decoder?.stop()};runCatching{decoder?.release()}
      runCatching{encoder?.stop()};runCatching{encoder?.release()}
      runCatching{muxer?.release()};extractor.release()
    }
  }
  private fun feedDecoder():Boolean {
    if(inputDone)return false
    val codec=decoder!!;val index=codec.dequeueInputBuffer(1000);if(index<0)return false
    val buffer=codec.getInputBuffer(index) ?: throw VideoFailure("AUDIO_DECODE_FAILED")
    val size=extractor.readSampleData(buffer,0)
    // At end of stream getSampleFlags() returns -1, which has every bit set: the encrypted
    // check must only look at real samples, or every clear video with sound is rejected.
    if(size>=0&&extractor.sampleFlags>=0&&(extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_ENCRYPTED)!=0)throw VideoFailure("DRM_UNSUPPORTED")
    if(size<0) {
      codec.queueInputBuffer(index,0,0,0,MediaCodec.BUFFER_FLAG_END_OF_STREAM);inputDone=true
    }else {
      val flags=if((extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_PARTIAL_FRAME)!=0)MediaCodec.BUFFER_FLAG_PARTIAL_FRAME else 0
      codec.queueInputBuffer(index,0,size,extractor.sampleTime,flags);extractor.advance()
    }
    return true
  }
  private fun startEncoder(format:MediaFormat) {
    if(encoder!=null)throw VideoFailure("AUDIO_FORMAT_CHANGED")
    channels=format.getInteger(MediaFormat.KEY_CHANNEL_COUNT);rate=format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
    val pcm=VideoTracks.integer(format,MediaFormat.KEY_PCM_ENCODING,AudioFormat.ENCODING_PCM_16BIT)
    if(channels !in 1..2||rate !in 8000..96000||pcm!=AudioFormat.ENCODING_PCM_16BIT)throw VideoFailure("UNSUPPORTED_AUDIO_FORMAT")
    val target=MediaFormat.createAudioFormat("audio/mp4a-latm",rate,channels).apply {
      setInteger(MediaFormat.KEY_AAC_PROFILE,MediaCodecInfo.CodecProfileLevel.AACObjectLC)
      setInteger(MediaFormat.KEY_BIT_RATE,if(channels==1)128000 else 256000)
      setInteger(MediaFormat.KEY_MAX_INPUT_SIZE,65536)
    }
    encoder=MediaCodec.createEncoderByType("audio/mp4a-latm")
    encoder!!.configure(target,null,null,MediaCodec.CONFIGURE_FLAG_ENCODE);encoder!!.start()
  }
  private fun drainDecoder():Boolean {
    if(decodedDone||pending!=null)return false
    val codec=decoder!!;val index=codec.dequeueOutputBuffer(info,1000)
    if(index==MediaCodec.INFO_OUTPUT_FORMAT_CHANGED){startEncoder(codec.outputFormat);return true}
    if(index<0)return false
    try {
      if(info.size<0||info.size>VideoPolicy.MAX_SAMPLE)throw VideoFailure("AUDIO_DECODE_FAILED")
      val buffer=codec.getOutputBuffer(index) ?: throw VideoFailure("AUDIO_DECODE_FAILED")
      buffer.position(info.offset);buffer.limit(info.offset+info.size)
      pending=ByteArray(info.size).also{buffer.get(it)};pendingOffset=0;pendingTime=info.presentationTimeUs
      pendingEnd=info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM!=0
      if(pendingEnd)decodedDone=true
    }finally{codec.releaseOutputBuffer(index,false)}
    return true
  }
  private fun feedEncoder():Boolean {
    val data=pending ?: return false;val codec=encoder ?: return false
    val index=codec.dequeueInputBuffer(1000);if(index<0)return false
    val buffer=codec.getInputBuffer(index) ?: throw VideoFailure("AUDIO_ENCODE_FAILED")
    buffer.clear();val frameBytes=channels*2
    if(data.size%frameBytes!=0)throw VideoFailure("AUDIO_DECODE_FAILED")
    val count=minOf(data.size-pendingOffset,buffer.remaining()/frameBytes*frameBytes)
    if(count==0&&pendingOffset<data.size)throw VideoFailure("AUDIO_ENCODE_FAILED")
    buffer.put(data,pendingOffset,count)
    val timestamp=pendingTime+pendingOffset.toLong()*1000000/(rate.toLong()*frameBytes)
    pendingOffset+=count;val complete=pendingOffset==data.size
    codec.queueInputBuffer(index,0,count,timestamp,if(complete&&pendingEnd)MediaCodec.BUFFER_FLAG_END_OF_STREAM else 0)
    if(complete)pending=null
    return true
  }
  private fun drainEncoder():Boolean {
    val codec=encoder ?: return false;val index=codec.dequeueOutputBuffer(info,1000)
    if(index==MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
      if(muxerTrack>=0)throw VideoFailure("AUDIO_FORMAT_CHANGED")
      muxerTrack=muxer!!.addTrack(VideoTracks.audioFormat(codec.outputFormat));muxer!!.start();return true
    }
    if(index<0)return false
    try {
      if(info.size>0&&info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG==0) {
        if(muxerTrack<0)throw VideoFailure("AUDIO_ENCODE_FAILED")
        written+=info.size;if(written>VideoPolicy.MAX_OUTPUT)throw VideoFailure("OUTPUT_TOO_LARGE")
        val buffer=codec.getOutputBuffer(index) ?: throw VideoFailure("AUDIO_ENCODE_FAILED")
        info.presentationTimeUs=maxOf(0,info.presentationTimeUs)
        muxer!!.writeSampleData(muxerTrack,buffer,info)
      }
      if(info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM!=0)encodedDone=true
    }finally{codec.releaseOutputBuffer(index,false)}
    return true
  }
}
