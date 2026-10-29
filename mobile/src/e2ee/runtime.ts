import * as Crypto from 'expo-crypto';
import type { Api } from '../api';
import { CryptoService } from './core';
import { getSignalBridge } from './signal';
import { openVault } from './vault';

export class CryptoRuntime {
  private promise: Promise<CryptoService> | null = null;
  private disposed = false;
  constructor(private api: Api, private userId: string) {}
  get():Promise<CryptoService> {
    if(this.disposed)return Promise.reject(new Error('Сессия шифрования завершена.'));
    if(!this.promise)this.promise=(async()=>{
      const bridge=getSignalBridge();const vault=await openVault(this.api.base,this.userId);
      const service=new CryptoService(this.userId,this.api,bridge,vault,()=>Crypto.randomUUID(),value=>Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256,value));
      if(this.disposed){await service.close();throw new Error('Сессия шифрования завершена.');}
      return service;
    })().catch(error=>{this.promise=null;throw error;});
    return this.promise;
  }
  async close() {this.disposed=true;if(this.promise)await this.promise.then(service=>service.close()).catch(()=>{});}
}
