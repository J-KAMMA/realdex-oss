export type ExecutionIntentRandomSource = { getRandomValues(target: Uint8Array): Uint8Array };

const intentPattern = /^realdex-intent:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function createRouteExecutionIntentId(randomSource: ExecutionIntentRandomSource = crypto): string {
  const bytes = randomSource.getRandomValues(new Uint8Array(16));
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) throw new Error("EXECUTION_INTENT_RANDOMNESS_UNAVAILABLE");
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  const id = `realdex-intent:v1:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  assertRouteExecutionIntentId(id);
  return id;
}

export function assertRouteExecutionIntentId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !intentPattern.test(value)) throw new Error("EXECUTION_INTENT_ID_INVALID");
}
