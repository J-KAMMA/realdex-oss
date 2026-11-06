import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { COSMOS_INJECTED_CHAINS } from "./cosmos-injected-chains";
import {
  connectCosmosInjectedWallet,
  type CosmosInjectedAccountBinding,
  type CosmosInjectedConnection,
  type CosmosInjectedProvider
} from "./cosmos-injected-session";

export type CosmosInjectedProviderRegistration = Readonly<{
  id: string;
  name: string;
  provider: CosmosInjectedProvider;
}>;

const INVALIDATED = "Local connection expired or changed. Choose the wallet and network again, then request account access.";

function defaultProviders(): readonly CosmosInjectedProviderRegistration[] {
  if (typeof window === "undefined") return [];
  const descriptor = Object.getOwnPropertyDescriptor(window, "keplr");
  const candidate = descriptor && "value" in descriptor ? descriptor.value : undefined;
  if (!candidate || typeof candidate !== "object") return [];
  const provider = candidate as Partial<CosmosInjectedProvider>;
  if (typeof provider.enable !== "function" || typeof provider.getKey !== "function") return [];
  return [Object.freeze({ id: "injected:keplr", name: "Keplr injected provider", provider: provider as CosmosInjectedProvider })];
}

export default function CosmosInjectedConnectionPanel({
  providers,
  eventTarget,
  renderSelectedAccount
}: {
  providers?: readonly CosmosInjectedProviderRegistration[];
  eventTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  renderSelectedAccount?: (selection: { connection: CosmosInjectedConnection; binding: CosmosInjectedAccountBinding; provider: CosmosInjectedProvider }) => ReactNode;
}) {
  const available = providers ?? defaultProviders();
  const [walletId, setWalletId] = useState("");
  const [chainId, setChainId] = useState("");
  const [pending, setPending] = useState(false);
  const [connectionView, setConnectionView] = useState<CosmosInjectedConnection | null>(null);
  const [binding, setBinding] = useState<CosmosInjectedAccountBinding | null>(null);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const connection = useRef<CosmosInjectedConnection | null>(null);
  const verifying = useRef<number | null>(null);

  const release = useCallback(() => {
    generation.current += 1;
    request.current?.abort();
    request.current = null;
    connection.current?.dispose();
    connection.current = null;
    verifying.current = null;
  }, []);
  const reset = useCallback((notice = "") => {
    release();
    setPending(false);
    setConnectionView(null);
    setBinding(null);
    setMessage(notice);
  }, [release]);
  useEffect(() => release, [release]);

  const wallet = available.find(item => item.id === walletId);
  const chain = COSMOS_INJECTED_CHAINS[chainId];
  const canConnect = !!wallet && !!chain;

  const verify = useCallback(async () => {
    const current = connection.current;
    if (!current || !binding || verifying.current !== null) return;
    const ticket = generation.current;
    verifying.current = ticket;
    try {
      await current.assertCurrent(binding);
    } catch {
      if (generation.current === ticket) reset(INVALIDATED);
    } finally {
      if (verifying.current === ticket) verifying.current = null;
    }
  }, [binding, reset]);
  useEffect(() => {
    if (!binding) return;
    const interval = window.setInterval(() => void verify(), 1_000);
    const expiry = window.setTimeout(() => void verify(), Math.max(0, binding.expiresAt - Date.now()));
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(expiry);
    };
  }, [binding, verify]);

  async function connect() {
    if (!wallet || !chain || request.current || connection.current) return;
    reset();
    const ticket = generation.current;
    const abort = new AbortController();
    request.current = abort;
    setPending(true);
    setMessage("Waiting for account access in the selected wallet. No signing or transaction requested.");
    try {
      const result = await connectCosmosInjectedWallet(wallet.provider, chain.profile, {
        walletId: wallet.id,
        eventTarget: eventTarget ?? window,
        signal: abort.signal
      });
      if (generation.current !== ticket) {
        result.dispose();
        return;
      }
      connection.current = result;
      setConnectionView(result);
      setMessage("Account access received. Review the account, then keep the selection explicitly; execution disabled.");
    } catch (error) {
      if (generation.current !== ticket) return;
      setMessage(safeConnectionMessage(error));
    } finally {
      if (generation.current === ticket) {
        request.current = null;
        setPending(false);
      }
    }
  }

  async function keepSelection() {
    const current = connection.current;
    if (!current || binding) return;
    const ticket = generation.current;
    try {
      const selected = current.selectAccount();
      await current.assertCurrent(selected);
      if (generation.current !== ticket) return;
      setBinding(selected);
      setMessage("Account selection kept on this page only; execution disabled.");
    } catch {
      if (generation.current === ticket) reset(INVALIDATED);
    }
  }

  return <section className="wallet-standard-discovery cosmos-injected-discovery">
    <h3>Cosmos injected wallet</h3>
    <p>Account connection for the listed testnets. Connecting does not sign, transfer, broadcast or execute a route. Verify the selected network in the wallet prompt.</p>
    <details className="wallet-connection-panel cosmos-injected-connection">
      <summary>Optional Cosmos account connection</summary>
      <div className="standard-connection-fields">
        <label>Cosmos wallet provider
          <select aria-label="Cosmos wallet provider" value={walletId} onChange={event => { reset(); setWalletId(event.target.value); }}>
            <option value="">Choose a wallet provider</option>
            {available.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>Cosmos connection network
          <select aria-label="Cosmos connection network" value={chainId} onChange={event => { reset(); setChainId(event.target.value); }}>
            <option value="">Choose a testnet</option>
            {Object.entries(COSMOS_INJECTED_CHAINS).map(([id, item]) => <option key={id} value={id}>{item.label} · {item.profile.walletChainId}</option>)}
          </select>
        </label>
      </div>
      {!available.length && <p>No supported injected Cosmos provider detected. Nothing was called or requested.</p>}
      {wallet && <p>Selected provider: {wallet.name}. Provider identity is local detection, not a safety endorsement.</p>}
      {chain && <p>Requested network: {chain.label} · {chain.profile.walletChainId}. This does not switch or live-verify the wallet network.</p>}
      <button type="button" disabled={!canConnect || pending || !!connectionView} onClick={() => void connect()}>Request account access</button>
      {pending && <button type="button" onClick={() => reset("Stopped waiting locally. The wallet prompt may still be open; this does not cancel or revoke wallet permission.")}>Stop waiting</button>}
      <p role="status" aria-live="polite">{message}</p>
      {connectionView && <div className="standard-account-selection cosmos-account-review">
        <p>Account to select: {connectionView.account.bech32Address}</p>
        <p>Network: {connectionView.chain.chainId} · Key: secp256k1 · Hardware: {connectionView.account.hardware}</p>
        <p>Access was read twice and matched the configured address prefix. This is not proof that the wallet is safe.</p>
      </div>}
      <button type="button" disabled={!connectionView || !!binding} onClick={() => void keepSelection()}>Keep this account selection</button>
      {connectionView && <button type="button" onClick={() => reset("Local connection forgotten. Wallet permissions were not revoked; manage them in your wallet.")}>Forget local connection</button>}
      {binding && <div className="standard-account-selection">
        <p>Selected account: {binding.address}</p>
        <p>Network: {binding.chainId}</p>
        <p>Local selection expires: {new Date(binding.expiresAt).toISOString()}</p>
        <p>{renderSelectedAccount ? "Connection itself grants no signing or submission permission. Review a transaction separately below." : "Signing, submission and execution disabled. No route has been enabled."}</p>
      </div>}
      <p>The kept selection expires after five minutes, on wallet changes, or when leaving this view. Forgetting locally does not revoke wallet permissions.</p>
    </details>
    {binding && connectionView && wallet && renderSelectedAccount?.({ connection: connectionView, binding, provider: wallet.provider })}
  </section>;
}

function safeConnectionMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "COSMOS_INJECTED_CONNECTION_PENDING") return "An earlier wallet request is still pending. Finish or dismiss it in the wallet before retrying.";
  if (code === "COSMOS_INJECTED_CONNECTION_TIMEOUT") return "Account access timed out locally. The wallet prompt may still be open; finish or dismiss it before retrying.";
  if (code === "COSMOS_INJECTED_CONNECTION_CANCELLED") return "Stopped waiting locally. The wallet prompt may still be open; this does not cancel or revoke wallet permission.";
  if (code === "COSMOS_INJECTED_KEY_MISMATCH" || code === "COSMOS_INJECTED_KEY_INVALID") return "The wallet account did not match the selected network and key requirements. Nothing was kept.";
  return "Account access was not established. Check wallet support and your response in the wallet, then retry explicitly.";
}
