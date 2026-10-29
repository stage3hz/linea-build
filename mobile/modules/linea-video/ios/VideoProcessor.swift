import Foundation
import AVFoundation
import CoreMedia
import AudioToolbox

final class VideoProcessor {
  private let files=VideoFiles()
  func inspect(_ uri:String) throws -> [String:Any] {
    let source=try files.snapshot(uri)
    do {let result=try VideoTrackInfo(source).info(inputBytes:files.bytes(source));try files.remove(source);return result}
    catch{try? files.remove(source);throw error}
  }
  func sanitize(_ uri:String) throws -> [String:Any] {
    let source=try files.snapshot(uri);var output:URL?
    do {
      let track=try VideoTrackInfo(source);let destination=try files.newFile("video","mp4");output=destination
      try write(track,to:destination)
      let bytes=try files.finish(destination)
      var result=track.info(inputBytes:try files.bytes(source))
      result["uri"]=destination.absoluteString;result["mimeType"]="video/mp4"
      result["outputBytes"]=bytes;result["audioTranscoded"]=track.audio != nil
      try files.remove(source);return result
    }catch{try? files.remove(source);if let output=output {try? files.remove(output)};throw error}
  }
  private func write(_ track:VideoTrackInfo,to output:URL) throws {
    let reader=try AVAssetReader(asset:track.asset),writer=try AVAssetWriter(outputURL:output,fileType:.mp4)
    writer.metadata=[];writer.shouldOptimizeForNetworkUse=true
    let videoOutput=AVAssetReaderTrackOutput(track:track.video,outputSettings:nil)
    videoOutput.alwaysCopiesSampleData=true
    let videoInput=AVAssetWriterInput(mediaType:.video,outputSettings:nil,sourceFormatHint:track.format)
    videoInput.metadata=[];videoInput.expectsMediaDataInRealTime=false;videoInput.transform=track.transform
    guard reader.canAdd(videoOutput),writer.canAdd(videoInput) else {throw VideoFailure("UNSUPPORTED_VIDEO_CODEC")}
    reader.add(videoOutput);writer.add(videoInput)
    var paths=[Path(output:videoOutput,input:videoInput,video:true)]
    if let audio=track.audio {paths.append(try audioPath(audio,reader:reader,writer:writer))}
    do {
      guard writer.startWriting(),reader.startReading() else {throw VideoFailure("PROCESSING_FAILED")}
      writer.startSession(atSourceTime:.zero)
      try pump(paths,track:track,reader:reader,writer:writer,destination:output)
      guard reader.status == .completed else {throw VideoFailure("READ_FAILED")}
      let finished=DispatchSemaphore(value:0)
      writer.finishWriting{finished.signal()}
      guard finished.wait(timeout:.now()+30) == .success,writer.status == .completed else {throw VideoFailure("WRITE_FAILED")}
    }catch{reader.cancelReading();writer.cancelWriting();throw error}
  }
  private func audioPath(_ track:AVAssetTrack,reader:AVAssetReader,writer:AVAssetWriter) throws -> Path {
    guard let formats=track.formatDescriptions as? [CMFormatDescription],formats.count==1,
      let asbd=CMAudioFormatDescriptionGetStreamBasicDescription(formats[0])?.pointee else {throw VideoFailure("UNSUPPORTED_AUDIO_FORMAT")}
    guard asbd.mChannelsPerFrame>=1,asbd.mChannelsPerFrame<=2,asbd.mSampleRate.isFinite,asbd.mSampleRate>=8000,asbd.mSampleRate<=96000 else {throw VideoFailure("UNSUPPORTED_AUDIO_FORMAT")}
    let read:[String:Any]=[AVFormatIDKey:kAudioFormatLinearPCM,AVLinearPCMBitDepthKey:16,AVLinearPCMIsFloatKey:false,AVLinearPCMIsBigEndianKey:false,AVLinearPCMIsNonInterleaved:false]
    let output=AVAssetReaderTrackOutput(track:track,outputSettings:read)
    output.alwaysCopiesSampleData=true
    let settings:[String:Any]=[AVFormatIDKey:kAudioFormatMPEG4AAC,AVSampleRateKey:asbd.mSampleRate,AVNumberOfChannelsKey:asbd.mChannelsPerFrame,AVEncoderBitRateKey:asbd.mChannelsPerFrame==1 ? 128000:256000]
    guard writer.canApply(outputSettings:settings,forMediaType:.audio) else {throw VideoFailure("AUDIO_ENCODER_UNAVAILABLE")}
    let input=AVAssetWriterInput(mediaType:.audio,outputSettings:settings)
    input.metadata=[];input.expectsMediaDataInRealTime=false
    guard reader.canAdd(output),writer.canAdd(input) else {throw VideoFailure("AUDIO_DECODER_UNAVAILABLE")}
    reader.add(output);writer.add(input);return Path(output:output,input:input,video:false)
  }
  private func pump(_ paths:[Path],track:VideoTrackInfo,reader:AVAssetReader,writer:AVAssetWriter,destination:URL) throws {
    let started=Date();var progress=started;var samples=0;var videos=0
    while paths.contains(where:{!$0.ended}) {
      var moved=false
      for path in paths where !path.ended && path.input.isReadyForMoreMediaData {
        guard let sample=path.output.copyNextSampleBuffer() else {path.ended=true;path.input.markAsFinished();moved=true;continue}
        samples+=1;if samples>1000000 {throw VideoFailure("TOO_MANY_SAMPLES")}
        let clean:CMSampleBuffer?
        if path.video {clean=try VideoSamples.video(sample,track:track)} else {clean=try VideoSamples.audio(sample)}
        if let clean=clean {guard path.input.append(clean) else {throw VideoFailure("WRITE_FAILED")};if path.video {videos+=1}}
        moved=true
      }
      if reader.status == .failed || writer.status == .failed {throw VideoFailure("PROCESSING_FAILED")}
      if moved {progress=Date()} else {Thread.sleep(forTimeInterval:0.001)}
      if Date().timeIntervalSince(progress)>30||Date().timeIntervalSince(started)>600 {throw VideoFailure("CODEC_TIMEOUT")}
      if samples%64==0 {let written=try files.bytes(destination);if written>VideoPolicy.maxOutput {throw VideoFailure("OUTPUT_TOO_LARGE")}}
    }
    if videos==0 {throw VideoFailure("EMPTY_TRACK")}
  }
  private final class Path {
    let output:AVAssetReaderTrackOutput;let input:AVAssetWriterInput;let video:Bool;var ended=false
    init(output:AVAssetReaderTrackOutput,input:AVAssetWriterInput,video:Bool){self.output=output;self.input=input;self.video=video}
  }
}
