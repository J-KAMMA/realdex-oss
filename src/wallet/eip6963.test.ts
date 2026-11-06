import { describe, expect, it } from "vitest";
import { evmWalletRegistryReducer, initialEvmWalletRegistry, validateEip6963Provider, type Eip6963ProviderDetail, type SelectableEip1193Provider } from "./eip6963";

const providerA = { request: async () => [] } as SelectableEip1193Provider;
const providerB = { request: async () => [] } as SelectableEip1193Provider;
const uuidA = "11111111-1111-4111-8111-111111111111";
const uuidB = "22222222-2222-4222-8222-222222222222";
const detail = (uuid: string, name: string, provider: SelectableEip1193Provider): Eip6963ProviderDetail => ({ info: { uuid, name, icon: "data:image/png;base64,AA==", rdns: `${name.toLowerCase()}.wallet.example` }, provider });

describe("EIP-6963 wallet registry", () => {
  it("auto-selects one provider but requires an explicit choice when a second appears", () => {
    let state = evmWalletRegistryReducer(initialEvmWalletRegistry(), { type: "providerAnnounced", detail: detail(uuidA, "Alpha", providerA) });
    expect(state.selectedId).toBe(uuidA);
    state = evmWalletRegistryReducer(state, { type: "providerAnnounced", detail: detail(uuidB, "Beta", providerB) });
    expect(state.selectedId).toBeNull();
    state = evmWalletRegistryReducer(state, { type: "providerSelected", id: uuidB });
    expect(state.selectedId).toBe(uuidB);
    expect(state.selection).toBe("explicit");
  });

  it("restores only an announced preferred provider and invalidates selection when it disappears", () => {
    let state = initialEvmWalletRegistry(uuidB);
    state = evmWalletRegistryReducer(state, { type: "providerAnnounced", detail: detail(uuidA, "Alpha", providerA) });
    expect(state.selectedId).toBe(uuidA);
    state = evmWalletRegistryReducer(state, { type: "providerAnnounced", detail: detail(uuidB, "Beta", providerB) });
    expect(state.selectedId).toBe(uuidB);
    state = evmWalletRegistryReducer(state, { type: "providerUnavailable", id: uuidB });
    expect(state.selectedId).toBe(uuidA);
    expect(state.revision).toBeGreaterThan(1);
  });

  it("quarantines UUID collisions instead of accepting a replacement provider", () => {
    let state = evmWalletRegistryReducer(initialEvmWalletRegistry(), { type: "providerAnnounced", detail: detail(uuidA, "Alpha", providerA) });
    state = evmWalletRegistryReducer(state, { type: "providerAnnounced", detail: detail(uuidA, "Impostor", providerB) });
    expect(state.providers).toEqual([]);
    expect(state.selectedId).toBeNull();
    expect(state.blockedIds).toEqual([uuidA]);
  });

  it("rejects malformed UUID, reverse-DNS, icon, and provider announcements", () => {
    expect(validateEip6963Provider({ ...detail(uuidA, "Alpha", providerA), info: { ...detail(uuidA, "Alpha", providerA).info, icon: "data:image/svg+xml,<svg/>" } }).info.icon).toContain("svg+xml");
    expect(() => validateEip6963Provider(detail("bad", "Alpha", providerA))).toThrow("EIP6963_UUID_INVALID");
    expect(() => validateEip6963Provider({ ...detail(uuidA, "Alpha", providerA), info: { ...detail(uuidA, "Alpha", providerA).info, rdns: "bad" } })).toThrow("EIP6963_RDNS_INVALID");
    expect(() => validateEip6963Provider({ ...detail(uuidA, "Alpha", providerA), info: { ...detail(uuidA, "Alpha", providerA).info, icon: "https://example.com/icon.png" } })).toThrow("EIP6963_ICON_INVALID");
  });
});
