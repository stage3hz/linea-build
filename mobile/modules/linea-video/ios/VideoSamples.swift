import Foundation
import AVFoundation
import CoreMedia
import AudioToolbox

enum VideoSamples {
  static func video(_ source:CMSampleBuffer,track:VideoTrackInfo) throws -> CMSampleBuffer? {
    guard CMSampleBufferGetNumSamples(source)==1,
      let format=CMSampleBufferGetFormatDescription(source),CMFormatDescriptionEqual(format,otherFormatDescription:track.original) else {throw VideoFailure("VIDEO_FORMAT_CHANGED")}
    let clean=try VideoNal.clean(data(source),hevc:track.hevc,hdr:track.hdr,lengthBytes:track.lengthBytes)
    if clean.isEmpty {return nil}
    let result=try make(clean,format:track.format,source:source,sampleCount:1,sampleSize:clean.count)
    try copySampleFlags(source,to:result)
    return result
  }
  static func audio(_ source:CMSampleBuffer) throws -> CMSampleBuffer {
    guard let original=CMSampleBufferGetFormatDescription(source),let pointer=CMAudioFormatDescriptionGetStreamBasicDescription(original) else {throw VideoFailure("AUDIO_DECODE_FAILED")}
    var asbd=pointer.pointee
    guard asbd.mFormatID==kAudioFormatLinearPCM,asbd.mChannelsPerFrame>=1,asbd.mChannelsPerFrame<=2,
      asbd.mBitsPerChannel==16,asbd.mBytesPerFrame==asbd.mChannelsPerFrame*2,
      asbd.mSampleRate.isFinite,asbd.mSampleRate>=8000,asbd.mSampleRate<=96000,
      asbd.mFormatFlags & (kAudioFormatFlagIsFloat|kAudioFormatFlagIsNonInterleaved)==0 else {throw VideoFailure("UNSUPPORTED_AUDIO_FORMAT")}
    var format:CMAudioFormatDescription?
    let status=CMAudioFormatDescriptionCreate(allocator:kCFAllocatorDefault,asbd:&asbd,layoutSize:0,layout:nil,magicCookieSize:0,magicCookie:nil,extensions:nil,formatDescriptionOut:&format)
    guard status==noErr,let format=format else {throw VideoFailure("AUDIO_DECODE_FAILED")}
    let pcm=try data(source),count=CMSampleBufferGetNumSamples(source)
    guard count>0,pcm.count==count*Int(asbd.mBytesPerFrame) else {throw VideoFailure("AUDIO_DECODE_FAILED")}
    let result=try make(pcm,format:format,source:source,sampleCount:count,sampleSize:Int(asbd.mBytesPerFrame))
    try copyTrim(source,to:result)
    return result
  }
  private static func data(_ sample:CMSampleBuffer) throws -> Data {
    guard let block=CMSampleBufferGetDataBuffer(sample) else {throw VideoFailure("UNSUPPORTED_SAMPLE")}
    let length=CMBlockBufferGetDataLength(block)
    guard length>0,length<=VideoPolicy.maxSample else {throw VideoFailure("UNSUPPORTED_SAMPLE")}
    var result=Data(count:length)
    let status=result.withUnsafeMutableBytes {CMBlockBufferCopyDataBytes(block,atOffset:0,dataLength:length,destination:$0.baseAddress!)}
    guard status==kCMBlockBufferNoErr else {throw VideoFailure("UNSUPPORTED_SAMPLE")}
    return result
  }
  private static func make(_ data:Data,format:CMFormatDescription,source:CMSampleBuffer,sampleCount:Int,sampleSize:Int) throws -> CMSampleBuffer {
    var block:CMBlockBuffer?
    let created=CMBlockBufferCreateWithMemoryBlock(allocator:kCFAllocatorDefault,memoryBlock:nil,blockLength:data.count,blockAllocator:kCFAllocatorDefault,customBlockSource:nil,offsetToData:0,dataLength:data.count,flags:0,blockBufferOut:&block)
    guard created==kCMBlockBufferNoErr,let block=block else {throw VideoFailure("OUT_OF_MEMORY")}
    let replaced=data.withUnsafeBytes{CMBlockBufferReplaceDataBytes(with:$0.baseAddress!,blockBuffer:block,offsetIntoDestination:0,dataLength:data.count)}
    guard replaced==kCMBlockBufferNoErr else {throw VideoFailure("PROCESSING_FAILED")}
    var timing=CMSampleTimingInfo()
    guard CMSampleBufferGetSampleTimingInfo(source,at:0,timingInfoOut:&timing)==noErr else {throw VideoFailure("UNSUPPORTED_TIMESTAMP")}
    let seconds=CMTimeGetSeconds(timing.presentationTimeStamp)
    guard seconds.isFinite,seconds>=0,seconds<=VideoPolicy.maxDuration else {throw VideoFailure("UNSUPPORTED_TIMESTAMP")}
    var size=sampleSize;var output:CMSampleBuffer?
    let status=CMSampleBufferCreateReady(allocator:kCFAllocatorDefault,dataBuffer:block,formatDescription:format,sampleCount:sampleCount,sampleTimingEntryCount:1,sampleTimingArray:&timing,sampleSizeEntryCount:1,sampleSizeArray:&size,sampleBufferOut:&output)
    guard status==noErr,let output=output else {throw VideoFailure("PROCESSING_FAILED")}
    return output
  }
  private static func copySampleFlags(_ source:CMSampleBuffer,to target:CMSampleBuffer) throws {
    guard let sourceArray=CMSampleBufferGetSampleAttachmentsArray(source,createIfNecessary:false) as? [[String:Any]],let values=sourceArray.first else {return}
    guard let targetArray=CMSampleBufferGetSampleAttachmentsArray(target,createIfNecessary:true) as? [NSMutableDictionary],let dictionary=targetArray.first else {throw VideoFailure("PROCESSING_FAILED")}
    for key in [kCMSampleAttachmentKey_NotSync,kCMSampleAttachmentKey_DependsOnOthers,kCMSampleAttachmentKey_IsDependedOnByOthers,kCMSampleAttachmentKey_HasRedundantCoding] {
      if let raw=values[key as String] {guard let value=raw as? Bool else {throw VideoFailure("UNSUPPORTED_SAMPLE")};dictionary[key as String]=value}
    }
  }
  private static func copyTrim(_ source:CMSampleBuffer,to target:CMSampleBuffer) throws {
    for key in [kCMSampleBufferAttachmentKey_TrimDurationAtStart,kCMSampleBufferAttachmentKey_TrimDurationAtEnd] {
      if let raw=CMGetAttachment(source,key:key,attachmentModeOut:nil) {
        guard let dictionary=raw as? [String:Any] else {throw VideoFailure("UNSUPPORTED_TIMESTAMP")}
        let original=CMTimeMakeFromDictionary(dictionary as CFDictionary),seconds=CMTimeGetSeconds(CMTimeMakeFromDictionary(dictionary as CFDictionary))
        guard seconds.isFinite,seconds>=0,seconds<=VideoPolicy.maxDuration,original.timescale>0 else {throw VideoFailure("UNSUPPORTED_TIMESTAMP")}
        let clean=CMTime(value:original.value,timescale:original.timescale)
        if let value=CMTimeCopyAsDictionary(clean,allocator:kCFAllocatorDefault){CMSetAttachment(target,key:key,value:value,attachmentMode:kCMAttachmentMode_ShouldPropagate)}
      }
    }
  }
}
