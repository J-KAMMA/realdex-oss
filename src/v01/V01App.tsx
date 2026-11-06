import { useEffect, useRef, useState } from "react";
import { JsonRpcProvider, formatUnits } from "ethers";
import { useEip6963Wallets } from "../wallet/use-eip6963";
import { createProviderBindingGrant } from "../wallet/capabilities";
import { isExplicitWalletRejection } from "../wallet/errors";
import { createRouteExecutionIntentId } from "../routing/execution-intent";
import { executeRouteQuote } from "../routing/engine";
import type { RouteDescriptor, RouteQuote, RouteQuoteRequest, RouteExecutionReceipt } from "../routing/types";
import { verifyV01Profile, invalidateV01Profile, type VerifiedV01Profile } from "../release/v01-profile";
import { createV01ProfileReaders } from "../release/v01-profile-reader";
import { assertDistinctPublicRpcEndpoints, createPublicJsonRpcDeploymentReader } from "../release/evm-json-rpc-reader";
import { assertEvmSwapRecoveryCapacity, createJsonRpcEvmSwapRecoveryReader, readEvmSwapRecoveryJournal, recordEvmSwapReceipt, refreshEvmSwapRecovery, writeEvmSwapRecoveryRecord, type EvmSwapRecoveryRecord } from "../swap/evm-swap-recovery";
import EvmSwapRecoveryCard, { recoveryStatusLabel } from "../swap/EvmSwapRecoveryCard";
import { parsePositiveAmount } from "../lib";
import { createV01Runtime, isV01WalletCandidate } from "./runtime";
import type { V01FeePlan } from "./fees";
import V01CandidatePanel from "./V01CandidatePanel";
import V01HistoryRetention from "./V01HistoryRetention";
import { prepareV01HistoryExport, removeV01ExportedHistory, type V01HistoryExport } from "./history-retention";
import { adoptV01Candidate } from "./candidate-adoption";
import { verifyV01ReplacementRecovery } from "./replacement-recovery";
import { createV01RecoveryIntent } from "./recovery-intent";
import { verifyV01Candidate, type V01CandidateObservation } from "./candidate-reconciliation";
import { REVIEWED_V01_CONFIGURATION, type ReviewedV01Configuration } from "./reviewed-profile";
import { canCloseV01Operation, clearActiveV01Operation, readActiveV01Operation, saveActiveV01Operation, persistV01SendAttempt, withV01OperationLock, type ActiveV01Operation } from "./active-operation";
import "./v01.css";

type QuoteBundle = { route: RouteDescriptor; request: RouteQuoteRequest; quote: RouteQuote; fees: V01FeePlan; inputSymbol: string; outputSymbol: string };

const HISTORY_UNREADABLE = "保存した履歴または未解決操作を読み取れません。新しい交換を始めないでください。";

