/** Exact, bounded arithmetic. Prices are quote atoms per base atom; quantities are atoms. */
export function need(ok, code) { if (!ok) throw Error(code); }
export function uint(s, maxDigits = 72) {
  need(typeof s === 'string' && /^(0|[1-9][0-9]*)$/.test(s) && s.length <= maxDigits, 'SPOT_INTEGER');
  return BigInt(s);
}
export function small(v, max = 36) {
  need((typeof v === 'number' && Number.isSafeInteger(v)) || (typeof v === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(v)), 'SPOT_SMALL_INTEGER');
  const n = Number(v); need(n >= 0 && n <= max, 'SPOT_RANGE'); return n;
}
function gcd(a,b) { while (b) [a,b]=[b,a%b]; return a; }
export function rational(n,d=1n) { need(n>=0n&&d>0n,'SPOT_RATIONAL'); const g=gcd(n,d); return {n:n/g,d:d/g}; }
export function decimal(s) {
  need(typeof s==='string'&&s.length<=160,'SPOT_DECIMAL');
  const m=/^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]{1,2}))?$/.exec(s);
  need(m,'SPOT_DECIMAL'); const places=(m[2]??'').length-Number(m[3]??0);
  need(Math.abs(places)<=72 && (m[1]+(m[2]??'')).length<=72,'SPOT_DECIMAL_RANGE');
  const n=BigInt(m[1]+(m[2]??'')); return places>=0?rational(n,10n**BigInt(places)):rational(n*10n**BigInt(-places));
}
export const mul=(a,b)=>rational(a.n*b.n,a.d*b.d);
export const cmp=(a,b)=>a.n*b.d>b.n*a.d?1:a.n*b.d<b.n*a.d?-1:0;
export function shift(a,places) { need(Number.isInteger(places)&&Math.abs(places)<=72,'SPOT_SCALE'); return places>=0?rational(a.n*10n**BigInt(places),a.d):rational(a.n,a.d*10n**BigInt(-places)); }
export const ceil=a=>(a.n+a.d-1n)/a.d;
export const floor=a=>a.n/a.d;
export const pack=a=>({numerator:a.n.toString(),denominator:a.d.toString()});
export const unpack=a=>{need(a&&typeof a==='object','SPOT_RATIONAL');return rational(uint(a.numerator,160),uint(a.denominator,160));};
export function exactInt(a) { need(a.n%a.d===0n,'SPOT_FRACTIONAL_ATOM'); return a.n/a.d; }
export function multiple(a,step) { need(step.n>0n,'SPOT_TICK'); return (a.n*step.d)%(a.d*step.n)===0n; }
export function units(s,decimals) { return exactInt(shift(decimal(s),small(decimals))); }
export function format(n,d) { n=typeof n==='bigint'?n:uint(n); d=small(d); const s=n.toString().padStart(d+1,'0');return d?`${s.slice(0,-d)}.${s.slice(-d)}`:s; }
export function label(s,max=160) { need(typeof s==='string'&&s.length>0&&s.length<=max&&!/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(s),'SPOT_IDENTIFIER');return s; }
export function same(a,b) { return JSON.stringify(a)===JSON.stringify(b); }
export function timestamp(v) { return small(v,Number.MAX_SAFE_INTEGER); }
