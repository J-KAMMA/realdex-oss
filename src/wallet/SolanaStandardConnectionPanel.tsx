import { useCallback, useEffect, useRef, useState } from "react";
import type { SolanaStandardAccountBinding, SolanaStandardConnection } from "./solana-standard-session";
import { SOLANA_STANDARD_CLUSTERS } from "./solana-standard-clusters";
import type { WalletStandardDiscoveryController, WalletStandardDiscoverySnapshot } from "./wallet-standard-discovery";

type Snapshot = ReturnType<SolanaStandardConnection["snapshot"]>;
const INVALIDATED = "Local connection expired or changed. Choose again and request account access to reconnect.";

export default function SolanaStandardConnectionPanel({ controller, discovery }: {
  controller: WalletStandardDiscoveryController; discovery: WalletStandardDiscoverySnapshot;
}) {
  const [walletId, setWalletId] = useState("");
  const [chainId, setChainId] = useState("");
  const [account, setAccount] = useState("");
  const [version, setVersion] = useState("");
  const [pending, setPending] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [binding, setBinding] = useState<SolanaStandardAccountBinding | null>(null);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const connection = useRef<SolanaStandardConnection | null>(null);

  // Synchronous refs protect against double clicks, late promises and unmounts.
  const release = useCallback(() => {
    generation.current++;
    request.current?.abort(); request.current = null;
    connection.current?.dispose(); connection.current = null;
  }, []);
  const reset = useCallback((notice = "") => {
    release();
    setPending(false); setSnapshot(null); setBinding(null);
    setAccount(""); setVersion(""); setMessage(notice);
  }, [release]);
  useEffect(() => {
    reset(); setWalletId(""); setChainId("");
    return release;
  }, [controller, release, reset]);

  const eligible = discovery.wallets.filter(wallet => wallet.changes === "subscribed" &&
    ["standard:connect", "standard:events", "solana:signTransaction"].every(feature => wallet.features.includes(feature)));
  const wallet = eligible.find(item => item.id === walletId);
  const walletChain = SOLANA_STANDARD_CLUSTERS[chainId];
  const canConnect = discovery.status === "listening" && !!wallet && !!walletChain && wallet.chains.includes(walletChain);

  const refresh = useCallback(() => {
    const current = connection.current;
    if (!current) return;
    const next = current.snapshot();
    if (next.status !== "connected") reset(INVALIDATED);
    else setSnapshot(next);
  }, [reset]);
  useEffect(() => {
    if (walletId && !canConnect && (connection.current || request.current || !wallet)) {
      reset("Wallet registration or network is no longer available. Choose a registered wallet and network again.");
      if (!wallet) { setWalletId(""); setChainId(""); }
    } else refresh();
  }, [discovery.revision, canConnect, walletId, wallet, refresh, reset]);
  useEffect(() => {
    if (!snapshot) return;
    const interval = window.setInterval(refresh, 1000);
    const expiry = window.setTimeout(refresh, Math.max(0, snapshot.expiresAt - Date.now()));
    return () => { window.clearInterval(interval); window.clearTimeout(expiry); };
  }, [snapshot?.expiresAt, refresh]);

  async function connect() {
    if (!canConnect || request.current || connection.current) return;
    reset();
    const ticket = generation.current;
    const abort = new AbortController();
    request.current = abort; setPending(true);
    setMessage("Waiting for account access in the selected wallet. No signing or transaction requested.");
    try {
      const result = await controller.connectSolana(walletId, chainId, { signal: abort.signal });
      if (generation.current !== ticket) { result.dispose(); return; }
      const next = result.snapshot();
      if (next.status !== "connected") { result.dispose(); throw new Error("SESSION_CHANGED"); }
      connection.current = result; setSnapshot(next);
      setMessage("Account access received. Select an account and transaction format explicitly; execution disabled.");
    } catch (error) {
      if (generation.current !== ticket) return;
      const code = error instanceof Error ? error.message : "";
      setMessage(code === "SOLANA_STANDARD_CONNECTION_PENDING"
        ? "An earlier wallet request is still pending. Finish or dismiss it in the wallet before retrying."
        : code === "SOLANA_STANDARD_CONNECTION_TIMEOUT"
          ? "Account access timed out locally. The wallet prompt may still be open; finish or dismiss it before retrying."
          : "Account access was not established. Check wallet support and your response in the wallet, then retry explicitly.");
    } finally {
      if (generation.current === ticket) { request.current = null; setPending(false); }
    }
  }

  function editSelection() {
    connection.current?.clearSelection(); setBinding(null);
    setMessage("Selection changed. Keep the new account selection explicitly; execution disabled.");
  }
  function keepSelection() {
    if (!connection.current || !account || (version !== "legacy" && version !== "0")) return;
    try {
      const selected = connection.current.selectAccount(account, version === "0" ? 0 : "legacy");
      connection.current.assertCurrent(selected);
      setBinding(selected); setMessage("Account selection kept on this page only; execution disabled.");
    } catch { reset(INVALIDATED); }
  }

  return <details className="wallet-connection-panel solana-standard-connection">
    <summary>Optional Solana account connection</summary>
    <p>Request account access only. No signing, transfer or transaction submission. Wallet names are self-reported; verify the wallet prompt before accepting.</p>
    <div className="standard-connection-fields">
      <label>Solana wallet registration
        <select aria-label="Solana wallet registration" value={walletId} onChange={event => { reset(); setWalletId(event.target.value); setChainId(""); }}>
          <option value="">Choose a wallet registration</option>
          {eligible.map(item => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}
        </select>
      </label>
      <label>Solana connection network
        <select aria-label="Solana connection network" value={chainId} onChange={event => { reset(); setChainId(event.target.value); }}>
          <option value="">Choose a network</option>
          {Object.entries(SOLANA_STANDARD_CLUSTERS).map(([id, name]) => <option key={id} value={id} disabled={!wallet?.chains.includes(name)}>{name.replace("solana:", "")}</option>)}
        </select>
      </label>
    </div>
    {wallet && <p>Selected registration: {wallet.name} · {wallet.id}</p>}
    {chainId && <p>Requested network: {chainId}. This label is not live genesis verification and does not switch the wallet network.</p>}
    {!canConnect && <p>Choose a wallet reporting Solana signing, account access and change notifications, then a network it reports. Capabilities are checked again on request.</p>}
    <button type="button" disabled={!canConnect || pending || !!snapshot} onClick={() => void connect()}>Request account access</button>
    {pending && <button type="button" onClick={() => reset("Stopped waiting locally. The wallet prompt may still be open; this does not cancel or revoke wallet permission.")}>Stop waiting</button>}
    <p role="status" aria-live="polite">{message}</p>
    <div className="standard-connection-fields">
      <label>Solana account
        <select aria-label="Solana account" value={account} disabled={!snapshot} onChange={event => { editSelection(); setAccount(event.target.value); }}>
          <option value="">Choose an account</option>
          {snapshot?.accounts.map(address => <option key={address} value={address}>{address}</option>)}
        </select>
      </label>
      <label>Transaction format
        <select aria-label="Transaction format" value={version} disabled={!snapshot} onChange={event => { editSelection(); setVersion(event.target.value); }}>
          <option value="">Choose a format</option>
          {snapshot?.transactionVersions.map(item => <option key={item} value={String(item)}>{item === 0 ? "Version 0" : "Legacy"}</option>)}
        </select>
      </label>
    </div>
    {account && <p>Account to select: {account}</p>}
    <button type="button" disabled={!snapshot || !account || !version || !!binding} onClick={keepSelection}>Keep account selection</button>
    {snapshot && <button type="button" onClick={() => reset("Local connection forgotten. Wallet permissions were not revoked; manage them in your wallet.")}>Forget local connection</button>}
    {binding && <div className="standard-account-selection">
      <p>Selected account: {binding.address}</p>
      <p>Network: {binding.chainId} · Format: {String(binding.transactionVersion)}</p>
      <p>Local selection expires: {new Date(binding.expiresAt).toISOString()}</p>
      <p>Signing, submission and execution disabled. No route has been enabled.</p>
    </div>}
    <p>Local access expires five minutes after connection, or on wallet changes, registration removal or leaving this view. Forgetting locally does not revoke wallet permissions.</p>
  </details>;
}
