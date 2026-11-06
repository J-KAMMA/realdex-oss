export type CanonicalProtoField = {
  number: number;
  wireType: number;
  bytes?: Uint8Array;
  integer?: bigint;
};

export function canonicalProtoFields(
  bytes: Uint8Array,
  spec: Record<number, [wireType: number, count: number]>,
  error: string
): Map<number, CanonicalProtoField[]> {
  const fields = scanCanonicalProtoFields(bytes, error);
  const grouped = new Map<number, CanonicalProtoField[]>();
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(spec, field.number) || field.wireType !== spec[field.number][0]) throw new Error(error);
    const list = grouped.get(field.number) ?? [];
    list.push(field);
    grouped.set(field.number, list);
  }
  for (const [number, [, count]] of Object.entries(spec)) {
    const actual = grouped.get(Number(number))?.length ?? 0;
    if (count === -1 ? actual > 1 : actual !== count) throw new Error(error);
  }
  return grouped;
}

export function scanCanonicalProtoFields(bytes: Uint8Array, error: string): CanonicalProtoField[] {
  const fields: CanonicalProtoField[] = [];
  let offset = 0;
  let previousNumber = 0;
  while (offset < bytes.length) {
    const tag = readCanonicalVarint(bytes, offset, error);
    offset = tag.next;
    const number = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (!Number.isSafeInteger(number) || number <= 0 || number > 536_870_911 || number < previousNumber || (wireType !== 0 && wireType !== 2)) throw new Error(error);
    previousNumber = number;
    if (wireType === 0) {
      const value = readCanonicalVarint(bytes, offset, error);
      offset = value.next;
      fields.push({ number, wireType, integer: value.value });
      continue;
    }
    const length = readCanonicalVarint(bytes, offset, error);
    offset = length.next;
    if (length.value > BigInt(bytes.length - offset)) throw new Error(error);
    const end = offset + Number(length.value);
    fields.push({ number, wireType, bytes: bytes.slice(offset, end) });
    offset = end;
  }
  return fields;
}

export function canonicalProtoUtf8(value: Uint8Array, error = "PROTO_STRING_INVALID"): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error(error);
  }
}

function readCanonicalVarint(bytes: Uint8Array, start: number, error: string): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  let count = 0;
  let last = 0;
  while (offset < bytes.length && count < 10) {
    const byte = bytes[offset++];
    last = byte & 0x7f;
    value |= BigInt(last) << shift;
    count++;
    if ((byte & 0x80) === 0) {
      if ((count > 1 && last === 0) || (count === 10 && last > 1)) throw new Error(error);
      return { value, next: offset };
    }
    shift += 7n;
  }
  throw new Error(error);
}