export default function V01App({ configuration = REVIEWED_V01_CONFIGURATION }: { configuration?: ReviewedV01Configuration | null }) {
  const wallets = useEip6963Wallets();
  const [rpcA, setRpcA] = useState(""); const [rpcB, setRpcB] = useState("");
  const [profile, setProfile] = useState<VerifiedV01Profile>();
  const [account, setAccount] = useState("");
  const [amount, setAmount] = useState(""); const [reverse, setReverse] = useState(false); const [slippage, setSlippage] = useState("0.50");
  const [bundle, setBundle] = useState<QuoteBundle>();
  const [balances, setBalances] = useState<{ ambr: bigint; jade: bigint; gas: bigint }>();
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(""); const [error, setError] = useState("");
  const [records, setRecords] = useState<EvmSwapRecoveryRecord[]>([]); const [selectedRecord, setSelectedRecord] = useState("");
  const [active, setActive] = useState<ActiveV01Operation | null>(null);
  const [candidateHash, setCandidateHash] = useState(""); const [candidateRole, setCandidateRole] = useState<"approval" | "swap">("swap");
  const [candidateResult, setCandidateResult] = useState<{ binding: string; observation: V01CandidateObservation }>();
  const candidateRevision = useRef(0);
  const [historyArchive, setHistoryArchive] = useState<V01HistoryExport>();
  const [savedCopyConfirmed, setSavedCopyConfirmed] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const revision = useRef(0); const running = useRef(false); const connecting = useRef(false); const accountRef = useRef("");
  const runtime = useRef<ReturnType<typeof createV01Runtime> | undefined>(undefined); const provider = useRef<JsonRpcProvider | undefined>(undefined);
  const currentProfile = useRef<VerifiedV01Profile | undefined>(undefined);
  const walletRef = useRef(wallets); walletRef.current = wallets;
  const clearHistoryArchive = () => { setHistoryArchive(undefined); setSavedCopyConfirmed(false); };

  const invalidateSession = () => {
    revision.current++; runtime.current = undefined; accountRef.current = "";
    setAccount(""); setBalances(undefined); setBundle(undefined); setCandidateResult(undefined); candidateRevision.current++;
    clearHistoryArchive();
  };
  const reloadHistory = () => {
    try {
      setRecords(readEvmSwapRecoveryJournal()); setActive(readActiveV01Operation());
      // The block lifts as soon as the store reads again, so this sentence has to
      // lift with it. Only this one is cleared: another error still standing is
      // about something else and is not ours to withdraw.
      setError((current) => (current === HISTORY_UNREADABLE ? "" : current));
    }
    catch { setError(HISTORY_UNREADABLE); setActive({ schema: "realdex.v01-active-operation.v1", intentId: "invalid", quoteId: "invalid", profileFingerprint: "invalid", recoveryId: null }); }
  };
  useEffect(() => {
    const storageChanged = () => { candidateRevision.current++; setCandidateResult(undefined); clearHistoryArchive(); reloadHistory(); };
    reloadHistory(); const timer = setInterval(() => setClock(Date.now()), 500); window.addEventListener("storage", storageChanged);
    return () => { clearInterval(timer); window.removeEventListener("storage", storageChanged); revision.current++; provider.current?.destroy(); };
  }, []);
  useEffect(() => {
    invalidateSession();
    const selected = wallets.selected?.provider;
    const changed = () => { invalidateSession(); setNotice("ウォレットの状態が変わりました。選択内容を確認して接続し直してください。"); };
    const accountsChanged = () => { if (!(connecting.current && !accountRef.current)) changed(); };
    selected?.on?.("accountsChanged", accountsChanged); selected?.on?.("chainChanged", changed); selected?.on?.("disconnect", changed);
    return () => { selected?.removeListener?.("accountsChanged", accountsChanged); selected?.removeListener?.("chainChanged", changed); selected?.removeListener?.("disconnect", changed); };
  }, [wallets.revision, wallets.selected?.provider]);

  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (reason) { setError(errorLabel(reason)); }
    finally { running.current = false; setBusy(false); reloadHistory(); }
  };
  const changeRpc = (value: string, second: boolean) => {
    invalidateSession(); if (currentProfile.current) invalidateV01Profile(currentProfile.current);
    currentProfile.current = undefined; setProfile(undefined); provider.current?.destroy(); provider.current = undefined;
    second ? setRpcB(value) : setRpcA(value);
  };
  const verify = () => run(async () => {
    if (!configuration) throw new Error("V01_REVIEWED_PROFILE_REQUIRED");
    invalidateSession(); if (currentProfile.current) invalidateV01Profile(currentProfile.current);
    currentProfile.current = undefined; setProfile(undefined);
    const version = revision.current;
    const readers = createV01ProfileReaders([rpcA, rpcB]);
    const next = await verifyV01Profile(configuration.profile, configuration.pin, readers, { isCurrent: () => revision.current === version });
    if (revision.current !== version) throw new Error("V01_WALLET_CONTEXT_CHANGED");
    provider.current?.destroy(); provider.current = new JsonRpcProvider(rpcA.trim());
    currentProfile.current = next; setProfile(next); setNotice("対象ネットワーク・配置記録・プール・2トークンを照合しました。ウォレット接続や交換の許可ではありません。");
  });
  const connect = () => run(async () => {
    if (!profile || !provider.current || !wallets.selected || wallets.selection !== "explicit") throw new Error("V01_EXPLICIT_WALLET_SELECTION_REQUIRED");
    const version = revision.current; const entry = wallets.selected;
    const next = createV01Runtime({ profile, entry, explicitlySelected: true, readProvider: provider.current, persistBeforeWalletRequest: persistV01SendAttempt, isCurrent: () => revision.current === version && currentProfile.current === profile && walletRef.current.selected?.provider === entry.provider && walletRef.current.selection === "explicit" });
    connecting.current = true;
    try {
      const owner = await next.connect();
      if (revision.current !== version) throw new Error("V01_WALLET_CONTEXT_CHANGED");
      const freshBalances = await next.balances();
      if (revision.current !== version) throw new Error("V01_WALLET_CONTEXT_CHANGED");
      runtime.current = next; accountRef.current = owner; setAccount(owner); setBalances(freshBalances);
      setNotice("接続しました。トークン承認・交換はまだ行っていません。");
    } finally { connecting.current = false; }
  });
  const quote = () => run(async () => {
    setBundle(undefined);
    if (!profile || !runtime.current || !account) throw new Error("V01_CONNECTION_REQUIRED");
    const version = revision.current; const current = runtime.current;
    const route = profile.routes[reverse ? 1 : 0];
    const units = parsePositiveAmount(amount, 18);
    if (!/^\d+(?:\.\d{1,2})?$/.test(slippage)) throw new Error("ROUTE_SLIPPAGE_OUT_OF_RANGE");
    const request: RouteQuoteRequest = {
      executionIntentId: createRouteExecutionIntentId(), sourceAsset: route.sourceAsset, destinationAsset: route.destinationAsset,
      amountInBaseUnits: units, accountId: `eip155:84532:${account}`, recipient: account, walletCapabilityId: "eip1193", sessionRevision: version,
      walletGrant: createProviderBindingGrant({ transportId: `v01:${wallets.selectedId}`, accountId: `eip155:84532:${account}`, walletCapabilityId: "eip1193", sessionRevision: version, expiresAt: profile.expiresAt }),
      slippageBps: Math.round(Number(slippage) * 100)
    };
    const freshBalances = await current.balances();
    if ((reverse ? freshBalances.jade : freshBalances.ambr) < units) throw new Error("V01_TOKEN_BALANCE_INSUFFICIENT");
    const next = await current.adapter.quote(route, request);
    if (revision.current !== version || runtime.current !== current) throw new Error("V01_WALLET_CONTEXT_CHANGED");
    setBalances(freshBalances); setBundle({ route, request, quote: next, fees: current.feePlan(next), inputSymbol: reverse ? "JADE" : "AMBR", outputSymbol: reverse ? "AMBR" : "JADE" });
    setNotice("見積りを取得しました。承認先・最低受取額・期限を確認してください。");
  });
  const execute = () => run(async () => {
    if (!bundle || !runtime.current || !profile) throw new Error("V01_QUOTE_NOT_CURRENT");
    const current = bundle; const currentRuntime = runtime.current; const adapter = currentRuntime.adapter;
    await withV01OperationLock(async () => {
      if (readActiveV01Operation()) throw new Error("V01_UNRESOLVED_OPERATION");
      assertEvmSwapRecoveryCapacity();
      let reserved: ActiveV01Operation = { schema: "realdex.v01-active-operation.v3", intentId: current.request.executionIntentId, quoteId: current.quote.quoteId, profileFingerprint: profile.fingerprint, recoveryId: null, attempts: [], recovery: createV01RecoveryIntent(profile, current.route, current.request, current.quote) };
      let reservationWritten = false;
      let last: EvmSwapRecoveryRecord | undefined;
      const persist = (receipt: RouteExecutionReceipt) => {
        const record = recordEvmSwapReceipt(current.route, current.request, current.quote, receipt, { sourceSymbol: current.inputSymbol, sourceDecimals: 18, destinationSymbol: current.outputSymbol, destinationDecimals: 18 }, last);
        if (record) {
          const durable = readActiveV01Operation();
          if (!durable || durable.intentId !== reserved.intentId || durable.quoteId !== reserved.quoteId || durable.profileFingerprint !== reserved.profileFingerprint) throw new Error("V01_ACTIVE_OPERATION_CHANGED");
          writeEvmSwapRecoveryRecord(record); last = record;
          reserved = { ...durable, recoveryId: record.recoveryId }; saveActiveV01Operation(reserved); setSelectedRecord(record.recoveryId); reloadHistory();
        }
        setNotice(receipt.steps.some(step => step.kind === "swap") ? "交換の送信情報を保存しました。履歴から確認数を照会してください。" : "トークン承認の進行中です。交換完了ではありません。");
      };
      try {
        const result = await executeRouteQuote(current.route, current.request, current.quote, [adapter], Date.now(), persist, () => { saveActiveV01Operation(reserved); reservationWritten = true; setActive(reserved); });
        persist(result);
        if (result.state === "failed" && result.failureProof?.type === "no-value-transfer-submitted" && result.steps.every(step => !step.txHash)) clearActiveV01Operation(reserved);
        setNotice(result.state === "confirmed" ? "交換がブロックに取り込まれました。履歴を照会して2確認を確認してください。" : result.state === "failed" ? "操作は停止しました。履歴と承認残高を確認してください。" : "結果は未確定です。再送せず履歴を照会してください。");
      } catch (reason) {
        if (reservationWritten && !currentRuntime.signatureWasRequested(current.quote)) clearActiveV01Operation(reserved);
        throw reason;
      } finally { setBundle(undefined); }
    });
  });
  const relevant = records.filter(record => configuration && record.chainId === "eip155:84532" && record.executionTarget.toLowerCase() === configuration.profile.pool.address.toLowerCase());
  const record = relevant.find(item => item.recoveryId === selectedRecord) ?? relevant[0];
  useEffect(clearHistoryArchive, [record?.recoveryId, record?.revision]);
  const exportHistory = () => run(async () => {
    clearHistoryArchive();
    if (!record) throw new Error("V01_HISTORY_CHANGED");
    const version = revision.current;
    const archive = await prepareV01HistoryExport(record);
    const current = readEvmSwapRecoveryJournal().find(item => item.recoveryId === record.recoveryId);
    if (version !== revision.current || JSON.stringify(current) !== JSON.stringify(archive.record)) throw new Error("V01_HISTORY_CHANGED");
    const url = URL.createObjectURL(new Blob([archive.serialized], { type: "application/json" }));
    try {
      const link = document.createElement("a"); link.href = url; link.download = archive.filename;
      link.click(); setHistoryArchive(archive);
      setNotice("選択した履歴の控えの保存を要求しました。ファイルを開いて内容を確認してください。履歴はまだ削除していません。");
    } finally { setTimeout(() => URL.revokeObjectURL(url), 30_000); }
  });
  const removeHistory = () => run(async () => {
    const version = revision.current, checkedProfile = profile;
    try {
      if (!historyArchive || !record || JSON.stringify(historyArchive.record) !== JSON.stringify(record) || !checkedProfile || currentProfile.current !== checkedProfile) throw new Error("V01_HISTORY_CHANGED");
      await removeV01ExportedHistory({ archive: historyArchive, savedCopyConfirmed, profile: checkedProfile, isCurrent: () => version === revision.current && currentProfile.current === checkedProfile });
      setNotice("選択した1件をこのブラウザの履歴から削除しました。控えファイルは保管してください。取引・承認権限・他の履歴は変更していません。アプリで元に戻す機能はありません。");
    } catch { throw new Error("V01_HISTORY_REMOVAL_NOT_COMPLETED"); }
    finally { clearHistoryArchive(); }
  });
  const refresh = () => run(async () => {
    if (!record || !provider.current) throw new Error("V01_REVIEWED_PROFILE_REQUIRED");
    await withV01OperationLock(async () => {
      const version = revision.current; const reader = provider.current!;
      const latest = readEvmSwapRecoveryJournal().find(item => item.recoveryId === record.recoveryId);
      if (!latest) throw new Error("V01_RECOVERY_MISSING");
      const next = await refreshEvmSwapRecovery(latest, createJsonRpcEvmSwapRecoveryReader(reader));
      if (revision.current !== version || reader !== provider.current) throw new Error("V01_WALLET_CONTEXT_CHANGED");
      writeEvmSwapRecoveryRecord(next); setNotice("保存済み取引を読み取り照会しました。新しい署名や再送は行っていません。");
    });
  });
  const closeOperation = () => run(async () => withV01OperationLock(async () => {
    const current = readActiveV01Operation(); const latest = readEvmSwapRecoveryJournal().find(item => item.recoveryId === record?.recoveryId);
    if (!current || !latest || !provider.current) throw new Error("V01_UNRESOLVED_OPERATION");
    const version = revision.current; const reader = provider.current;
    const replacement = latest.transactions.some(transaction => transaction.envelope?.replacement);
    const checkedProfile = profile;
    if (replacement && (!checkedProfile || checkedProfile !== currentProfile.current)) throw new Error("V01_REPLACEMENT_RECOVERY_PROFILE_REQUIRED");
    const checked = replacement ? await verifyV01ReplacementRecovery({ operation: current, record: latest, profile: checkedProfile!,
      readers: assertDistinctPublicRpcEndpoints([rpcA, rpcB]).map(endpoint => createPublicJsonRpcDeploymentReader(endpoint)),
      readOperation: readActiveV01Operation, readRecord: () => readEvmSwapRecoveryJournal().find(item => item.recoveryId === latest.recoveryId),
      isCurrent: () => version === revision.current && reader === provider.current && checkedProfile === currentProfile.current })
      : await refreshEvmSwapRecovery(latest, createJsonRpcEvmSwapRecoveryReader(reader));
    if (version !== revision.current || reader !== provider.current || JSON.stringify(readActiveV01Operation()) !== JSON.stringify(current) || !canCloseV01Operation(current, checked)) throw new Error("V01_UNRESOLVED_OPERATION");
    writeEvmSwapRecoveryRecord(checked);
    clearActiveV01Operation(current); setBundle(undefined); setNotice(checked.stage.endsWith("replaced") ? "置換を再照合して操作を終了しました。元の交換の成功を意味しません。再送はしていません。次の交換には新しい見積りが必要です。" : "照会済みの操作を終了しました。次の交換には新しい見積りが必要です。");
  }));
  const fresh = !!profile && profile.expiresAt > clock;
  const validQuote = !!bundle && fresh && bundle.quote.expiresAt > clock;
  const attempts = active && active.schema !== "realdex.v01-active-operation.v1" ? active.attempts : [];
  const selectedCandidateRole = attempts.find(item => item.role === candidateRole)?.role ?? attempts.at(-1)?.role ?? "swap";
  const clearCandidateResult = () => { candidateRevision.current++; setCandidateResult(undefined); };
  const verifyCandidate = () => run(async () => {
    clearCandidateResult();
    const version = revision.current, candidateVersion = candidateRevision.current;
    const expected = JSON.stringify(active), checkedProfile = profile;
    if (!checkedProfile || currentProfile.current !== checkedProfile) throw new Error("V01_REVIEWED_PROFILE_REQUIRED");
    await withV01OperationLock(async () => {
      const operation = readActiveV01Operation();
      if (!operation || JSON.stringify(operation) !== expected) throw new Error("V01_CANDIDATE_CONTEXT_CHANGED");
      const isCurrent = () => revision.current === version && candidateRevision.current === candidateVersion && currentProfile.current === checkedProfile;
      const readers = assertDistinctPublicRpcEndpoints([rpcA, rpcB]).map(endpoint => createPublicJsonRpcDeploymentReader(endpoint));
      const observation = await verifyV01Candidate({ operation, role: selectedCandidateRole, hash: candidateHash.trim(), profile: checkedProfile, readers, readOperation: readActiveV01Operation, isCurrent });
      if (!isCurrent() || JSON.stringify(readActiveV01Operation()) !== expected) throw new Error("V01_CANDIDATE_CONTEXT_CHANGED");
      setCandidateResult({ binding: expected, observation });
      setNotice("保存した要求との一致を観測しました。履歴への採用・操作ロックの解除・再送は行っていません。");
    });
  });
  const adoptCandidate = () => run(async () => {
    const version = revision.current, candidateVersion = candidateRevision.current, checkedProfile = profile;
    if (!active || !candidateResult || candidateResult.binding !== JSON.stringify(active) || !checkedProfile || currentProfile.current !== checkedProfile) throw new Error("V01_CANDIDATE_CONTEXT_CHANGED");
    try {
      const adopted = await adoptV01Candidate({ operation: active, expected: candidateResult.observation, profile: checkedProfile,
        readers: assertDistinctPublicRpcEndpoints([rpcA, rpcB]).map(endpoint => createPublicJsonRpcDeploymentReader(endpoint)),
        isCurrent: () => revision.current === version && candidateRevision.current === candidateVersion && currentProfile.current === checkedProfile });
      setSelectedRecord(adopted.recoveryId);
      setNotice("再照合して履歴に保存しました。署名・再送はしていません。操作ロックは残っています。履歴欄で照会し、終了できる状態か確認してください。");
    } catch {
      throw new Error("V01_CANDIDATE_ADOPTION_NOT_COMPLETED");
    } finally { clearCandidateResult(); }
  });

  return <div className="v01-app">
    <header className="v01-header"><a href="#main" className="brand">RealDEX</a><span>v0.1 テストネット検証版</span></header>
    <main id="main" className="v01-main">
      <section className="v01-intro"><p className="eyebrow">BASE SEPOLIA · 84532</p><h1>交換の前に、<br />対象を確かめる。</h1><p>検証専用のAMBRとJADEを、固定した1つのプールで交換します。本番資産向けサービスではありません。</p><p>WindowsのChrome＋MetaMask拡張、通常のEOAが今回の検証対象です。未監査のソフトウェアです。</p><details><summary>初版の対応範囲</summary><ul><li>対象: Base Sepolia / AMBR ⇄ JADE / 各18 decimals</li><li>接続: 明示的に選択したMetaMask候補のみ</li><li>対象外: 他チェーン、他ウォレット、任意トークン、ブリッジ、流動性操作、マルチホップ</li><li>トークンの価値や価格は保証しません。検証トークンは誰でもmintできる試験用コードです。</li></ul></details></section>
      <div className="v01-workspace">
        <section className="v01-card" aria-labelledby="verify-title"><h2 id="verify-title">1. 固定対象を検証</h2>
          {!configuration && <p className="v01-warning" role="status">承認済みの配置記録が未設定です。現在は接続・承認・交換を開始できません。実測前のアドレスは使用しません。</p>}
          <label>公開RPC A<input value={rpcA} onChange={e => changeRpc(e.target.value, false)} disabled={busy} placeholder="https://…" autoComplete="off" spellCheck={false} /></label>
          <label>公開RPC B（別ホスト）<input value={rpcB} onChange={e => changeRpc(e.target.value, true)} disabled={busy} placeholder="https://…" autoComplete="off" spellCheck={false} /></label>
          <p className="v01-help">認証情報やAPIキーを含まない公開HTTPS URLだけを使用してください。入力は保存しません。</p>
          <button disabled={busy || !configuration} onClick={verify}>配置記録とトークンを照合</button>
          <p role="status">{fresh ? "照合済み（短時間のみ有効）" : profile ? "検証期限切れ。再検証してください。" : "未検証"}</p>
          {configuration && <details><summary>固定したアドレスとリリース</summary><dl><dt>Release</dt><dd>{configuration.pin.releaseId}</dd><dt>Pool</dt><dd>{configuration.profile.pool.address}</dd><dt>AMBR</dt><dd>{configuration.profile.tokens.ambr}</dd><dt>JADE</dt><dd>{configuration.profile.tokens.jade}</dd></dl></details>}
        </section>
        <section className="v01-card" aria-labelledby="wallet-title"><h2 id="wallet-title">2. ウォレットを選択・接続</h2>
          <label>MetaMask候補<select value={wallets.selection === "explicit" ? wallets.selectedId ?? "" : ""} disabled={busy} onChange={e => { invalidateSession(); wallets.selectProvider(e.target.value); }}><option value="" disabled>自分で確認して選択</option>{wallets.providers.map(entry => <option key={entry.info.uuid} value={entry.info.uuid} disabled={!isV01WalletCandidate(entry)}>{entry.info.name}{isV01WalletCandidate(entry) ? "（自己申告）" : "（初版対象外）"}</option>)}</select></label>
          <p className="v01-help">名前・識別子はウォレットの自己申告です。本物のMetaMaskであることを拡張機能側で確認してください。接続だけでは承認や交換を行いません。</p>
          <button disabled={busy || !fresh || wallets.selection !== "explicit" || !isV01WalletCandidate(wallets.selected)} onClick={connect}>選択したウォレットに接続</button>
          <p className="v01-address">{account || "未接続"}</p>
        </section>
        <section className="v01-card" aria-labelledby="swap-title"><h2 id="swap-title">3. 交換内容を確認</h2>
          <label>交換方向<select value={reverse ? "reverse" : "forward"} disabled={busy} onChange={e => { setReverse(e.target.value === "reverse"); setBundle(undefined); }}><option value="forward">AMBR → JADE</option><option value="reverse">JADE → AMBR</option></select></label>
          <label>支払数量（{reverse ? "JADE" : "AMBR"}）<input inputMode="decimal" value={amount} disabled={busy} onChange={e => { setAmount(e.target.value); setBundle(undefined); }} placeholder="0.0" /></label>
          <label>スリッページ許容値（%・0〜5）<input inputMode="decimal" value={slippage} disabled={busy} onChange={e => { setSlippage(e.target.value); setBundle(undefined); }} /></label>
          <p className="v01-help">残高: {balances ? `${formatUnits(reverse ? balances.jade : balances.ambr, 18)} ${reverse ? "JADE" : "AMBR"} / ${formatUnits(balances.gas, 18)} test ETH` : "未取得"}</p>
          <button disabled={busy || !fresh || !account || !!active} onClick={quote}>見積りを取得</button>
          {bundle && <div className="v01-review">
            <dl><dt>支払</dt><dd>{formatUnits(bundle.request.amountInBaseUnits, 18)} {bundle.inputSymbol}</dd><dt>予想受取</dt><dd>{formatUnits(bundle.quote.expectedOutBaseUnits, 18)} {bundle.outputSymbol}</dd><dt>最低受取</dt><dd>{formatUnits(bundle.quote.minimumOutBaseUnits, 18)} {bundle.outputSymbol}</dd><dt>承認</dt><dd>{bundle.quote.authorization.type === "approval" ? `今回の${formatUnits(bundle.request.amountInBaseUnits, 18)} ${bundle.inputSymbol}のみ` : "現在のallowanceで足りています"}</dd><dt>交換手数料</dt><dd>{configuration ? `${configuration.profile.pool.feeBasisPoints} bp（${(configuration.profile.pool.feeBasisPoints / 100).toFixed(2)}%）· プールが受け取り、流動性提供者の持分になります。運営の取り分はありません` : "未確認"}</dd><dt>承認先・交換先</dt><dd>{bundle.route.sourceExecutionTarget}</dd><dt>受取先</dt><dd>{bundle.request.recipient}</dd><dt>期限</dt><dd>{new Date(bundle.quote.expiresAt).toLocaleTimeString()} {!validQuote && "（失効）"}</dd></dl>
            <p>手数料予算（合計）: {formatUnits(bundle.fees.totalBudget, 18)} test ETH</p>
            {bundle.fees.steps.map(step => <details key={step.role}><summary>{step.role === "approval" ? "承認" : "交換"}の費用予算: {formatUnits(step.totalBudget, 18)} test ETH</summary><dl><dt>L2実行予算</dt><dd>{formatUnits(step.l2Budget, 18)} test ETH</dd><dt>L1データ予算</dt><dd>{formatUnits(step.l1Budget, 18)} test ETH</dd><dt>Operator予算</dt><dd>{formatUnits(step.operatorBudget, 18)} test ETH</dd><dt>Gas limit</dt><dd>{step.gasLimit.toString()}</dd><dt>Max fee / gas</dt><dd>{formatUnits(step.maxFeePerGas, 9)} gwei</dd><dt>Priority fee / gas</dt><dd>{formatUnits(step.maxPriorityFeePerGas, 9)} gwei</dd><dt>Nonce</dt><dd>{step.nonce}</dd></dl></details>)}
            <p>予算は確定手数料ではありません。gasは試算＋20%、L1とOperator費用は現在の照会値の2倍を確保します。送信直前に再検証し、予算を超える変化は再確認が必要です。ウォレット確認中の費用変化や、ウォレットでの設定変更までは固定できません。</p>
            {bundle.fees.approvalSimulation && <p>交換gasは承認後を仮定した読み取りシミュレーションです。実際の承認や資産移動ではありません。承認後の送信前検証には仮置きを使いません。</p>}
            <p>承認は資産の使用許可であり、交換とは別の取引です。承認後に停止するとallowanceが残る場合があります。L1データ費用を含む最終内容をウォレットで確認してください。送信後は取り消せるとは限りません。</p>
          </div>}
          <button className="v01-primary" disabled={busy || !validQuote || !!active} onClick={execute}>{bundle?.quote.authorization.type === "approval" ? "数量を承認して交換へ（ウォレットで2回確認）" : "確認した内容で交換"}</button>
          {active && <p className="v01-warning">未解決または確認待ちの操作があります。新しい交換を始めず、下の履歴を照会してください。履歴がない場合も、ウォレット側の活動記録を確認するまで再送しないでください。</p>}
        </section>
        <div aria-live="polite" className="v01-notice">{busy ? "処理中です。重ねて実行しないでください。" : notice}</div>{error && <p className="v01-warning" role="alert">{error}</p>}
        <section className="v01-card" aria-labelledby="history-title"><h2 id="history-title">4. 保存した取引を照会</h2><p className="v01-help">署名せず読み取りだけを行います。2確認を基準とし、ブロックへの取り込みを最終確定とは表示しません。</p>
          <p className="v01-help">置換履歴の操作終了時は、2つのRPCで送信元・nonce・取引内容とブロックを再照合します。キャンセルや別内容への置換は、元の交換の成功ではありません。交換の要求が残っている場合、承認の置換だけでは終了できません。</p>
          {relevant.length > 0 && <label>取引履歴<select value={record?.recoveryId ?? ""} disabled={busy} onChange={e => setSelectedRecord(e.target.value)}>{relevant.map(item => <option key={item.recoveryId} value={item.recoveryId}>{new Date(item.createdAt).toLocaleString()} · {item.source.symbol}→{item.destination.symbol} · {recoveryStatusLabel(item.stage, "ja")}</option>)}</select></label>}
          {record ? <EvmSwapRecoveryCard locale="ja" record={record} busy={busy || !provider.current} error="" onRefresh={refresh} /> : <p>この固定プールの取引記録はまだありません。既存の別経路の記録は削除しません。</p>}
          {active && record && canCloseV01Operation(active, record) && <button disabled={busy} onClick={closeOperation}>照会済みの操作を終了し、新しい見積りへ</button>}
          {record && <V01HistoryRetention record={record} totalRecords={records.length} busy={busy} fresh={fresh} hasActive={!!active}
            archive={historyArchive && historyArchive.expiresAt > clock && JSON.stringify(historyArchive.record) === JSON.stringify(record) ? historyArchive : undefined}
            savedCopyConfirmed={savedCopyConfirmed} onExport={exportHistory} onConfirm={setSavedCopyConfirmed} onRemove={removeHistory} />}
        </section>
        {active && <V01CandidatePanel operation={active} role={selectedCandidateRole} hash={candidateHash} busy={busy} fresh={fresh}
          observation={fresh && candidateResult?.binding === JSON.stringify(active) ? candidateResult.observation : undefined}
          onRole={role => { clearCandidateResult(); setCandidateRole(role); }} onHash={hash => { clearCandidateResult(); setCandidateHash(hash); }} onVerify={verifyCandidate} onAdopt={adoptCandidate} />}
      </div>
    </main><footer className="v01-footer">RealDEX · テストネット検証専用 · 実機・公開テストネットの受入は未完了</footer>
  </div>;
}

