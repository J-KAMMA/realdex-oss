import { CircleAlert, RefreshCw, ShieldCheck } from "lucide-react";
import { formatUnits } from "ethers";
import type { EvmSwapRecoveryRecord, EvmSwapRecoveryStage } from "./evm-swap-recovery";

type RecoveryLocale = "en" | "ja";

export function recoveryStatusLabel(stage: EvmSwapRecoveryStage, locale: RecoveryLocale = "en") {
  return (locale === "ja" ? RECOVERY_STATUS_JA : RECOVERY_STATUS)[stage].label;
}

export default function EvmSwapRecoveryCard({ record, busy, error, onRefresh, locale = "en" }: {
  record: EvmSwapRecoveryRecord;
  busy: boolean;
  error: string;
  onRefresh: () => void;
  locale?: RecoveryLocale;
}) {
  const ja = locale === "ja";
  const status = (ja ? RECOVERY_STATUS_JA : RECOVERY_STATUS)[record.stage];
  const swap = record.transactions.find((transaction) => transaction.role === "swap");
  const approval = record.transactions.find((transaction) => transaction.role === "approval");
  const confirmations = swap ? swap.confirmations : (approval?.confirmations ?? null);
  return <aside className={`swap-recovery ${status.tone}`} aria-live="polite" aria-busy={busy}>
    <div className="swap-recovery-head">
      <span>{status.tone === "ok" ? <ShieldCheck size={18} /> : <CircleAlert size={18} />}<span><strong>{status.label}</strong><small>{ja ? "交換経路に紐づく保存記録 · 改訂 " : "Saved route-bound recovery record · revision "}{record.revision}</small></span></span>
      <button type="button" onClick={onRefresh} disabled={busy} aria-label={ja ? "設定済みRPCで取引状況を照会（読み取りのみ）" : "Refresh swap status from configured RPC"}><RefreshCw size={15} className={busy ? "spin" : ""} />{busy ? (ja ? "照会中…" : "Checking…") : (ja ? "取引状況を照会" : "Refresh status")}</button>
    </div>
    <p>{status.detail}</p>
    <dl>
      <div><dt>{ja ? "入力数量" : "Input amount"}</dt><dd>{formatUnits(record.source.amountBaseUnits, record.source.decimals)} {record.source.symbol}</dd><code>{record.source.assetType}</code></div>
      <div><dt>{ja ? "最低受取数量" : "Minimum receive"}</dt><dd>{formatUnits(record.destination.minimumOutBaseUnits, record.destination.decimals)} {record.destination.symbol}</dd><code>{record.destination.assetType}</code></div>
      <div><dt>{ja ? "チェーン・アカウント" : "Chain"}</dt><dd>{record.chainId}</dd><code>{record.accountId}</code></div>
      <div><dt>{ja ? "実行方法・コントラクト" : "Execution"}</dt><dd>{record.executionMethod}</dd><code>{record.executionTarget}</code></div>
    </dl>
    <div className="swap-recovery-transactions">
      {swap && <TransactionEvidence locale={locale} label={ja ? "交換取引" : "Swap tx"} transaction={swap} detail={confirmations === null ? (ja ? "確認数はRPCへの照会で未確認です。" : "Confirmation count not independently refreshed") : (ja ? `観測した確認数：${confirmations}` : `${confirmations} confirmation${confirmations === 1 ? "" : "s"} observed`)} />}
      {approval && <TransactionEvidence locale={locale} label={ja ? "指定数量のトークン承認取引" : "Exact approval tx"} transaction={approval} detail={ja ? "トークン承認は交換とは別の取引です。承認の成功は交換完了を意味しません。" : "Approval is separate from the swap and does not prove exchange completion."} />}
    </div>
    <div className="swap-recovery-warning"><CircleAlert size={14} /><span>{ja ? "照会は読み取りのみです。結果が見つからない場合や照会に失敗した場合も、同じ見積りの取引を再送しないでください。" : "Refreshing is read-only. A missing or failed check never authorizes resending the same Quote."}</span></div>
    {error && <div className="swap-recovery-error">{ja ? "取引状況の照会を停止しました：" : "Status refresh stopped: "}{error}</div>}
  </aside>;
}

function TransactionEvidence({ label, transaction, detail, locale }: { label: string; transaction: EvmSwapRecoveryRecord["transactions"][number]; detail: string; locale: RecoveryLocale }) {
  const ja = locale === "ja";
  const replacement = transaction.envelope?.replacement;
  return <span>
    <strong>{replacement ? (ja ? `元の${label}` : `Original ${label.toLowerCase()}`) : label}</strong><code>{transaction.hash}</code>
    {replacement && <><strong>{ja ? `置換後の取引 · ${{ repriced: "主要項目が一致", cancelled: "キャンセル", replaced: "別内容" }[replacement.reason]} (${replacement.reason})` : `Replacement tx · ${replacement.reason}`}</strong><code>{replacement.hash}</code><small>{replacement.reason === "repriced" ? (ja ? "送信元・宛先・nonce・データ・value・chainが一致する置換です。手数料だけの変更とは保証しません。" : "Sender, recipient, nonce, data, value, and chain match. This does not establish that only fees changed.") : (ja ? "同じnonceが別内容の取引に使われました。元のトークン承認や交換が成功した証拠ではありません。" : "The nonce was consumed by different content. The original approval or swap is not proven.")}</small></>}
    {transaction.state === "searching" && transaction.nextSearchBlock !== undefined && <small>{ja ? `次の照会ではブロック ${transaction.nextSearchBlock} から、範囲を区切って置換を探します。` : `Bounded replacement search will continue from block ${transaction.nextSearchBlock}.`}</small>}
    <small>{detail}</small>
  </span>;
}

