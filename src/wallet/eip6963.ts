import type { Eip1193Provider } from "ethers";

export type SelectableEip1193Provider = Eip1193Provider & {
  on?(event: "accountsChanged" | "chainChanged" | "disconnect", listener: (...args: unknown[]) => void): void;
  removeListener?(event: "accountsChanged" | "chainChanged" | "disconnect", listener: (...args: unknown[]) => void): void;
};

export type Eip6963ProviderInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};

export type Eip6963ProviderDetail = {
  info: Eip6963ProviderInfo;
  provider: SelectableEip1193Provider;
};

export type EvmWalletProviderEntry = Eip6963ProviderDetail & { source: "eip6963" | "legacy" };

export type EvmWalletRegistryState = {
  providers: EvmWalletProviderEntry[];
  selectedId: string | null;
  preferredId: string | null;
  selection: "automatic" | "preferred" | "explicit" | null;
  revision: number;
  blockedIds: string[];
};

export type EvmWalletRegistryEvent =
  | { type: "providerAnnounced"; detail: Eip6963ProviderDetail }
  | { type: "legacyProviderDetected"; provider: SelectableEip1193Provider }
  | { type: "providerUnavailable"; id: string }
  | { type: "providerSelected"; id: string };

const LEGACY_PROVIDER_ID = "legacy-window-ethereum";

export function initialEvmWalletRegistry(preferredId: string | null = null): EvmWalletRegistryState {
  return { providers: [], selectedId: null, preferredId: preferredId?.trim() || null, selection: null, revision: 0, blockedIds: [] };
}

export function evmWalletRegistryReducer(state: EvmWalletRegistryState, event: EvmWalletRegistryEvent): EvmWalletRegistryState {
  switch (event.type) {
    case "providerAnnounced": {
      const detail = validateEip6963Provider(event.detail);
      if (state.blockedIds.includes(detail.info.uuid)) return state;
      const sameId = state.providers.find((entry) => entry.info.uuid === detail.info.uuid);
      if (sameId) {
        if (sameId.provider === detail.provider && sameInfo(sameId.info, detail.info)) return state;
        return quarantineId(state, detail.info.uuid);
      }
      const sameProvider = state.providers.find((entry) => entry.provider === detail.provider);
      let providers = state.providers;
      let selectedId = state.selectedId;
      let selection = state.selection;
      if (sameProvider) {
        if (sameProvider.source !== "legacy") return state;
        providers = providers.filter((entry) => entry !== sameProvider);
        if (selectedId === sameProvider.info.uuid) { selectedId = detail.info.uuid; selection = "automatic"; }
      }
      providers = sortProviders([...providers, { ...detail, source: "eip6963" }]);
      return resolveSelection({ ...state, providers, selectedId, selection });
    }
    case "legacyProviderDetected": {
      if (!event.provider || typeof event.provider.request !== "function") return state;
      if (state.providers.some((entry) => entry.provider === event.provider)) return state;
      const providers = sortProviders([...state.providers, {
        source: "legacy" as const,
        provider: event.provider,
        info: { uuid: LEGACY_PROVIDER_ID, name: "Browser wallet", icon: "", rdns: "legacy.injected" }
      }]);
      return resolveSelection({ ...state, providers });
    }
    case "providerUnavailable": {
      const providers = state.providers.filter((entry) => entry.info.uuid !== event.id);
      if (providers.length === state.providers.length) return state;
      const selectedRemoved = state.selectedId === event.id;
      return resolveSelection({ ...state, providers, selectedId: selectedRemoved ? null : state.selectedId, selection: selectedRemoved ? null : state.selection });
    }
    case "providerSelected": {
      if (!state.providers.some((entry) => entry.info.uuid === event.id) || state.blockedIds.includes(event.id)) throw new Error("EIP6963_PROVIDER_UNAVAILABLE");
      if (state.selectedId === event.id && state.selection === "explicit") return state;
      return { ...state, selectedId: event.id, selection: "explicit", preferredId: event.id, revision: state.revision + 1 };
    }
  }
}

export function validateEip6963Provider(detail: Eip6963ProviderDetail): Eip6963ProviderDetail {
  if (!detail || !detail.provider || typeof detail.provider.request !== "function") throw new Error("EIP6963_PROVIDER_INVALID");
  const info = detail.info;
  if (!info || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(info.uuid)) throw new Error("EIP6963_UUID_INVALID");
  if (!info.name.trim() || info.name.trim().length > 80) throw new Error("EIP6963_NAME_INVALID");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(info.rdns) || info.rdns.length > 255) throw new Error("EIP6963_RDNS_INVALID");
  if (info.icon && (!/^data:image\/(?:png|jpeg|webp|svg\+xml)(?:;base64)?,/i.test(info.icon) || info.icon.length > 100_000)) throw new Error("EIP6963_ICON_INVALID");
  return { provider: detail.provider, info: { uuid: info.uuid.toLowerCase(), name: info.name.trim(), icon: info.icon, rdns: info.rdns.toLowerCase() } };
}

export function selectedEvmWalletProvider(state: EvmWalletRegistryState): EvmWalletProviderEntry | undefined {
  return state.providers.find((entry) => entry.info.uuid === state.selectedId);
}

function resolveSelection(state: EvmWalletRegistryState): EvmWalletRegistryState {
  let selectedId = state.selectedId;
  let selection = state.selection;
  if (selectedId && !state.providers.some((entry) => entry.info.uuid === selectedId)) { selectedId = null; selection = null; }
  if (selection === "automatic" && state.providers.length > 1) { selectedId = null; selection = null; }
  if (!selectedId && state.preferredId && state.providers.some((entry) => entry.info.uuid === state.preferredId)) { selectedId = state.preferredId; selection = "preferred"; }
  if (!selectedId && state.providers.length === 1) { selectedId = state.providers[0].info.uuid; selection = "automatic"; }
  const changed = selectedId !== state.selectedId;
  return { ...state, selectedId, selection, revision: state.revision + (changed ? 1 : 0) };
}

function quarantineId(state: EvmWalletRegistryState, id: string): EvmWalletRegistryState {
  const providers = state.providers.filter((entry) => entry.info.uuid !== id);
  const selectedRemoved = state.selectedId === id;
  return resolveSelection({
    ...state,
    providers,
    selectedId: selectedRemoved ? null : state.selectedId,
    selection: selectedRemoved ? null : state.selection,
    blockedIds: [...state.blockedIds, id].sort()
  });
}

function sameInfo(left: Eip6963ProviderInfo, right: Eip6963ProviderInfo): boolean {
  return left.uuid.toLowerCase() === right.uuid.toLowerCase() && left.name === right.name.trim() && left.icon === right.icon && left.rdns.toLowerCase() === right.rdns.toLowerCase();
}

function sortProviders(entries: EvmWalletProviderEntry[]): EvmWalletProviderEntry[] {
  return entries.slice().sort((left, right) => left.info.name.localeCompare(right.info.name) || left.info.uuid.localeCompare(right.info.uuid));
}
