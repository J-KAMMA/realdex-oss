import { describe, expect, it, vi } from "vitest";
import { isExplicitWalletRejection } from "./errors";

describe("explicit wallet rejection", () => {
  it.each([4001, "ACTION_REJECTED"])("accepts structured code %s", code => {
    expect(isExplicitWalletRejection(Object.assign(new Error("localized message"), { code }))).toBe(true);
  });
  it("does not infer rejection from text, unrelated codes or nested causes", () => {
    for (const value of [new Error("ACTION_REJECTED"), new Error("access denied after broadcast 4001"), { code: "4001" }, { code: 4100 }, { code: 4900 }, { cause: { code: 4001 } }, "User rejected", null]) expect(isExplicitWalletRejection(value)).toBe(false);
  });
  it("does not execute a code getter", () => {
    const getter = vi.fn(() => 4001);
    expect(isExplicitWalletRejection(Object.defineProperty({}, "code", { get: getter }))).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });
});
