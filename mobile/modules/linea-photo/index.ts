/** Types only. Importing these declarations never requires a native runtime. */
export type PhotoPoint = {x:number;y:number};
/** Object-removal brush. Points are normalized to the rendered output frame (after rotation and crop);
 * they may lie slightly outside 0…1 when a stroke crosses the crop edge. radius: share of min(width,height). */
export type PhotoStroke = {radius:number;points:PhotoPoint[]};
/** Pen drawing, rendered after the effects. Same coordinates as strokes; width: share of min(width,height). */
export type PhotoDrawing = {color:string;width:number;points:PhotoPoint[]};
/** Normalized to the rotated frame (oriented original turned by `rotation`, then mirrored by `flip`). */
export type PhotoCrop = {x:number;y:number;width:number;height:number};
export type PhotoOptions = {
  background:'keep'|'transparent'|'white';
  document:'none'|'bw'|'color';
  scale:1|2|4;
  strokes:PhotoStroke[];
  allowDownsample?:boolean;
  format?:'png'|'jpeg';
  resolution?:1|0.5;
  crop?:PhotoCrop;
  /** Clockwise, applied to the oriented original before the crop. */
  rotation?:0|90|180|270;
  /** Horizontal mirror after the rotation. */
  flip?:boolean;
  drawings?:PhotoDrawing[];
  /** 'sdr' is the user's explicit consent to drop HDR (gain map) or tone-map an HDR base. Default 'keep'. */
  dynamicRange?:'keep'|'sdr';
  /** Fast on-screen preview: at most maxPixels, no reduction consent, SDR output, never uploaded. */
  preview?:{maxPixels:number};
};
export type PhotoCapabilities = {
  backgroundRemoval:boolean;
  backgroundReady:boolean;
  backgroundReason?:string;
  objectRemoval:'diffusion';
  upscale:'bicubic';
  maxPlainPixels:16000000;
  maxProcessingPixels:4000000;
  maxOutputPixels:8000000;
  /** This OS can keep a gain map through edits (Android 14+, iOS 18+). */
  hdrPreservation:boolean;
  hdrReason:string;
};
export type PhotoInfo = {
  width:number;height:number;
  processingWidth:number;processingHeight:number;
  downsampled:boolean;
  dynamicRange:'sdr'|'hdr'|'unknown';
  dynamicRangeReason?:string;
  /** gainmap: SDR base + gain map (kept on capable systems); pq/hlg: HDR base that needs tone mapping for SDR. */
  hdrKind?:'gainmap'|'pq'|'hlg';
  /** The gain map of this file can be kept through edits on this device. */
  hdrPreservable?:boolean;
};
export type NativePhotoResult = {
  uri:string;width:number;height:number;downsampled:boolean;
  format:'png'|'jpeg';mimeType:'image/png'|'image/jpeg';
  /** The JPEG carries a gain map (Ultra HDR / ISO 21496-1). */
  hdr?:'gainmap';
};
export interface LineaPhotoBridge {
  /** iOS: Center Stage for the front camera (iPhone 17 family); Android: absent. */
  setCenterStage?(enabled:boolean):Promise<{supported:boolean;enabled:boolean}>;
  capabilities():Promise<PhotoCapabilities>;
  inspect(uri:string):Promise<PhotoInfo>;
  render(uri:string,options:PhotoOptions):Promise<NativePhotoResult>;
  prepareBackground():Promise<PhotoCapabilities>;
  dispose(uri:string):Promise<void>;
  clearCache():Promise<void>;
  /** iOS: Quick Look preview inside the app. false = this type cannot be previewed. */
  previewFile?(uri:string):Promise<boolean>;
}
