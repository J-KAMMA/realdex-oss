export type BoundedJsonGetOptions = {
  errorPrefix: string;
  timeoutMs?: number;
  maximumBytes?: number;
  bodylessStatuses?: readonly number[];
};

export type BoundedJsonGetResult = { status: number; ok: boolean; body?: unknown };

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAXIMUM_BYTES = 1_000_000;

export async function boundedJsonGet(input: string, fetchImpl: typeof fetch = fetch, options: BoundedJsonGetOptions): Promise<BoundedJsonGetResult> {
  const { errorPrefix, timeoutMs = DEFAULT_TIMEOUT_MS, maximumBytes = DEFAULT_MAXIMUM_BYTES, bodylessStatuses = [] } = options;
  if (!/^[A-Z][A-Z0-9_]{2,80}$/.test(errorPrefix) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > DEFAULT_MAXIMUM_BYTES || bodylessStatuses.some((status) => !Number.isInteger(status) || status < 100 || status > 599)) throw new Error("BOUNDED_JSON_POLICY_INVALID");
  let url: URL;
  try { url = new URL(input); } catch { throw new Error(`${errorPrefix}_URL_INVALID`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(`${errorPrefix}_URL_INVALID`);
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetchImpl(url.toString(), {
      method: "GET", headers: { Accept: "application/json" }, credentials: "omit",
      referrerPolicy: "no-referrer", cache: "no-store", signal: controller.signal
    });
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599 || response.ok !== (response.status >= 200 && response.status < 300)) throw new Error(`${errorPrefix}_RESPONSE_INVALID`);
    if (bodylessStatuses.includes(response.status)) return { status: response.status, ok: response.ok };
    const text = await readBounded(response, maximumBytes, errorPrefix);
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new Error(`${errorPrefix}_RESPONSE_INVALID`); }
    return { status: response.status, ok: response.ok, body };
  } catch (reason) {
    if (timedOut || (reason instanceof DOMException && reason.name === "AbortError")) throw new Error(`${errorPrefix}_TIMEOUT`);
    if (reason instanceof Error && reason.message.startsWith(`${errorPrefix}_`)) throw reason;
    throw new Error(`${errorPrefix}_REQUEST_FAILED`);
  } finally { clearTimeout(timeout); }
}

async function readBounded(response: Response, maximumBytes: number, errorPrefix: string): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new Error(`${errorPrefix}_RESPONSE_TOO_LARGE`);
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximumBytes) throw new Error(`${errorPrefix}_RESPONSE_TOO_LARGE`);
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) { await reader.cancel(); throw new Error(`${errorPrefix}_RESPONSE_TOO_LARGE`); }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
