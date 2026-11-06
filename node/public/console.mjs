import { runOptimizerDemo } from '/node/optimizer/demo-data.mjs';
const byId = id => document.getElementById(id);
const text = (tag, value, className) => { const element = document.createElement(tag); element.textContent = value; if (className) element.className = className; return element; };
let inFlight = false;
async function refresh() {
  if (inFlight) return; inFlight = true; byId('refresh').disabled = true;
  try {
    const response = await fetch('/v1/status', { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('unavailable'); const data = await response.json();
    if (data.schema !== 'realdex.node.status.v1' || data.walletSigning !== false || data.custody !== false) throw new Error('invalid');
    byId('connection').textContent = data.fatal ? '停止条件を検出: ' + data.fatal : '稼働中 · 資金署名なし · 取引送信なし';
    byId('public-key').textContent = data.publicKey;
    byId('mode').textContent = data.dexServed ? '既存のDEXビルドを同じPCから配信中。ノード候補は実行画面へ自動登録されません。' : 'ノードコンソールのみ配信中。既存のDEX画面は別途ビルドが必要です。';
    const peers = byId('peers'); peers.replaceChildren();
    for (const peer of data.peers) {
      const box = text('article', '', 'card'); box.append(text('code', peer.publicKey));
      box.append(text('p', peer.state === 'reachable' ? `応答署名を確認 · 受理 ${peer.accepted} / 除外 ${peer.rejected}` : '未接続、応答なし、または検証拒否'));
      if (peer.code) box.append(text('small', peer.code)); peers.append(box);
    }
    if (!data.peers.length) peers.append(text('p', '相手はまだ指定されていません。config.json の peers にURLと公開鍵を追加してください。', 'empty'));
    const factories = byId('factories'); factories.replaceChildren();
    for (const factory of data.candidates) {
      const box = text('article', '', 'card'); box.append(text('span', '未検証 · 実行不可', 'tag'), text('p', factory.chainId), text('code', factory.address));
      box.append(text('small', '情報源: ' + factory.sources.length + '（独立性や正しさの証明ではありません）')); factories.append(box);
    }
    if (!data.candidates.length) factories.append(text('p', '期限内の候補はありません。空の表示を「流動性が存在しない」という意味にはしません。', 'empty'));
  } catch {
    byId('connection').textContent = '状態を確認できません。以前の候補を現在の情報として扱わないでください。';
    byId('peers').replaceChildren(); byId('factories').replaceChildren();
  } finally { inFlight = false; byId('refresh').disabled = false; }
}
byId('refresh').addEventListener('click', refresh);
byId('demo').addEventListener('click', () => {
  const { ranking, split } = runOptimizerDemo(); const output = byId('demo-result'); output.replaceChildren();
  output.append(text('p', '入力: 100,000 最小単位 / 分割刻み: 1,000 / 独立した架空プール2つ'));
  for (const quote of ranking.ranked) output.append(text('p', `${quote.routeId}: 最低出力 ${quote.minimumOut} − 追加費用 ${quote.additionalCostOut} = ${quote.score}`));
  if (split.plan) {
    output.append(text('strong', '分割案の実質受取額: ' + split.plan.score + ' 最小単位'));
    for (const allocation of split.plan.allocations) output.append(text('p', `${allocation.routeId} に ${allocation.amountIn} を配分`));
  }
  output.append(text('p', 'この候補集合・準備高・費用・刻みに限る厳密最適解です。世界全体の最適性、将来の約定価格、送信可能性は保証しません。', 'muted'));
});
refresh(); setInterval(refresh, 10000);
