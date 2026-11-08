package expo.modules.lineavideo

class VideoFailure(val reason:String):Exception(reason)
object VideoPolicy {
  /** Big media goes through the JS streaming cleaner; the native remux only needs a sanity bound (Platina video: 10 GB). */
  const val MAX_INPUT=10L*1024*1024*1024
  const val MAX_SAMPLES=50_000_000
  const val MAX_OUTPUT=10L*1024*1024*1024
  const val MAX_SAMPLE=16*1024*1024
  const val MAX_DURATION_US=48L*60*60*1000000
  fun dimensions(width:Int,height:Int) {
    if(width<=0||height<=0||width>16384||height>16384)throw VideoFailure("VIDEO_DIMENSIONS")
  }
  fun validateDepth(depth:Int,hdr:String,transferKnown:Boolean) {
    if(depth !in 8..16)throw VideoFailure("UNSUPPORTED_VIDEO_CONFIG")
    if(depth>8&&!transferKnown)throw VideoFailure("UNKNOWN_HDR")
    if(hdr!="sdr"&&depth<10)throw VideoFailure("UNKNOWN_HDR")
  }
  fun hdr(transfer:Int,standard:Int):String = when(transfer) {
    0,3->"sdr"
    1->if(standard==6)throw VideoFailure("UNKNOWN_HDR") else "sdr"
    6,7->{if(standard!=6)throw VideoFailure("UNKNOWN_HDR");if(transfer==6)"pq" else "hlg"}
    else->throw VideoFailure("UNKNOWN_HDR")
  }
}
