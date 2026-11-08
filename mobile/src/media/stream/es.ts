// Elementary-stream scanner for containers that cut video into small packets (MPEG-TS, MPEG-PS): payload pieces
// are collected with their file offsets, NAL/start-code units are cleaned on a contiguous copy, and only the
// changed bytes go back into the plan as patches at their original offsets (same size, deterministic).
import { neutraliseFrame, type FrameMode } from './nal.ts';
import type { PlanBuilder } from './source.ts';

const FLUSH=8*1024*1024,MAX_UNIT=64*1024*1024;

export class EsScanner {
  mode:FrameMode;hevc:boolean;builder:PlanBuilder;parts:{offset:number;data:Uint8Array}[]=[];total=0;
  constructor(builder:PlanBuilder,mode:FrameMode,hevc=false){this.builder=builder;this.mode=mode;this.hevc=hevc;}
  push(offset:number,data:Uint8Array):void{
    if(!data.length)return;
    this.parts.push({offset,data});this.total+=data.length;
    if(this.total>=FLUSH)this.process(false);
  }
  flush():void{this.process(true);}
  private process(final:boolean):void{
    if(!this.parts.length)return;
    const buffer=new Uint8Array(this.total);let at=0;
    for(const part of this.parts){buffer.set(part.data,at);at+=part.data.length;}
    // Everything up to the last start code is complete; the unit after it may continue in the next packets.
    let cut=buffer.length;
    if(!final){
      cut=-1;for(let i=buffer.length-3;i>=0;i--)if(buffer[i]===0&&buffer[i+1]===0&&buffer[i+2]===1){cut=i;break;}
      if(cut<=0){if(buffer.length<MAX_UNIT)return;cut=buffer.length;} // a unit longer than 64 MiB is not video
    }
    const region=buffer.slice(0,cut);
    neutraliseFrame(region,this.mode,this.hevc,4);
    let logical=0;
    for(const part of this.parts){
      const from=logical,to=Math.min(cut,logical+part.data.length);
      if(to>from)this.builder.diff(part.offset,buffer.subarray(from,to),region.subarray(from,to));
      logical+=part.data.length;
    }
    // Keep the unfinished tail (as views of the original packets).
    const rest:{offset:number;data:Uint8Array}[]=[];logical=0;
    for(const part of this.parts){
      const end=logical+part.data.length;
      if(end>cut){const skip=Math.max(0,cut-logical);rest.push({offset:part.offset+skip,data:part.data.subarray(skip)});}
      logical=end;
    }
    this.parts=rest;this.total=buffer.length-cut;
  }
}
