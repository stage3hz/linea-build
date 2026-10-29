/** Types only. Importing these declarations never requires a native runtime. */
export type PhotoPoint = {x:number;y:number};
export type PhotoStroke = {radius:number;points:PhotoPoint[]};
/** Coordinates in the oriented original, before resolution, effects and scaling. */
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
  hdrPreservation:false;
  hdrReason:string;
};
export type PhotoInfo = {
  width:number;height:number;
  processingWidth:number;processingHeight:number;
  downsampled:boolean;
  dynamicRange:'sdr'|'hdr'|'unknown';
  dynamicRangeReason?:string;
};
export type NativePhotoResult = {
  uri:string;width:number;height:number;downsampled:boolean;
  format:'png'|'jpeg';mimeType:'image/png'|'image/jpeg';
};
export interface LineaPhotoBridge {
  capabilities():Promise<PhotoCapabilities>;
  inspect(uri:string):Promise<PhotoInfo>;
  render(uri:string,options:PhotoOptions):Promise<NativePhotoResult>;
  prepareBackground():Promise<PhotoCapabilities>;
  dispose(uri:string):Promise<void>;
  clearCache():Promise<void>;
}
