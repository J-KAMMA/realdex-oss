import { describe, expect, it, vi } from "vitest";
import { boundedJsonGet } from "./bounded-json-get";

describe("bounded JSON GET", () => {
  it("omits credentials and referrer while parsing a bounded JSON response", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(boundedJsonGet("https://reader.example.org/status?id=7", request as typeof fetch, { errorPrefix: "TEST_READER" })).resolves.toEqual({ status: 200, ok: true, body: { ok: true } });
    expect(request).toHaveBeenCalledWith("https://reader.example.org/status?id=7", expect.objectContaining({ method: "GET", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" }));
  });

  it("allows an explicitly bodyless status without parsing untrusted content", async () => {
    const request = vi.fn(async () => new Response("not-json", { status: 404 }));
    await expect(boundedJsonGet("https://reader.example.org/missing", request as typeof fetch, { errorPrefix: "TEST_READER", bodylessStatuses: [404] })).resolves.toEqual({ status: 404, ok: false });
  });

  it("rejects declared and streamed responses beyond the byte limit", async () => {
    const declared = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-length": "100" } }));
    await expect(boundedJsonGet("https://reader.example.org/large", declared as typeof fetch, { errorPrefix: "TEST_READER", maximumBytes: 8 })).rejects.toThrow("TEST_READER_RESPONSE_TOO_LARGE");
    const streamed = vi.fn(async () => new Response(JSON.stringify({ value: "too-large" }), { status: 200 }));
    await expect(boundedJsonGet("https://reader.example.org/large", streamed as typeof fetch, { errorPrefix: "TEST_READER", maximumBytes: 8 })).rejects.toThrow("TEST_READER_RESPONSE_TOO_LARGE");
  });

  it("rejects malformed JSON and non-HTTPS endpoints", async () => {
    const request = vi.fn(async () => new Response("not-json", { status: 200 }));
    await expect(boundedJsonGet("https://reader.example.org/status", request as typeof fetch, { errorPrefix: "TEST_READER" })).rejects.toThrow("TEST_READER_RESPONSE_INVALID");
    await expect(boundedJsonGet("http://reader.example.org/status", request as typeof fetch, { errorPrefix: "TEST_READER" })).rejects.toThrow("TEST_READER_URL_INVALID");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled request at the configured deadline", async () => {
    const request = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    await expect(boundedJsonGet("https://reader.example.org/stalled", request as typeof fetch, { errorPrefix: "TEST_READER", timeoutMs: 5 })).rejects.toThrow("TEST_READER_TIMEOUT");
  });
});
