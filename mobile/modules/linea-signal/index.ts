/** The native state is opaque and contains private key material. Never log it,
 * send it to a server, or persist it outside the encrypted local database. */
export type SignalPreKey = {id:number;publicKey:string};
export type SignalSignedPreKey = SignalPreKey & {signature:string};
export type SignalPublicBundle = {
  registrationId:number;identityKey:string;signedPreKey:SignalSignedPreKey;
  kyberPreKey:SignalSignedPreKey;preKeys:SignalPreKey[];
};
export type SignalRemoteBundle = Omit<SignalPublicBundle,'preKeys'> & {preKey?:SignalPreKey};
export type SignalStateResult = {state:string};
export interface LineaSignalBridge {
  readonly libsignalVersion:string;
  createState(localAddressName:string,deviceId:number):Promise<SignalStateResult & {bundle:SignalPublicBundle}>;
  replenish(state:string,count:number):Promise<SignalStateResult & {bundle:SignalPublicBundle}>;
  trustIdentity(state:string,addressName:string,deviceId:number,identityKeyBase64:string):Promise<SignalStateResult>;
  encrypt(state:string,addressName:string,deviceId:number,plaintext:string,bundle?:SignalRemoteBundle):Promise<SignalStateResult & {type:2|3;body:string}>;
  decrypt(state:string,addressName:string,deviceId:number,type:2|3,body:string):Promise<SignalStateResult & {plaintext:string}>;
  seal(plaintextBase64:string,keyBase64:string,nonceBase64:string,adBase64:string):Promise<string>;
  open(cipherBase64:string,keyBase64:string,nonceBase64:string,adBase64:string):Promise<string>;
}
