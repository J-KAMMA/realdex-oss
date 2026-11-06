/** Strict input boundaries. Errors contain codes only, never input values. */
export const need = (ok, code) => { if (!ok) throw new Error(code); };
export function shape(value, required, optional = []) {
  need(value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'OBJECT_REQUIRED');
  need(required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => [...required, ...optional].includes(k)), 'SCHEMA_INVALID');
  return value;
}
export function text(value, max = 80) {
  need(typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value), 'TEXT_INVALID');
  return value;
}
export function uint(value, max = (1n << 256n) - 1n) {
  need(typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value), 'INTEGER_STRING_REQUIRED');
  const n = BigInt(value); need(n <= max, 'INTEGER_RANGE'); return n;
}
export function hex(value, bytes, prefix = true) {
  need(typeof value === 'string' && (prefix ? /^0x(?:[0-9a-fA-F]{2})*$/ : /^(?:[0-9a-fA-F]{2})*$/).test(value), 'HEX_INVALID');
  const s = prefix ? value.slice(2) : value; need(s.length <= 131072 && (bytes === undefined || s.length === bytes * 2), 'HEX_LENGTH_INVALID');
  return Buffer.from(s, 'hex');
}
export const hex0 = b => '0x' + Buffer.from(b).toString('hex');
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { need(Number.isSafeInteger(value), 'INTEGER_REQUIRED'); return String(value); }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  need(value && typeof value === 'object', 'CANONICAL_VALUE_INVALID');
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
export const clone = value => JSON.parse(JSON.stringify(value));
export function safeError(e) { return e instanceof Error && /^[A-Z][A-Z0-9_]{1,90}$/.test(e.message) ? e.message : 'OPERATION_FAILED'; }
export const freeze = x => { if (x && typeof x === 'object') { for (const v of Object.values(x)) freeze(v); Object.freeze(x); } return x; };
export function q(value) { need(typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value), 'RPC_QUANTITY_INVALID'); return BigInt(value); }
export const quantity = n => '0x' + n.toString(16);
