/** A bounded JSON parser which preserves every number as its original decimal
 * string. No RPC counter, balance, height or difficulty passes through Number.
 * It also rejects duplicate object members instead of silently accepting the last. */
import {check} from './guard.mjs';
export function parseExactJson(source,{maxChars=2097152,maxNodes=50000,maxDepth=48}={}){
 check(typeof source==='string'&&source.length<=maxChars,'JSON_SIZE_LIMIT');let i=0,nodes=0;
 const ws=()=>{while(i<source.length&&' \t\r\n'.includes(source[i]))i++;};
 function str(){check(source[i++]==='"','JSON_INVALID');const start=i-1;let escaped=false;
  while(i<source.length){const c=source[i++];if(!escaped&&c==='"'){let s;try{s=JSON.parse(source.slice(start,i));}catch{throw Error('JSON_INVALID');}
    // JSON permits lone surrogate escapes; reject them before using UTF-8 identifiers.
    check(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s),'JSON_INVALID');return s;}
   if(!escaped&&c==='\\')escaped=true;else escaped=false;}
  throw Error('JSON_INVALID');
 }
 function value(depth){check(depth<=maxDepth&&++nodes<=maxNodes,'JSON_RESOURCE_LIMIT');ws();const c=source[i];
  if(c==='"')return str();
  if(c==='{'){i++;const out={};ws();if(source[i]==='}'){i++;return out;}for(;;){ws();check(source[i]==='"','JSON_INVALID');const k=str();
    check(!Object.hasOwn(out,k)&&!['__proto__','prototype','constructor'].includes(k),'JSON_MEMBER_INVALID');ws();check(source[i++]===':','JSON_INVALID');out[k]=value(depth+1);ws();const sep=source[i++];if(sep==='}')return out;check(sep===',','JSON_INVALID');}}
  if(c==='['){i++;const out=[];ws();if(source[i]===']'){i++;return out;}for(;;){out.push(value(depth+1));ws();const sep=source[i++];if(sep===']')return out;check(sep===',','JSON_INVALID');}}
  for(const [word,result]of [['true',true],['false',false],['null',null]])if(source.startsWith(word,i)){i+=word.length;return result;}
  const match=/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(i));
  check(match&&match[0].length<=1024,'JSON_NUMBER_INVALID');i+=match[0].length;return match[0];
 }
 const result=value(0);ws();check(i===source.length,'JSON_TRAILING_DATA');return result;
}
