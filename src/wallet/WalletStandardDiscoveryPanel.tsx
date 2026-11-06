import { useEffect, useState } from "react";
import { startWalletStandardDiscovery, type WalletStandardDiscoveryController, type WalletStandardDiscoverySnapshot } from "./wallet-standard-discovery";
import SolanaStandardConnectionPanel from "./SolanaStandardConnectionPanel";

export default function WalletStandardDiscoveryPanel() {
  const [snapshot, setSnapshot] = useState<WalletStandardDiscoverySnapshot>({ status: "listening", revision: 0, rejected: 0, wallets: [] });
  const [controller, setController] = useState<WalletStandardDiscoveryController | null>(null);
  useEffect(() => {
    const instance = startWalletStandardDiscovery(window, setSnapshot);
    setController(() => instance);
    return () => instance();
  }, []);

  return <section className="wallet-standard-discovery" aria-labelledby="wallet-standard-heading">
    <h3 id="wallet-standard-heading">Detected Wallet Standard wallets</h3>
    <p>Read-only discovery. Names, chains and features are self-reported, not trust or permission. Discovery alone requests no connection, account access, signing or broadcast.</p>
    <p role="status">{snapshot.status === "unavailable" ? "Wallet discovery is unavailable in this browser." : snapshot.wallets.length ? `${snapshot.wallets.length} wallet registrations detected.` : "No Wallet Standard wallets detected. This does not mean no wallet is installed."}</p>
    {snapshot.rejected > 0 && <p>Some registrations were rejected or exceeded the discovery limits. No execution was enabled.</p>}
    <div className="universe-list">{snapshot.wallets.map(wallet => <article className="universe-item" key={wallet.id}>
      <strong>{wallet.name}</strong>
      <p>Page-local ID: {wallet.id} · execution disabled</p>
      <dl>
        <div><dt>Reported chain identifiers</dt><dd>{wallet.chains.join(" · ") || "None reported"}</dd></div>
        <div><dt>Change notifications</dt><dd>{wallet.changes === "subscribed" ? "Listening for changes" : "Unavailable — snapshot only"}</dd></div>
      </dl>
      <details><summary>Reported features ({wallet.features.length})</summary>
        <p>{wallet.features.join(" · ") || "None reported"}</p>
      </details>
    </article>)}</div>
    <p>Chain identifiers are shown as reported; they are not automatically mapped to RealDEX networks. Discovery does not select a wallet or enable a route.</p>
    {controller && <SolanaStandardConnectionPanel controller={controller} discovery={snapshot} />}
  </section>;
}
