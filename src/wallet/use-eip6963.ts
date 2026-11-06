import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  evmWalletRegistryReducer,
  initialEvmWalletRegistry,
  selectedEvmWalletProvider,
  validateEip6963Provider,
  type Eip6963ProviderDetail,
  type SelectableEip1193Provider
} from "./eip6963";

import { LocalWalletProvider, localWalletDetail } from "../../wallet/public/provider.mjs";

const STORAGE_KEY = "localswap:eip6963-provider-id";

export function useEip6963Wallets() {
  const [state, dispatch] = useReducer(evmWalletRegistryReducer, undefined, () => initialEvmWalletRegistry(readPreferredId()));

  useEffect(() => {
    const announced = (event: Event) => {
      try { dispatch({ type: "providerAnnounced", detail: validateEip6963Provider((event as CustomEvent<Eip6963ProviderDetail>).detail) }); }
      catch { /* malformed announcements never enter the registry */ }
    };
    window.addEventListener("eip6963:announceProvider", announced);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    if (window.ethereum) dispatch({ type: "legacyProviderDetected", provider: window.ethereum as SelectableEip1193Provider });
    return () => window.removeEventListener("eip6963:announceProvider", announced);
  }, []);

  const selectProvider = useCallback((id: string) => {
    dispatch({ type: "providerSelected", id });
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* selection remains active for this page */ }
  }, []);

  // Opt-in only: announcing a provider never starts a signing request.
  const local = useRef<ReturnType<typeof localWalletDetail> | null>(null);
  const enableLocalProvider = useCallback((chainId: string) => {
    if (!local.current) local.current = localWalletDetail(new LocalWalletProvider({ chainId }));
    dispatch({ type: "providerAnnounced", detail: validateEip6963Provider(local.current) });
    dispatch({ type: "providerSelected", id: local.current.info.uuid });
  }, []);
  const disconnectLocalProvider = useCallback(async () => { await local.current?.provider.disconnect(); }, []);
  useEffect(() => () => { local.current?.provider.dispose(); local.current = null; }, []);

  const selected = useMemo(() => selectedEvmWalletProvider(state), [state]);
  return { ...state, selected, selectProvider, enableLocalProvider, disconnectLocalProvider };
}

function readPreferredId(): string | null {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}
