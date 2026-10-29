export type ViewLease={uri:string;dispose:()=>Promise<void>};
export type ViewState={phase:'closed'|'loading'|'ready'|'error';uri?:string;error?:string};
type Loader=(signal:AbortSignal)=>Promise<ViewLease>;

/** Owns a decrypted local file. A stale request may never enter the player. */
export class ViewSession {
  private generation=0;
  private abort:AbortController|null=null;
  private lease:ViewLease|null=null;
  constructor(private readonly publish:(state:ViewState)=>void){}
  private release():void {
    this.abort?.abort();this.abort=null;
    const lease=this.lease;this.lease=null;
    if(lease)void lease.dispose().catch(()=>{});
  }
  async open(load:Loader):Promise<void> {
    const generation=++this.generation;this.release();
    const abort=new AbortController();this.abort=abort;this.publish({phase:'loading'});
    try {
      const lease=await load(abort.signal);
      if(generation!==this.generation){await lease.dispose().catch(()=>{});return;}
      this.lease=lease;this.publish({phase:'ready',uri:lease.uri});
    }catch(error){
      if(generation!==this.generation)return;
      this.publish({phase:'error',error:error instanceof Error?error.message:'Не удалось открыть вложение.'});
    }
  }
  close():void {this.generation++;this.release();this.publish({phase:'closed'});}
}
