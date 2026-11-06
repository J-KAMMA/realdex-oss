export type RequestArguments={method:string;params?:readonly unknown[]};
export class LocalWalletProvider {
  constructor(options?:{baseUrl?:string;chainId?:string;fetchImpl?:typeof fetch;pollMs?:number;now?:()=>number});
  request(args:RequestArguments):Promise<unknown>;
  on(name:string,listener:(...args:unknown[])=>void):this;
  removeListener(name:string,listener:(...args:unknown[])=>void):this;
  disconnect():Promise<void>;dispose():void;
}
export function localWalletDetail(provider:LocalWalletProvider,uuid?:string):{info:{uuid:string;name:string;rdns:string;icon:string};provider:LocalWalletProvider};
