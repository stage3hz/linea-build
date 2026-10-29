/** Native bridge contract; importing this file does not load native code. */
export type VideoHdr = 'sdr'|'pq'|'hlg';
export type NativeVideoInfo = {
  width:number;height:number;durationMs:number;rotation:0|90|180|270;
  videoCodec:'avc'|'hevc';hasAudio:boolean;hdr:VideoHdr;
  inputBytes:number;removedTrackCount:number;
};
export type NativeVideoResult = NativeVideoInfo & {
  uri:string;mimeType:'video/mp4';outputBytes:number;audioTranscoded:boolean;
};
export type VideoCapabilities = {
  videoCodecs:readonly ['avc','hevc'];outputMimeType:'video/mp4';
  hdr:readonly ['sdr','pq','hlg'];dynamicHdr:false;audio:'system-decode-to-aac';
  maxInputBytes:number;maxOutputBytes:number;
};
export interface LineaVideoBridge {
  capabilities():Promise<VideoCapabilities>;
  /** iOS only; call after an explicit user Add action. May fetch from iCloud. */
  resolveLibraryAsset(assetId:string):Promise<{uri:string;owned:boolean}>;
  inspect(uri:string):Promise<NativeVideoInfo>;
  sanitize(uri:string):Promise<NativeVideoResult>;
  dispose(uri:string):Promise<void>;
  clearCache():Promise<void>;
}