const RECOVERY_STATUS: Record<EvmSwapRecoveryStage, { label: string; detail: string; tone: "pending" | "ok" | "error" }> = {
  "approval-submitted": { label: "Approval submitted · swap submission unverified", detail: "The approval may still be pending. No swap hash is saved; a lost response or failed save can hide a submission. Do not resend.", tone: "pending" },
  "approval-confirmed": { label: "Approval confirmed · swap submission unverified", detail: "Spending permission was confirmed, but no swap hash is saved. This does not prove that the swap was never sent. Do not resend.", tone: "pending" },
  "approval-reverted": { label: "Approval reverted · no swap hash saved", detail: "The recorded approval failed on-chain. This approval receipt alone does not establish the outcome of an unrecorded swap request.", tone: "error" },
  "approval-replaced": { label: "Approval replaced · no swap hash saved", detail: "The approval nonce was consumed by different content or a cancellation. No swap hash is saved; do not infer an unrecorded swap outcome or resend.", tone: "error" },
  "stopped-after-approval": { label: "Stopped after approval · swap not sent", detail: "The approval completed, but the swap was intentionally not submitted. Review allowance before starting a new Quote.", tone: "pending" },
  "swap-submitted": { label: "Swap submitted · not confirmed", detail: "A transaction hash exists, but this recovery reader has not established the required confirmations.", tone: "pending" },
  "replacement-searching": { label: "Replacement search in progress", detail: "The original hash is absent after its nonce was consumed. Each refresh scans a bounded block range; retrying the Quote remains blocked.", tone: "pending" },
  "swap-included": { label: "Swap included · confirmation pending", detail: "The transaction is in a block but has not reached the RealDEX confirmation threshold.", tone: "pending" },
  "swap-confirmed": { label: "Swap confirmed on-chain", detail: "The configured RPC observed the required confirmations. This is chain execution evidence, not a protocol security certification.", tone: "ok" },
  "swap-reverted": { label: "Swap reverted on-chain", detail: "The swap transaction failed. The recovery record remains available for diagnosis.", tone: "error" },
  "swap-replaced": { label: "Swap replaced by different content", detail: "The same nonce was mined with a cancellation or changed transaction. This is not proof that the bound swap succeeded.", tone: "error" },
  unknown: { label: "Swap state unknown · do not retry", detail: "The wallet or RPC did not provide enough evidence to classify the submitted transaction safely.", tone: "error" }
};

const RECOVERY_STATUS_JA: typeof RECOVERY_STATUS = {
  "approval-submitted": { label: "トークン承認を送信・交換の送信状況は未確認", detail: "トークン承認は確認待ちの可能性があります。交換ハッシュは未保存ですが、応答や保存の失敗で送信済みの交換が記録されていない場合もあります。再送しないでください。", tone: "pending" },
  "approval-confirmed": { label: "トークン承認を確認・交換の送信状況は未確認", detail: "トークンの使用許可を確認しました。交換ハッシュは未保存ですが、交換を送信していない証拠ではありません。再送しないでください。", tone: "pending" },
  "approval-reverted": { label: "トークン承認が失敗・交換ハッシュは未保存", detail: "記録されたトークン承認はチェーン上で失敗しました。この承認の結果だけでは、未記録の交換要求の結果は判断できません。", tone: "error" },
  "approval-replaced": { label: "トークン承認が置換・交換ハッシュは未保存", detail: "承認のnonceが別内容の取引またはキャンセルに使われました。交換ハッシュは未保存です。未記録の交換結果を推測したり、再送したりしないでください。", tone: "error" },
  "stopped-after-approval": { label: "トークン承認後に停止・交換は未送信", detail: "トークン承認後、交換を送信する前に停止した記録です。新しい見積りを始める前に、残っている使用許可（allowance）を確認してください。", tone: "pending" },
  "swap-submitted": { label: "交換を送信・確認待ち", detail: "交換ハッシュはありますが、この照会では必要な確認数に達したことを確認できていません。", tone: "pending" },
  "replacement-searching": { label: "置換された取引を検索中", detail: "元のハッシュが見つからず、nonceは使用済みです。照会ごとに範囲を区切ってブロックを探します。同じ見積りの再送は引き続き禁止されています。", tone: "pending" },
  "swap-included": { label: "交換をブロックに取り込み・確認数待ち", detail: "交換はブロックに含まれていますが、RealDEXが必要とする確認数には達していません。", tone: "pending" },
  "swap-confirmed": { label: "交換を確認（チェーン上）", detail: "設定済みRPCで必要な確認数を観測しました。チェーン上の実行を示す情報であり、最終確定やプロトコルの安全性を保証するものではありません。", tone: "ok" },
  "swap-reverted": { label: "交換が失敗（チェーン上）", detail: "交換取引は失敗しました。原因を調べられるように記録を残しています。", tone: "error" },
  "swap-replaced": { label: "交換が別内容の取引に置換", detail: "同じnonceでキャンセルまたは内容を変更した取引がブロックに入りました。元の交換が成功した証拠ではありません。", tone: "error" },
  unknown: { label: "交換の状態は不明・再送禁止", detail: "ウォレットやRPCから得られた情報だけでは、送信した取引の状態を安全に判断できません。", tone: "error" }
};
