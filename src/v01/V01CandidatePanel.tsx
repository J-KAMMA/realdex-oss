import type { ActiveV01Operation } from "./active-operation";
import type { V01CandidateObservation } from "./candidate-reconciliation";

type Props = {
  operation: ActiveV01Operation;
  role: "approval" | "swap";
  hash: string;
  busy: boolean;
  fresh: boolean;
  observation?: V01CandidateObservation;
  onRole: (role: "approval" | "swap") => void;
  onHash: (hash: string) => void;
  onVerify: () => void;
  onAdopt: () => void;
};

/** Observations never authorize history adoption, operation close or another send. */
export default function V01CandidatePanel(props: Props) {
  const { operation, role, hash, busy, fresh, observation } = props;
  const attempts = operation.schema !== "realdex.v01-active-operation.v1" ? operation.attempts : [];
  const attempt = attempts.find(item => item.role === role);
  return <section className="v01-card v01-candidate" aria-labelledby="candidate-title">
    <h2 id="candidate-title">5. 保存済み送信要求とハッシュを照合</h2>
    <p className="v01-help">ウォレットの活動記録などで確認した取引ハッシュを入力します。公開RPC 2か所への読み取りだけを行い、ウォレット接続・署名・再送は行いません。</p>
    <p className="v01-warning">照合だけでは履歴を変更しません。元の交換内容が保存されている場合は、照合後に「再照合して履歴に保存」を選べます。保存後も操作ロックは残ります。取引を再送しないでください。</p>
    {!attempts.length ? <p>照合に必要な送信前の記録がありません。記録を推測で補わず、操作を停止したままにします。</p> : <>
      <label>照合する要求<select value={role} disabled={busy} onChange={event => props.onRole(event.target.value as "approval" | "swap")}>
        {attempts.map(item => <option key={item.role} value={item.role}>{item.role === "approval" ? "トークン承認" : "交換"}</option>)}
      </select></label>
      {attempt && <details><summary>保存した要求の送信元・宛先・nonce</summary><dl><dt>送信元</dt><dd>{attempt.transaction.from}</dd><dt>宛先</dt><dd>{attempt.transaction.to}</dd><dt>Nonce</dt><dd>{BigInt(attempt.transaction.nonce).toString()}</dd></dl></details>}
      <label>取引ハッシュ（tx hash）<input value={hash} onChange={event => props.onHash(event.target.value)} disabled={busy} maxLength={66} autoComplete="off" spellCheck={false} placeholder="0x…（64桁の16進数）" aria-describedby="candidate-help" /></label>
      <p id="candidate-help" className="v01-help">照合だけでは入力を保存しません。履歴への保存は別の操作です。{!fresh && "先に固定対象を再検証してください。"}</p>
      <button disabled={busy || !fresh || !attempt || !/^0x[0-9a-f]{64}$/i.test(hash.trim())} onClick={props.onVerify}>取引ハッシュを照合（読み取りのみ）</button>
    </>}
    {observation && <div className="v01-review v01-candidate-result">
      <h3>照合結果：保存した要求と一致</h3>
      <dl><dt>要求</dt><dd>{observation.role === "approval" ? "トークン承認" : "交換"}</dd><dt>取引ハッシュ</dt><dd>{observation.hash}</dd>
        <dt>Receiptの実行結果</dt><dd>{observation.receiptStatus === 1 ? "成功（status 1）" : "失敗・revert（status 0）"}</dd>
        <dt>観測時の確認数</dt><dd>{observation.confirmations}</dd><dt>観測日時</dt><dd>{new Date(observation.checkedAt).toLocaleString()}</dd>
        <dt>取り込みブロック</dt><dd>{observation.blockNumber}</dd><dt>ブロックハッシュ</dt><dd>{observation.blockHash}</dd>
        <dt>照合したRPCホスト</dt><dd>{observation.readerIds.join(" / ")}</dd></dl>
      <p>これは表示時点での再照会ではなく、観測日時の結果です。RPC間の一致は運営者の独立性や最終確定を保証しません。履歴と未解決操作は変更していません。</p>
      {operation.schema === "realdex.v01-active-operation.v3" ? <>
        <p>このハッシュと既存の履歴を再照合し、2確認以上なら元の交換内容とともにこのブラウザの履歴へ保存します。承認が必要だった交換は、先に承認ハッシュを保存してください。ウォレット接続・署名・再送は行いません。保存後の操作終了は履歴欄で別途確認します。</p>
        <button disabled={busy || !fresh || observation.confirmations < 2} onClick={props.onAdopt}>再照合して履歴に保存</button>
        {observation.confirmations < 2 && <p>2確認に達していません。時間をおいて、もう一度ハッシュを照合してください。</p>}
      </> : <p>この旧形式の記録には元の交換内容が不足しているため、履歴へ採用できません。推測で補完せず停止を維持します。</p>}
    </div>}
  </section>;
}
