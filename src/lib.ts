import { getAddress, isAddress, parseUnits } from "ethers";

export type TxStage = "idle" | "approving" | "awaiting-wallet" | "submitted" | "confirmed" | "failed";

export type TokenInfo = {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: bigint;
};

export function normalizeAddress(value: string): string {
  if (!isAddress(value)) throw new Error("有効なEVMアドレスを入力してください。");
  return getAddress(value);
}

export function parsePositiveAmount(value: string, decimals: number): bigint {
  if (!value.trim()) throw new Error("数量を入力してください。");
  const parsed = parseUnits(value, decimals);
  if (parsed <= 0n) throw new Error("数量は0より大きくしてください。");
  return parsed;
}

export function minimumReceived(quote: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5_000) {
    throw new Error("スリッページは0〜50%で指定してください。");
  }
  return (quote * BigInt(10_000 - slippageBps)) / 10_000n;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/ROUTE_SLIPPAGE_OUT_OF_RANGE/i.test(message)) return "交換スリッページは0〜5%で指定してください。";
  if (/WALLET_ACCOUNT_CHANGED|ROUTE_ACCOUNT_CHAIN_MISMATCH/i.test(message)) return "ウォレットのアカウントが見積り後に変わりました。新しいQuoteを取得してください。";
  if (/WALLET_NETWORK_CHANGED/i.test(message)) return "ウォレットのネットワークが見積り後に変わりました。正しいチェーンでQuoteを更新してください。";
  if (/LOCAL_AMM_POOL_PAIR_CHANGED/i.test(message)) return "Poolのトークン構成が検証時と一致しません。Pool設定を再確認してください。";
  if (/EVM_VENUE_FACTORY_CODE_MISMATCH/i.test(message)) return "Factoryの実行bytecodeが、RealDEX v1に固定されたLocalSwapFactoryと一致しないため停止しました。";
  if (/EVM_VENUE_FACTORY_REQUIRED|EVM_VENUE_NO_VERIFIED_ROUTE/i.test(message)) return "検証可能なRealDEX v1 Factoryを設定し、Poolを再確認してください。";
  if (/EVM_VENUE_POOL_FACTORY_MISMATCH|EVM_VENUE_POOL_PAIR_MISMATCH|EVM_VENUE_POOL_NOT_VERIFIED/i.test(message)) return "Poolの作成元またはトークンペアを検証できないため、Quoteと取引を停止しました。";
  if (/EVM_VENUE_FACTORY_INVALID|EVM_VENUE_LIMIT_EXCEEDED/i.test(message)) return "Venue factory設定が不正または上限超過です。EVMアドレスを最大32件まで指定してください。";
  if (/EVM_VENUE_POOL_NOT_FOUND/i.test(message)) return "このFactoryには選択したトークンペアのPoolがありません。";
  if (/EXECUTION_GUARD_PERSISTENCE_UNAVAILABLE/i.test(message)) return "再送防止記録をブラウザへ保存・再確認できないため、送信前に停止しました。サイトデータの保存設定を確認してください。";
  if (/EXECUTION_GUARD_CROSS_TAB_LOCK_UNAVAILABLE/i.test(message)) return "複数タブ間の再送防止ロックを取得できないため、ウォレット接続前に停止しました。Web Locks対応ブラウザの1つのタブだけで開いてください。";
  if (/DUPLICATE_ROUTE_EXECUTION/i.test(message)) return "同じQuoteの取引が送信済みまたは状態不明です。再送せずトランザクション状態を確認してください。";
  if (/rejected|denied|ACTION_REJECTED/i.test(message)) return "ウォレットで操作が拒否されました。資産は移動していません。";
  if (/insufficient funds/i.test(message)) return "ネットワーク手数料を支払う残高が不足しています。";
  if (/SlippageExceeded|slippage/i.test(message)) return "価格が許容範囲を超えて変わりました。見積りを更新してください。";
  if (/Expired|deadline/i.test(message)) return "見積りの有効期限が切れました。もう一度確認してください。";
  if (/network|chain/i.test(message)) return "接続中のチェーンが設定と一致しません。";
  if (/LP残高/.test(message)) return "指定したLP shareがウォレット残高を超えています。";
  if (/Poolの供給量/.test(message)) return "Pool情報を再取得してからやり直してください。";
  return "処理を完了できませんでした。詳細を確認して、状態を確認してから再試行してください。";
}
