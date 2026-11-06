import { formatUnits } from "ethers";
import type { EvmSwapRecoveryRecord } from "../swap/evm-swap-recovery";
import { isV01HistorySettled, type V01HistoryExport } from "./history-retention";

export default function V01HistoryRetention(props: {
  record: EvmSwapRecoveryRecord; totalRecords: number; busy: boolean; fresh: boolean; hasActive: boolean;
  archive?: V01HistoryExport; savedCopyConfirmed: boolean;
  onExport: () => void; onConfirm: (value: boolean) => void; onRemove: () => void;
}) {
  const { record, totalRecords, busy, fresh, hasActive, archive, savedCopyConfirmed } = props;
  const settled = isV01HistorySettled(record);
  return <div className="v01-retention">
    <h3>履歴の控えと整理</h3>
    <p>このブラウザのEVM履歴は{totalRecords} / 16件です。他の経路の履歴も上限に含まれます。上限に達しても自動削除せず、新しい交換を停止します。</p>
    <p>選択中の1件：{formatUnits(record.source.amountBaseUnits, record.source.decimals)} {record.source.symbol} → {record.destination.symbol} / {new Date(record.createdAt).toLocaleString()}</p>
    <p>履歴ID：{record.recoveryId}</p>
    <p className="v01-help">控えには選択した履歴のアドレス・数量・取引ハッシュ等が含まれます。公開せず、自分で安全に保管してください。端末の保存記録であり、署名付き証明や現在の最終確定の証明ではありません。</p>
    <button disabled={busy} onClick={props.onExport}>選択した履歴の控えをダウンロード</button>
    {archive && <>
      <p>保存要求したファイル：{archive.filename}</p>
      <p className="v01-help">ダウンロード開始だけでは保存完了を確認できません。ファイルを開き、上の履歴IDと内容が一致することを確認してください。確認操作は5分間有効です。</p>
      <label className="v01-copy-check"><input type="checkbox" checked={savedCopyConfirmed} disabled={busy} onChange={event => props.onConfirm(event.target.checked)} /><span>控えファイルを保存して開き、選択した履歴の内容を確認しました</span></label>
    </>}
    <p className="v01-warning">削除するのは、このブラウザの選択した1件だけです。チェーン上の取引や承認権限は取り消されません。アプリへの控え再取込・削除の取り消しは未対応です。</p>
    {hasActive ? <p>未解決または確認待ちの操作があるため、履歴を削除できません。先に操作の照会と終了が必要です。</p> : !settled ? <p>この履歴は整理対象ではありません。未確定・不明・置換確認中の履歴や旧形式は削除せず残します。</p> : !fresh ? <p>削除前に固定対象を再検証してください。</p> : null}
    <button className="v01-remove" disabled={busy || hasActive || !settled || !fresh || !archive || !savedCopyConfirmed} onClick={props.onRemove}>控えを確認した1件をブラウザ履歴から削除</button>
  </div>;
}
