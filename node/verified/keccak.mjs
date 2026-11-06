/** Keccak-256 (Ethereum, NOT SHA3-256). Portable reference-style implementation.
 * Used only for read-only bytecode identities and ABI selectors; never key signing.
 * Fixed 1600-bit state; bounded input; vectors are cross-checked against Go golang.org/x/crypto/sha3.
 * A reviewed native/library implementation may be substituted without wire changes.
 */
const MASK = (1n << 64n) - 1n;
const ROT = [0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14];
const RC = [0x1n,0x8082n,0x800000000000808an,0x8000000080008000n,0x808bn,0x80000001n,
  0x8000000080008081n,0x8000000000008009n,0x8an,0x88n,0x80008009n,0x8000000an,
  0x8000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,
  0x8000000000008002n,0x8000000000000080n,0x800an,0x800000008000000an,
  0x8000000080008081n,0x8000000000008080n,0x80000001n,0x8000000080008008n];
const rol = (x, n) => n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64-n))) & MASK;
export function fromHex(value) {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) || value.length > 262146) throw new Error('HEX_INVALID');
  return Uint8Array.from(value.slice(2).match(/../g) ?? [], b => parseInt(b, 16));
}
export function toHex(bytes) { return '0x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
export function keccak256(input) {
  const bytes = typeof input === 'string' ? fromHex(input) : input;
  if (!(bytes instanceof Uint8Array) || bytes.length > 131072) throw new Error('HASH_INPUT_INVALID');
  const state = Array(25).fill(0n), padded = new Uint8Array(Math.ceil((bytes.length + 1) / 136) * 136);
  padded.set(bytes); padded[bytes.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
  for (let offset = 0; offset < padded.length; offset += 136) {
    for (let i = 0; i < 136; i++) state[i >> 3] ^= BigInt(padded[offset+i]) << BigInt((i%8)*8);
    for (const rc of RC) {
      const c = Array(5), d = Array(5), b = Array(25);
      for (let x = 0; x < 5; x++) c[x] = state[x]^state[x+5]^state[x+10]^state[x+15]^state[x+20];
      for (let x = 0; x < 5; x++) d[x] = c[(x+4)%5] ^ rol(c[(x+1)%5],1);
      for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
        const i = x+5*y; state[i] ^= d[x]; b[y+5*((2*x+3*y)%5)] = rol(state[i],ROT[i]);
      }
      for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) state[x+5*y] = b[x+5*y] ^ ((~b[(x+1)%5+5*y]) & b[(x+2)%5+5*y]);
      state[0] ^= rc;
    }
  }
  return toHex(Uint8Array.from({length:32}, (_,i) => Number((state[i>>3] >> BigInt((i%8)*8)) & 255n)));
}
export const selector = signature => keccak256(new TextEncoder().encode(signature)).slice(0,10);
export function address(value, allowZero = false) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || (!allowZero && /^0x0{40}$/.test(value))) throw new Error('ADDRESS_INVALID');
  const bare = value.slice(2), low = bare.toLowerCase();
  if (bare !== low && bare !== bare.toUpperCase()) {
    const h = keccak256(new TextEncoder().encode(low)).slice(2);
    const checksum = Array.from(low, (c,i) => parseInt(h[i],16) >= 8 ? c.toUpperCase() : c).join('');
    if (bare !== checksum) throw new Error('ADDRESS_CHECKSUM_INVALID');
  }
  return '0x'+low;
}
