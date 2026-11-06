// Pure validation and wire encoding. No network, signing, or wallet capabilities.
export const LIMITS = Object.freeze({ publishers: 32, factories: 16, peers: 16, bytes: 262144,
  announcementTtlMs: 300000, snapshotTtlMs: 15000, clockSkewMs: 2000 });
const KEY = /^[0-9a-f]{64}$/;
export function need(condition, code) { if (!condition) throw new Error(code); }
export function exact(value, keys, code = 'SCHEMA_INVALID') {
  need(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key)), code);
}
export function publicKeyValid(key) { return typeof key === 'string' && KEY.test(key); }
export function integer(value, low, high, code) {
  need(Number.isSafeInteger(value) && value >= low && value <= high, code);
}
export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { need(Number.isSafeInteger(value), 'CANONICAL_NUMBER_INVALID'); return String(value); }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  need(value && Object.getPrototypeOf(value) === Object.prototype, 'CANONICAL_OBJECT_INVALID');
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
export function assertTime(payload, now, maximumTtl) {
  integer(now, 1, Number.MAX_SAFE_INTEGER, 'CLOCK_INVALID');
  integer(payload.issuedAt, 1, Number.MAX_SAFE_INTEGER, 'TIME_INVALID');
  integer(payload.expiresAt, 1, Number.MAX_SAFE_INTEGER, 'TIME_INVALID');
  need(payload.issuedAt <= now + LIMITS.clockSkewMs && payload.expiresAt > now &&
    payload.expiresAt > payload.issuedAt && payload.expiresAt - payload.issuedAt <= maximumTtl, 'MESSAGE_EXPIRED_OR_FUTURE');
}
export function assertFactories(factories) {
  need(Array.isArray(factories) && factories.length <= LIMITS.factories, 'FACTORIES_LIMIT');
  const seen = new Set(); let previous = '';
  for (const entry of factories) {
    exact(entry, ['chainId', 'address', 'protocol'], 'FACTORY_INVALID');
    need(typeof entry.chainId === 'string' && /^eip155:[1-9][0-9]{0,19}$/.test(entry.chainId) &&
      typeof entry.address === 'string' && /^0x[0-9a-f]{40}$/.test(entry.address) &&
      entry.address !== '0x' + '0'.repeat(40) && entry.protocol === 'realdex-cpmm-v1', 'FACTORY_INVALID');
    const id = entry.chainId + '/' + entry.address;
    need(!seen.has(id) && (!previous || previous < id), 'FACTORIES_DUPLICATE_OR_UNSORTED');
    seen.add(id); previous = id;
  }
}