function errorLabel(reason: unknown): string {
  const code = reason instanceof Error ? reason.message : "";
  if (code.startsWith("V01_REPLACEMENT_RECOVERY_")) {
    // Only fixed local identifiers may enter the message, never arbitrary RPC
    // errors, URLs, transaction payloads or exception stacks.
    const known = ["V01_REPLACEMENT_RECOVERY_MISMATCH", "V01_REPLACEMENT_RECOVERY_TIMEOUT", "V01_REPLACEMENT_RECOVERY_CONTEXT_CHANGED", "V01_REPLACEMENT_RECOVERY_READ_FAILED", "V01_REPLACEMENT_RECOVERY_CONFIRMATIONS_REQUIRED", "V01_REPLACEMENT_RECOVERY_PROFILE_REQUIRED"].includes(code);
    return `置換取引を十分な確認数で再照合できませんでした。操作は終了せず、再送もしません。固定対象を再検証し、履歴と置換ハッシュを確認してください。${known ? `（${code}）` : ""}`;
  }
  if (code === "V01_HISTORY_REMOVAL_NOT_COMPLETED") return "履歴の削除完了を確認できませんでした。自動で繰り返しません。現在の履歴を確認し、控えファイルを保管してください。未解決操作がある場合は先に照会し、終了可能か確認してください。";
  if (code.startsWith("V01_HISTORY_")) return "選択した履歴が変わったか、控えの準備を確認できませんでした。履歴を確認してから操作し直してください。";
  if (code === "V01_CANDIDATE_ADOPTION_NOT_COMPLETED") return "履歴への保存を完了できませんでした。一部が保存されている場合もあります。操作ロックは解除していません。取引は再送せず、履歴を確認してハッシュの照合からやり直してください。承認が必要だった交換は、先に承認ハッシュを履歴へ保存してください。";
  if (isExplicitWalletRejection(reason)) return "ウォレットで拒否されました。未確定の操作がある場合は再送せず履歴を照会してください。";
  if (code === "WALLET_NETWORK_CHANGED") return "ウォレットとRPCをBase Sepolia（84532）に合わせてください。自動でネットワークは切り替えません。";
  if (/^V01_TOKEN_BALANCE_INSUFFICIENT/.test(code)) return "入力トークンの残高が足りません。数量を確認してください。";
  if (/^V01_GAS_BALANCE_INSUFFICIENT/.test(code)) return "手数料予算に必要なtest ETHが足りません。署名要求を停止しました。";
  if (/^V01_FEE_/.test(code)) return "手数料の確認ができないか、費用・nonce・期限が変わりました。送信せず停止しました。承認済みの場合は履歴を確認してから見積り直してください。";
  if (/^V01_UNRESOLVED_OPERATION/.test(code)) return "前の操作が未解決です。履歴を確認するまで新しい交換を開始できません。";
  if (code === "EVM_SWAP_RECOVERY_STORAGE_FULL") return "保存履歴が上限の16件に達したため、新しい交換を停止しました。既存の履歴は削除していません。履歴の照会は引き続き利用できます。";
  if (code === "EVM_SWAP_RECOVERY_STORAGE_NOT_CONFIRMED") return "取引履歴の保存を確認できませんでした。再送やブラウザデータの削除をせず、ウォレットの活動記録も確認してください。";
  if (/^V01_CANDIDATE_/.test(code)) return "取引ハッシュと保存した要求の一致を確認できませんでした。未送信とは判断できません。再送せず、ハッシュ・RPC・検証期限を確認してください。履歴と操作ロックは変更していません。";
  if (/^(V01_|WALLET_|QUOTE_|ROUTE_|DEPLOYMENT_|EXECUTION_|EVM_SWAP_)[A-Z0-9_]+$/.test(code)) return `確認条件を満たさないため停止しました（${code}）。入力・接続・検証期限を確認し、送信済みの可能性があれば履歴を照会してください。`;
  return "処理を完了できませんでした。送信された可能性がある場合は再送せず、履歴とウォレットを確認してください。";
}
