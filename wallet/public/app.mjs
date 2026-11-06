let protectedSettingsDraft = null;
import {createIbcPanel} from './ibc.mjs';
/** The UI capability remains in memory. Never persist it, or send it to a dapp. */
const $ = id => document.getElementById(id);
let capability = new URLSearchParams(location.hash.slice(1)).get('key');
history.replaceState(null, '', location.pathname);
let smartDraft=null,smartFields=[],smartRevision=0,smartRenderKey="";
let state = null, refreshing = false, busy = false, generation = 0;
let agentDraft = null, agentSecretTimer = null, networkDraft = null;
let dexCatalogue = null, dexRevision = 0, dexFieldSpec = [];
let authzRevision=0;
let nonEvmBalanceRevision=0,splRevision=0,bitcoinRevision=0,accountOnlineRevision=0,cosmosRevision=0;
const newPaymentKey=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
const errorText = {
  INJECTIVE_DEPOSIT_INSUFFICIENT: '入金に使う銀行側の利用可能残高が不足しています。',
  INJECTIVE_DEPOSIT_INSUFFICIENT_WITH_GAS: 'INJの入金額とガス代の合計が銀行側の利用可能残高を超えています。',
  INJECTIVE_DEPOSIT_NONDEFAULT_REQUIRED: '自分の非default交換口座を指定してください。',
  INJECTIVE_DEPOSIT_SELF_ONLY: '入金先は自分の交換口座だけです。',
  BACKUP_VERIFICATION_REQUIRED: '保存した最新バックアップを再読込し、口座の一致を検証してください。',
  VAULT_LOCKED: '保管庫がロックされています。',
  VAULT_AUTHENTICATION_FAILED: 'パスワードが違うか、バックアップが破損しています。',
  LOCAL_SIGNER_NETWORK_UNSUPPORTED: 'この版の内蔵署名は、手数料の計算に対応したネットワークだけを受け付けます。',
  NETWORK_NOT_CONFIGURED: '先に2〜4個のRPCと初期ブロックハッシュを設定してください。',
  RPC_DISAGREEMENT: 'RPCの応答が一致しないため停止しました。',
  NONCE_ALREADY_RESERVED: '同じnonceの署名が履歴にあります。新しく署名せず、履歴を確認してください。',
  CP_SETTINGS_REVIEW_REQUIRED: '保護付き設定パネルで変更内容を確認して保存してください。',
  CP_SETTINGS_BUSY: '別の操作が進行中です。完了またはロック後に設定を確認し直してください。',
  CP_SETTINGS_UNRESOLVED_TRANSACTION: '未確定の取引があるため設定を変更できません。履歴を照合してください。',
  CP_SETTINGS_REVIEW_EXPIRED_OR_CHANGED: '設定の確認期限または保存世代が変わりました。もう一度確認してください。',
  CP_SETTINGS_CONFIRMATION: 'review SHA-256を省略せず入力してください。',
  UI_AUTH_REQUIRED: '端末に表示された起動リンクを開き直してください。',
  AGENT_CONFIRMATION_REQUIRED: '権限確認の文が一致しません。表示された文をそのまま入力してください。',
  AGENT_DRAFT_EXPIRED_OR_CHANGED: '権限の確認期限が切れました。もう一度、内容確認から進めてください。',
  TOKEN_DECIMALS_CHANGED: '登録された資産の桁数とRPCの報告が一致しないため停止しました。',
  INSUFFICIENT_TOKEN_BALANCE: '選択したトークンの残高が不足しています。',
  AGENT_REACTIVATION_REQUIRED: 'AIの権限は停止しています。内容を確認して再有効化してください。',
  TRANSACTION_CONFIRMATION_MISMATCH: '受取先の再入力が一致しません。',
  UNLOCK_RATE_LIMITED: 'ロック解除が一時的に制限されています。',
  ACCOUNT_UNACCOUNTED_ACTIVITY: 'この保管庫の複製が記録していない署名が、この口座にあります。バックアップを戻した、複製が2つ動いている、別の道具で署名した、のどれかです。どれかはここでは分かりません。何だったかを確かめてから、受け入れる範囲を名指しして進めてください。',
  ACCOUNT_CONTINUITY_CHAIN_BEHIND_RECORD: '口座が、この複製が既に署名した位置より後ろにいます。口座のsequenceは戻らないので、別の口座か別の網か、応答したRPCが古い状態を返しています。受け入れて進める話ではありません。',
  ACCOUNT_GAP_ACKNOWLEDGEMENT_REQUIRED: '差を受け入れる文が一致しません。表示された文をそのまま入力してください。',
  ACCOUNT_GAP_ACKNOWLEDGEMENT_DOES_NOT_MATCH: '受け入れる範囲が、実際に観測された差と違います。表示された範囲をそのまま指定してください。',
  ACCOUNT_GAP_ACKNOWLEDGEMENT_INVALID: '差の受け入れは、範囲と受け入れる文を持つ組で指定してください。',
  COSMOS_UNACCOUNTED_ACTIVITY: 'この保管庫の複製が記録していない署名が、この口座にあります。バックアップを戻した、複製が2つ動いている、別の道具で署名した、のどれかです。どれかはここでは分かりません。何だったかを確かめてから、受け入れる範囲を名指しして進めてください。',
  COSMOS_CONTINUITY_CHAIN_BEHIND_RECORD: '口座が、この複製が既に署名した位置より後ろにいます。口座のsequenceは戻らないので、別の口座か別の網か、応答したRPCが古い状態を返しています。受け入れて進める話ではありません。',
  COSMOS_GAP_ACKNOWLEDGEMENT_REQUIRED: '差を受け入れる文が一致しません。表示された文をそのまま入力してください。',
  COSMOS_GAP_ACKNOWLEDGEMENT_DOES_NOT_MATCH: '受け入れる範囲が、実際に観測された差と違います。表示された範囲をそのまま指定してください。',
  COSMOS_GAP_ACKNOWLEDGEMENT_INVALID: '差の受け入れは、範囲と受け入れる文を持つ組で指定してください。',
};
function message(s, bad = false) { $('message').textContent = s; $('message').classList.toggle('error', bad); }
function node(tag, text, cls) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; }
function button(label, handler, cls = 'subtle') { const b = node('button', label, cls); b.type = 'button'; b.addEventListener('click', () => run(handler)); return b; }
function displayAtomic(value, decimals) { const s = String(value).padStart(decimals + 1, '0'); if (!decimals) return s; return s.slice(0, -decimals) + '.' + (s.slice(-decimals).replace(/0+$/, '') || '0'); }
function row(k, v) { const n = node('div', undefined, 'detail-row'); n.append(node('span', k), node('strong', v ?? '—')); return n; }
async function api(route, body = {}) {
  if (!capability || !/^[0-9a-f]{64}$/.test(capability)) throw Error('UI_AUTH_REQUIRED');
  const epoch = generation;
  const response = await fetch('/api/' + route, {method: 'POST', credentials: 'omit', redirect: 'error',
    headers: {'content-type': 'application/json', authorization: 'Bearer ' + capability}, body: JSON.stringify(body), signal: AbortSignal.timeout(30000)});
  const value = await response.json();
  if (epoch !== generation) throw Error('UI_OPERATION_CANCELLED');
  if (!response.ok || value.error) throw Error(value.error || 'HTTP_ERROR');
  return value;
}
async function run(fn) {
  if (busy) return;
  busy = true;
  try { await fn(); await refresh(); }
  catch (e) { const code = /^[A-Z0-9_]+$/.test(e.message) ? e.message : 'OPERATION_FAILED'; message((errorText[code] || '操作を完了できませんでした。') + ' [' + code + ']', true); }
  finally { busy = false; }
}
function form(id, fn) { $(id).addEventListener('submit', e => { e.preventDefault(); void run(fn); }); }
function clearSecrets() { for (const n of document.querySelectorAll('input[type=password]')) n.value = ''; clearAgentCredential(); }
function lines(id) { return $(id).value.split(/\r?\n/).map(s => s.trim()).filter(Boolean); }
function selectItems(id, items) {
  const select = $(id), selected = select.value, signature = JSON.stringify(items);
  if (select.dataset.options === signature) return;
  select.replaceChildren(...items.map(([value, label]) => { const o = node('option', label); o.value = value; return o; }));
  if (items.some(([v]) => v === selected)) select.value = selected;
  select.dataset.options = signature;
}
function refreshAssets() {
  const network = state?.networks.find(n => n.chainId === $('sendNetwork').value);
  selectItems('sendAsset', [['native', network?.symbol || 'ネイティブ通貨'], ...(network?.tokens || []).map(t => [t.address, t.symbol])]);
}
function accountChoices(local = true) { return (state?.accounts || []).filter(a => a.family === 'evm' && (!local || a.kind === 'local')).map(a => [a.id, a.label + ' · ' + a.address]); }
function renderPending() {
  const host = $('pending'), active = new Set(state.pending.map(r => r.id));
  for (const child of [...host.children]) if (!active.has(child.dataset.request)) child.remove();
  if (!active.size) { host.replaceChildren(node('p', '現在、承認待ちの操作はありません。', 'empty')); return; }
  for (const r of state.pending) {
    if(r.kind==='ibc-transfer')continue;
    if ([...host.children].some(n => n.dataset.request === r.id)) continue;
    if (r.kind.startsWith('smart-')) { host.append(renderSmartApproval(r)); continue; }
    if (r.kind.startsWith('non-evm-')) { host.append(renderNonEvmApproval(r)); continue; }
    const card = node('article', undefined, 'request-card'); card.dataset.request = r.id;
    card.append(node('h3', r.kind === 'connect' ? 'アプリへの口座公開を確認' : r.kind === 'switch' ? '接続チェーンの変更' : '取引への署名を確認'), row('要求元', r.origin));
    if (r.agentRequestId) { const p = (state.agents || []).find(p => r.origin === 'agent:' + p.id); card.append(row('依頼したAI', p?.label || r.origin), node('p', '限定権限からの送金依頼です。この画面で承認すると送信します。', 'small')); }
    const confirm = node('input'); confirm.autocomplete = 'off'; confirm.spellcheck = false;
    let account, network, broadcast;
    if (r.kind === 'connect') {
      card.append(node('p', '接続だけでは署名できません。要求元のoriginをすべて再入力してください。'));
      confirm.placeholder = r.origin;
      account = node('select'); for (const [v, label] of accountChoices()) { const o = node('option', label); o.value = v; account.append(o); }
      network = state.networks.find(n => n.chainId === r.chainId);
      card.append(row('ネットワーク', network?.name || r.chainId), account);
    } else if (r.kind === 'switch') {
      card.append(row('変更先チェーンID', r.chainId), node('p', '変更先のチェーンIDを10進数で再入力してください。'));
      confirm.placeholder = r.chainId;
    } else {
      const s = r.summary;
      card.append(row('承認期限', new Date(r.expiresAt).toLocaleString()));
      if (s.deadline) card.append(row('コントラクト期限', new Date(Number(s.deadline) * 1000).toLocaleString()));
      card.append(row('ネットワーク', s.network + ' / ' + s.chainId), row('操作', s.operation), row('送信元', s.from), row('呼出先', s.to), row('受取先', s.recipient), row('資産', s.asset), row('数量（最小単位）', s.amountAtomic), row('実行ガス代上限（wei）', s.executionFeeCapWei), row('nonce', s.nonce));
      if (s.minimumOutputAtomic !== null) card.append(row('最低受取量（最小単位）', s.minimumOutputAtomic));
      if (s.details) for (const [label, value] of Object.entries(s.details)) card.append(row(label, String(value)));
      for (const a of s.assetMoves || []) { card.append(row('数量（ローカル桁数設定）', displayAtomic(a.amountAtomic, a.decimals) + ' ' + a.symbol)); if (a.address) card.append(row('資産コントラクト', a.address)); }
      if (s.outputToken) card.append(row('出力資産コントラクト', s.outputToken));
      card.append(node('p', 'RPC照合と手動の契約許可リストによる確認です。独立したチェーン証明・トークン監査ではありません。', 'small'), node('p', '受取先を省略せず再入力してください。'));
      confirm.placeholder = s.recipient;
      if (r.origin === location.origin) { const label = node('label', undefined, 'check'); broadcast = node('input'); broadcast.type = 'checkbox'; label.append(broadcast, node('span', '署名後に送信する（設定で送信が許可されている場合のみ）')); card.append(label); }
      else card.append(node('p', '承認すると、この取引を署名して送信します。結果不明時も自動再送しません。', 'small'));
    }
    card.append(confirm);
    const actions = node('div', undefined, 'actions');
    actions.append(button('この内容だけ承認', async () => {
      if (!confirm.value) throw Error('CONFIRMATION_REQUIRED');
      const payload = {id: r.id, confirm: confirm.value};
      if (r.kind === 'connect') Object.assign(payload, {accountId: account.value, chainId: r.chainId});
      if (r.kind === 'transaction') Object.assign(payload, {intentId: r.intentId, broadcast: Boolean(broadcast?.checked)});
      const result = await api('approve', payload); message(result.broadcastState ? '処理状態: ' + result.broadcastState : '接続の権限を更新しました。');
      if (r.kind === 'transaction') await showJournal();
    }, ''), button('拒否', async () => { await api('reject', {id: r.id}); message('要求を拒否しました。'); }));
    card.append(actions); host.append(card);
  }
}
function render() {
  const protection = state?.protectedStorage, banner = $('protectedStorage');
  if (banner) {
    banner.hidden = !protection;
    banner.textContent = !protection ? '' : protection.failed
      ? '保護ストレージの照合に失敗しました。操作は停止しています。' + protection.error
      : 'チェックポイント＋カーネル排他：世代 ' + protection.generation
        + (protection.bodyMissing ? '。Vault本体がありません。最新チェックポイントと完全一致する暗号文だけ復元できます。' : '。同時に両方を巻き戻す改変やOS侵害は検出できません。')
        + ' 旧INJ-13形式とは互換性がありません。';
  }
  const protectedConfig = state?.protectedSettings;
  $('protectedSettingsPanel').hidden = !protectedConfig || state.locked;
  if (protectedConfig) {
    $('protectedSettingsState').textContent = protectedConfig.loaded
      ? '暗号化保存の設定改訂 ' + protectedConfig.revision + '。保存後は再解除と最新バックアップが必要です。'
      : '設定は解除後に暗号文から読み込みます。';
    for (const id of ['networkForm','networkFile','originsForm']) $(id).hidden = true;
  }
  if (state.locked) {
    protectedSettingsDraft = null;
    $('protectedSettingsReview').hidden = true;
    $('protectedSettingsJson').value = ''; $('protectedSettingsDetails').textContent = '';
    $('protectedSettingsConfirm').value = '';
  }
  ibcPanel.render(state);
  const locked = state.locked;
  renderNonEvm(state);
  renderSmart(state);
  $('access').hidden = !locked; $('workspace').hidden = locked; $('lock').disabled = locked;
  $('existsLabel').textContent = state.exists ? '作成済み' : '未作成';
  $('create').hidden = state.exists; $('unlock').hidden = !state.exists; $('confirmLabel').hidden = state.exists;
  $('vaultState').textContent = locked ? '保管庫はロック中' : '保管庫をローカルで解除中';
  $('vaultDetail').textContent = locked ? '共有ノードは鍵にアクセスできません。' : '5分間の操作休止で自動ロックします。';
  if (locked) { networkDraft=null;$('networkReview').hidden=true;$('networkReviewConfirm').value='';resetDex(); $('accounts').replaceChildren(); $('pending').replaceChildren(); $('sessions').replaceChildren(); $('journal').replaceChildren(); $('agentList').replaceChildren(); $('agentList').dataset.signature=''; $('agentRequests').replaceChildren(); $('agentReview').hidden=true; $('receiveResult').textContent=''; agentDraft=null; clearAgentCredential(); return; }
  $('accountCount').textContent = String(state.accounts.length); $('pendingCount').textContent = String(state.pending.length);
  $('backupState').textContent = state.backupRequired ? '検証が必要' : '口座一致を確認済み';
  const seconds = Math.max(0, Math.ceil((state.expiresAt - Date.now()) / 1000)); $('lockCountdown').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  $('accounts').replaceChildren(...state.accounts.map(a => {
    const card = node('article', undefined, 'account');
    card.append(node('div', a.family.toUpperCase(), 'family'), node('strong', a.label), node('code', a.address), node('span', a.kind === 'watch' ? '閲覧専用' : a.family === 'evm' ? 'テストネット署名' : a.family === 'solana' ? 'ローカルSOL・SPL送金' : a.family === 'icp' ? 'ICRCオフライン署名' : '限定オフライン署名・送信なし', 'small'));
    return card;
  }));
  if (!state.accounts.length) $('accounts').append(node('p', '口座を作成・取込してください。', 'empty'));
  selectItems('sendAccount', accountChoices()); selectItems('sendNetwork', state.networks.map(n => [n.chainId, n.name])); refreshAssets(); renderPending(); renderAgents(); renderDexChooser();
  $('sessions').replaceChildren(...state.sessions.map(s => { const item = node('div', undefined, 'request-card'); item.append(node('strong', s.origin), row('チェーンID', s.chainId), button('この接続を解除', async () => { await api('sessions/revoke', {id: s.id}); message('接続を解除しました。'); })); return item; }));
  if (!state.sessions.length) $('sessions').append(node('p', '接続中のアプリはありません。', 'empty'));
  if (document.activeElement !== $('origins')) $('origins').value = state.allowedAppOrigins.join('\n');
}
const ibcPanel=createIbcPanel({api,run,message,getGeneration:()=>generation});
async function refresh() {
  if (refreshing || !capability) return;
  refreshing = true;
  try { const previousLocked = state?.locked; state = await api('status'); render(); if (previousLocked === false && state.locked) { clearSecrets(); message('保管庫をロックしました。'); } }
  finally { refreshing = false; }
}
async function readFile(id) { const file = $(id).files?.[0]; if (!file || file.size > 1048576) throw Error('FILE_REQUIRED_OR_TOO_LARGE'); return file.text(); }
function download(name, data) { const href = URL.createObjectURL(new Blob([data], {type: 'application/json'})), a = node('a'); a.href = href; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(href), 1000); }
function atomic(s, decimals) {
  if (!/^(0|[1-9][0-9]{0,60})(\.[0-9]+)?$/.test(s)) throw Error('AMOUNT_FORMAT_INVALID');
  const [whole, fraction = ''] = s.split('.'); if (fraction.length > decimals) throw Error('AMOUNT_PRECISION_EXCEEDED');
  const amount = BigInt(whole + fraction.padEnd(decimals, '0')); if (amount <= 0n || amount >= 2n ** 256n) throw Error('AMOUNT_RANGE'); return amount;
}
async function showJournal() {
  const {records} = await api('journal');
  $('journal').replaceChildren(...records.slice().reverse().map(r => {
    const box = node('article', undefined, 'request-card'); box.append(node('h3', r.state), node('code', r.signed.transactionHash), row('チェーンID', r.summary.chainId), row('送信元', r.summary.from), row('実行ガス代上限（wei）', r.summary.executionFeeCapWei), row('受取先', r.summary.recipient), row('数量（最小単位）', r.summary.amountAtomic));
    box.append(button('RPCで状況を再照合', async () => { try { const result = await api('reconcile', {id: r.id}); message(result.observation || result.state); } finally { await showJournal(); } }));
    if (r.report?.schema === 'realdex.settlement-observation.v1') {
      box.append(row('今回の観測', r.report.observation), row('観測日時（保存値）', Number.isFinite(r.report.observedAt) ? new Date(r.report.observedAt).toLocaleString('ja-JP') : '不明'), row('確認数（RPC報告）', r.report.confirmations), row('確認条件を満たしたか', r.report.policySatisfied ? 'はい（RPCの観測）' : '未確認'), row('受取の観測', r.report.deliveryObserved ? 'あり（独立証明ではない）' : 'なし／不明'));
      box.append(node('p', 'これは保存された時点の観測です。最新状況は再照合してください。確認条件を満たしても、独立した最終性の証明ではありません。', 'small'));
      if (r.report.reorgObserved) box.append(node('p', '以前と異なるブロックを観測しました。再編・移動の可能性があります。自動再送しません。', 'small'));
    }
    if (!r.state.startsWith('reported-') && (!r.summary.smart || r.state === 'signed')) {
      const label = node('label', r.summary.smart ? '初回送信する取引ハッシュ全体を入力' : '再送する場合は取引ハッシュ全体を入力'); const input = node('input'); input.autocomplete = 'off'; label.append(input); box.append(label);
      box.append(button('同じ署名済み取引だけを送信', async () => { const result = await api('rebroadcast', {id: r.id, confirm: input.value}); message('状態: ' + result.state); await showJournal(); }));
    } else {
      if (r.report?.matchingTransferEventObserved !== undefined && r.report.matchingTransferEventObserved !== null) box.append(row('一致するTransferイベント', String(r.report.matchingTransferEventObserved)), row('観測したイベント数量（最小単位）', r.report.observedEventAmountAtomic));
      box.append(node('p', 'RPCが報告した結果です。実残高変化・再編耐性・最終性の独立検証ではありません。', 'small'));
    }
    return box;
  }));
  if (!records.length) $('journal').append(node('p', '署名履歴はまだありません。', 'empty'));
}
form('accessForm', async () => { try { await api('unlock', {password: $('password').value}); message('保管庫を解除しました。'); } finally { clearSecrets(); } });
$('create').addEventListener('click', () => run(async () => { try { if ($('password').value !== $('passwordAgain').value) throw Error('PASSWORD_CONFIRMATION_MISMATCH'); await api('create', {password: $('password').value}); message('保管庫を作成しました。口座追加後、バックアップを保存してください。'); } finally { clearSecrets(); } }));
async function lockNow() { generation++; clearSecrets(); if (state) { state = {...state, locked: true, accounts: [], pending: [], sessions: []}; render(); } try { await api('lock'); message('ロックしました。送信中だった取引は、解除後に履歴を確認してください。'); } catch { message('画面をロックしました。サービス側の状態を確認してください。', true); } }
$('lock').addEventListener('click', () => { void lockNow(); });
form('restoreForm', async () => { try { await api('restore', {encrypted: await readFile('restoreFile'), password: $('restorePassword').value}); message('復元しました。パスワードで解除し、バックアップを再検証してください。'); } finally { clearSecrets(); } });
$('accountKind').addEventListener('change', () => { $('secretLabel').hidden = $('accountKind').value !== 'import'; $('watchLabel').hidden = $('accountKind').value !== 'watch'; $('accountSecret').value = ''; });
form('accountForm', async () => {
  const input = {family: $('accountFamily').value, label: $('accountLabel').value};
  if ($('accountKind').value === 'import') input.secretHex = $('accountSecret').value;
  if ($('accountKind').value === 'watch') input.watchAddress = $('watchAddress').value;
  try { await api('accounts/add', input); message('口座を追加しました。新しいバックアップの保存・再読込が必要です。'); } finally { $('accountSecret').value = ''; }
});
$('sendNetwork').addEventListener('change', refreshAssets);
form('sendForm', async () => {
  const account = state.accounts.find(a => a.id === $('sendAccount').value), network = state.networks.find(n => n.chainId === $('sendNetwork').value);
  if (!account || !network) throw Error('NETWORK_NOT_CONFIGURED');
  await api('transfers/prepare', {accountId: account.id, chainId: network.chainId, transfer: {asset: $('sendAsset').value, recipient: $('recipient').value, amount: $('amount').value}}); message('照合が完了しました。承認待ち欄で取引内容を確認してください。');
});
$('balance').addEventListener('click', () => run(async () => { const b = await api('transfers/balance', {accountId: $('sendAccount').value, chainId: $('sendNetwork').value, asset: $('sendAsset').value}); $('balanceResult').textContent = b.amount + ' ' + b.symbol + ' / ' + b.atomic + ' 最小単位 · ガス用残高 ' + b.nativeAmount + ' · RPC照合値'; }));
$('backup').addEventListener('click', () => run(async () => { const b = await api('backup'); download('RealDEX-wallet-backup-' + Date.now() + '.json', b.encrypted); message('暗号化バックアップを保存しました。このファイルを再読込してください。'); }));
form('verifyForm', async () => { try { const verified = await api('backup/verify', {encrypted: await readFile('verifyFile'), password: $('verifyPassword').value}); if (verified.protectedStorage) { download('RealDEX-protected-current-' + Date.now() + '.json', verified.encrypted); message('保護記録と一致する最新バックアップを保存しました。取引・設定の保存後は再取得してください。'); } else message('バックアップ内の全口座が現在の口座と一致しました。'); } finally { clearSecrets(); } });
form('passwordForm', async () => { try { if ($('newPassword').value !== $('newPasswordAgain').value) throw Error('PASSWORD_CONFIRMATION_MISMATCH'); await api('password', {oldPassword: $('oldPassword').value, newPassword: $('newPassword').value}); message('パスワードを変更しました。解除後、新しいバックアップを保存してください。旧バックアップは旧パスワードで復元可能です。'); } finally { clearSecrets(); } });
form('originsForm', async () => { await api('origins/set', {origins: lines('origins')}); message('ローカル接続先を更新し、既存セッションを解除しました。'); });
$('history').addEventListener('click', () => run(showJournal));
form('networkForm', async () => {
  await api('networks/add', {network: {chainId: $('networkChain').value, name: $('networkName').value, symbol: $('networkSymbol').value, rpcUrls: lines('networkRpc'), genesisHash: $('networkGenesis').value, broadcastEnabled: $('networkBroadcast').checked, contracts: [], maxFeeWei: $('networkFee').value, maxSlippageBps: 100}});
  message('テストネットを追加しました。2個のURLが独立した運営者であることは、このアプリだけでは証明できません。');
});
$('networkFile').addEventListener('change', () => run(async () => {
  networkDraft=null;$('networkReview').hidden=true;$('networkReviewConfirm').value='';
  const network=JSON.parse(await readFile('networkFile'));
  if(state.networks.some(n=>n.chainId===String(network.chainId))){
    networkDraft=await api('networks/review',{network});
    $('networkReviewDetails').textContent=JSON.stringify(networkDraft,null,2);
    $('networkReviewConfirm').placeholder=networkDraft.confirmation;$('networkReview').hidden=false;
    message('差分と新旧設定を確認してください。まだ適用・署名していません。');
  }else{await api('networks/add',{network});message('契約許可リストを含むテスト設定を追加しました。');}
  $('networkFile').value='';
}));
$('networkCancel').addEventListener('click',()=>{networkDraft=null;$('networkReview').hidden=true;$('networkReviewConfirm').value='';});
$('networkApply').addEventListener('click',()=>run(async()=>{
  if(!networkDraft||Date.now()>=networkDraft.expiresAt)throw Error('NETWORK_REVIEW_EXPIRED_OR_CHANGED');
  try{await api('networks/replace',{id:networkDraft.id,digest:networkDraft.digest,confirmation:$('networkReviewConfirm').value});
    clearSecrets();message('設定を置換し、保管庫とAI権限をロックしました。再解除後に新しい設定を確認してください。');
  }finally{await refresh();}
}));
function clearAgentCredential() {
  clearTimeout(agentSecretTimer); $('agentToken').value = ''; $('agentCredential').hidden = true;
}
function showAgentCredential(value) {
  clearAgentCredential(); $('agentToken').value = value; $('agentCredential').hidden = false;
  agentSecretTimer = setTimeout(clearAgentCredential, 60000);
}
function refreshAgentAssets() {
  const network = state?.networks.find(n => n.chainId === $('agentNetwork').value);
  selectItems('agentAsset', [['native', network?.symbol || 'ネイティブ通貨'], ...(network?.tokens || []).map(t => [t.address, t.symbol])]);
}
function agentPolicyDetails(p) {
  const box = node('div'), l = p.limits, u = p.usage;
  box.append(row('対象口座', state.accounts.find(a => a.id === p.accountId)?.address || p.accountId), row('チェーンID', p.chainId), row('資産', p.symbol + ' / ' + p.asset), row('実行方式', p.mode === 'auto' ? '範囲内は自動送金' : '毎回、本人が承認'), row('受取先', p.recipients.join(' / ')), row('有効期限', new Date(p.expiresAt).toLocaleString()));
  box.append(row('1回の上限', displayAtomic(l.perTransferAtomic, p.decimals) + ' ' + p.symbol), row('直近24時間の上限', displayAtomic(l.rolling24hAtomic, p.decimals) + ' ' + p.symbol), row('累計上限', displayAtomic(l.lifetimeAtomic, p.decimals) + ' ' + p.symbol));
  box.append(row('1回のガス代上限（wei）', l.perTxFeeWei), row('24時間／累計ガス上限（wei）', l.rolling24hFeeWei + ' / ' + l.lifetimeFeeWei), row('回数上限／最短間隔', l.maxTransfers + ' 回 / ' + l.minIntervalMs / 1000 + ' 秒'));
  if (u) box.append(row('予約・署名済み累計', displayAtomic(u.lifetimeAtomic, p.decimals) + ' ' + p.symbol), row('予約・署名済みガス上限合計（wei）', u.lifetimeFeeWei), row('予約・署名済み回数', String(u.count)));
  return box;
}
function renderAgents() {
  selectItems('agentAccount', accountChoices()); selectItems('agentNetwork', state.networks.map(n => [n.chainId, n.name])); refreshAgentAssets();
  const policies = state.agents || [], signature = JSON.stringify(policies);
  if ($('agentList').dataset.signature === signature) return;
  $('agentList').dataset.signature = signature;
  $('agentList').replaceChildren(...policies.map(p => {
    const card = node('article', undefined, 'request-card');
    card.append(node('h3', p.label), row('状態', p.status === 'revoked' ? '取消済み' : p.activated ? '有効・ロックまで' : '停止中・再有効化が必要'), row('累計使用／上限', displayAtomic(p.usage.lifetimeAtomic, p.decimals) + ' / ' + displayAtomic(p.limits.lifetimeAtomic, p.decimals) + ' ' + p.symbol));
    const details = node('details'); details.append(node('summary', '権限と使用量を確認'), agentPolicyDetails(p)); card.append(details);
    if (p.status !== 'revoked') {
      const phrase = p.mode === 'auto' ? 'ALLOW BOUNDED AUTOMATION' : 'REQUIRE MY APPROVAL';
      if (!p.activated) {
        const label = node('label', '再有効化する場合は ' + phrase + ' と入力'); const input = node('input'); input.autocomplete = 'off'; label.append(input); card.append(label);
        card.append(button('確認して再有効化', async () => { const result = await api('agents/activate', {id: p.id, confirmation: input.value}); showAgentCredential(result.token); message('新しいAI接続トークンを発行しました。累計使用量は維持しています。'); }));
      }
      card.append(button('このAIの権限を取り消す', async () => { clearAgentCredential(); await api('agents/revoke', {id: p.id}); message('権限を取り消しました。送信開始済みの取引は取り消せません。'); }, 'danger'));
    }
    return card;
  }));
  if (!policies.length) $('agentList').append(node('p', 'AIへの許可はありません。必要な条件を確認してから作成してください。', 'empty'));
}
async function showAgentHistory() {
  const {requests} = await api('agents/history');
  $('agentRequests').replaceChildren(...requests.slice().reverse().map(r => {
    const card = node('article', undefined, 'request-card');
    card.append(node('h3', r.broadcastState || r.state), row('依頼キー', r.idempotencyKey), row('受取先', r.recipient), row('数量（最小単位）', r.amountAtomic), row('ガス予約上限（wei）', r.feeReservedWei));
    if (r.note) card.append(row('AIのメモ（未検証の説明）', r.note));
    if (r.transactionHash) card.append(row('取引ハッシュ', r.transactionHash));
    if (r.receiptObservation) card.append(row('RPCの取引結果', r.receiptObservation.transactionReportedSuccessful ? '成功を報告' : '失敗を報告'), row('一致するTransferイベント', String(r.receiptObservation.matchingTransferEventObserved)), node('p', '実残高変化・最終確定は未検証です。署名済み予算は返却しません。', 'small'));
    if (r.error) card.append(row('停止理由', r.error));
    if (['reserved', 'awaiting-approval'].includes(r.state)) card.append(button('未署名の依頼だけ取り消す', async () => { await api('agents/cancel', {requestId: r.requestId}); await showAgentHistory(); }));
    return card;
  }));
  if (!requests.length) $('agentRequests').append(node('p', 'AIの送金依頼はありません。', 'empty'));
}
form('agentForm', async () => {
  const network = state.networks.find(n => n.chainId === $('agentNetwork').value);
  if (!network) throw Error('NETWORK_NOT_CONFIGURED');
  const asset = $('agentAsset').value, decimals = asset === 'native' ? 18 : network.tokens.find(t => t.address === asset)?.decimals;
  const minutes = Number($('agentMinutes').value), count = Number($('agentCount').value), interval = Number($('agentInterval').value);
  if (![minutes, count, interval].every(Number.isSafeInteger) || minutes < 1 || minutes > 10080 || interval < 0 || interval > 86400) throw Error('AGENT_LIMIT_INVALID');
  const policy = {label: $('agentLabel').value, accountId: $('agentAccount').value, chainId: network.chainId, asset, recipients: lines('agentRecipients'), mode: $('agentMode').value, expiresAt: Date.now() + minutes * 60000,
    limits: {perTransferAtomic: String(atomic($('agentPerTransfer').value, decimals)), rolling24hAtomic: String(atomic($('agentRolling').value, decimals)), lifetimeAtomic: String(atomic($('agentLifetime').value, decimals)), perTxFeeWei: String(atomic($('agentFee').value, 18)), rolling24hFeeWei: String(atomic($('agentRollingFee').value, 18)), lifetimeFeeWei: String(atomic($('agentLifetimeFee').value, 18)), maxTransfers: count, minIntervalMs: interval * 1000}};
  agentDraft = await api('agents/prepare', {policy});
  $('agentDraftDetails').replaceChildren(agentPolicyDetails(agentDraft.policy));
  $('agentPhraseHelp').textContent = '内容を確認し、' + agentDraft.confirmation + ' と入力してください。確認は60秒以内です。';
  $('agentConfirmation').value = ''; $('agentReview').hidden = false;
  message('まだAIに権限は渡していません。最終確認欄で承認してください。');
});
form('agentConfirmForm', async () => {
  if (!agentDraft) throw Error('AGENT_DRAFT_EXPIRED_OR_CHANGED');
  const result = await api('agents/create', {draftId: agentDraft.draftId, digest: agentDraft.digest, confirmation: $('agentConfirmation').value});
  agentDraft = null; $('agentReview').hidden = true; $('agentConfirmation').value = ''; showAgentCredential(result.token);
  message('限定したAI権限を作成しました。接続トークンは秘密鍵でも、ウォレット解除用の鍵でもありません。');
});
$('agentNetwork').addEventListener('change', refreshAgentAssets);
$('agentHistory').addEventListener('click', () => run(showAgentHistory));
$('hideAgentToken').addEventListener('click', clearAgentCredential);
$('copyAgentToken').addEventListener('click', () => run(async () => { if (!$('agentToken').value) throw Error('AGENT_TOKEN_NOT_DISPLAYED'); await navigator.clipboard.writeText($('agentToken').value); message('AI接続トークンをコピーしました。環境変数に設定し、プロンプトや公開ログには貼らないでください。'); }));
$('newAgentAccount').addEventListener('click', () => run(async () => { const a = await api('accounts/add', {family: 'evm', label: 'AI専用テスト口座'}); await refresh(); $('agentAccount').value = a.id; message('独立したEVM口座を作成しました。権限作成前に最新バックアップを保存・検証してください。'); }));
$('agentStop').addEventListener('click', () => {
  // This emergency control intentionally bypasses the ordinary UI busy gate.
  generation++; clearAgentCredential(); agentDraft = null; $('agentReview').hidden = true;
  void api('agents/stop').then(() => { message('すべてのAIを停止しました。すでに送信を開始した取引は取消できません。'); return refresh(); }).catch(() => message('停止結果を確認できません。ロックし、再解除後に履歴を確認してください。', true));
});
$('receive').addEventListener('click', () => run(async () => {
  const r = await api('transfers/receive', {accountId: $('sendAccount').value, chainId: $('sendNetwork').value, asset: $('sendAsset').value, ...($('amount').value ? {amount: $('amount').value} : {})});
  $('receiveResult').textContent = '受取先: ' + r.recipient + '\nチェーンID: ' + r.chainId + '\n' + r.uri;
  message('受取リクエストを作成しました。チェーンID・資産・数量を相手と確認してください。');
}));
form('paymentUriForm', async () => {
  const r = await api('transfers/parse-uri', {chainId: $('sendNetwork').value, uri: $('paymentUri').value});
  $('recipient').value = r.recipient; $('sendAsset').value = r.asset; $('amount').value = r.amount;
  message('受取リクエストを入力欄へ反映しました。まだ署名・送信していません。');
});
for (const id of ['sendAccount', 'sendNetwork', 'sendAsset']) $(id).addEventListener('change', () => { $('receiveResult').textContent = ''; $('balanceResult').textContent = '選択した資産の残高を再確認してください。'; });

// The DEX form is owner-only. It never invokes the approval route on its own.
function clearDexQuotes() { dexRevision++; $('dexQuotes').replaceChildren(); }
function resetDex() { dexCatalogue=null;clearDexQuotes();$('dexFields').replaceChildren();$('dexPairInfo').textContent='';$('dexPrepare').disabled=true;$('dexQuote').disabled=true;$('dexCatalogStatus').textContent='ネットワークを選び、契約を読み込んでください。'; }
function renderDexChooser() { selectItems('dexAccount',accountChoices());selectItems('dexNetwork',state.networks.map(n=>[n.chainId,n.name]));if(dexCatalogue&&dexCatalogue.chainId!==$('dexNetwork').value)resetDex(); }
function dexTokenLabel(a) {const t=dexCatalogue?.tokens.find(t=>t.address===a);return t?t.symbol+' / '+a:a;}
function dexPool() {return dexCatalogue?.pools.find(p=>p.address===$('dex_pool')?.value);}
function updateDexPair() {
  if($('dexAction').value==='route-swap'){
    const pools=($('dex_pools')?.value||'').split(/[,\s]+/).filter(Boolean),tokens=[$('dex_tokenIn')?.value];
    let valid=pools.length>=1&&pools.length<=4&&new Set(pools).size===pools.length;
    for(const a of pools){const p=dexCatalogue?.pools.find(p=>p.address===a.toLowerCase()),last=tokens.at(-1);if(!p||![p.token0,p.token1].includes(last)){valid=false;break;}const next=last===p.token0?p.token1:p.token0;if(tokens.includes(next)){valid=false;break;}tokens.push(next);}
    $('dexPairInfo').textContent=valid?'指定経路: '+tokens.map(dexTokenLabel).join(' → '):'プールアドレスを通過順にカンマ区切りで入力してください（1〜4個・循環不可）。サーバー側でも全区間を照合します。';return;
  }
  const pool=dexPool();if(!pool){$('dexPairInfo').textContent='';return;}
  const choices=[pool.token0,pool.token1].map(a=>[a,dexTokenLabel(a)]);
  if($('dex_tokenIn'))selectItems('dex_tokenIn',choices);
  const input=$('dex_tokenIn')?.value,output=input===pool.token0?pool.token1:pool.token0;
  $('dexPairInfo').textContent='token0: '+dexTokenLabel(pool.token0)+' / token1: '+dexTokenLabel(pool.token1)+($('dexAction').value==='swap'?' / 出力: '+dexTokenLabel(output):'');
}
function renderDexFields() {
  clearDexQuotes();if(!dexCatalogue){$('dexFields').replaceChildren();return;}
  const tokens=dexCatalogue.tokens.map(t=>[t.address,dexTokenLabel(t.address)]),pools=dexCatalogue.pools.map(p=>[p.address,dexTokenLabel(p.token0)+' → '+dexTokenLabel(p.token1)+' / '+p.address]);
  const field=(name,label,type='text',value='',options=null)=>({name,label,type,value,options});
  const pool=field('pool','プール','select','',pools),recipient=field('recipient','受取先','text',state.accounts.find(a=>a.id===$('dexAccount').value)?.address||''),ttl=field('ttlSeconds','コントラクト期限（30〜600秒）','number','180');
  const action=$('dexAction').value;
  if(action==='swap')dexFieldSpec=[pool,field('tokenIn','入力トークン','select','',tokens),field('amount','入力数量'),field('minimumOutput','最低受取数量'),recipient,ttl];
  else if(action==='route-swap')dexFieldSpec=[field('router','Router','select','',dexCatalogue.spenders.filter(c=>c.kind==='router').map(c=>[c.address,c.address])),field('pools','通過順のプールアドレス（カンマ区切り・最大4）'),field('tokenIn','入力トークン','select','',tokens),field('amount','入力数量'),field('minimumOutput','最終トークンの最低受取数量'),recipient,ttl];
  else if(action==='approve'||action==='revoke')dexFieldSpec=[field('token','対象トークン','select','',tokens),field('spender','承認先','select','',dexCatalogue.spenders.map(c=>[c.address,c.kind+' / '+c.address])),...(action==='approve'?[field('amount','承認する数量（有限額）')]:[])];
  else if(action==='create-pool')dexFieldSpec=[field('factory','Factory','select','',dexCatalogue.factories.map(c=>[c.address,c.address])),field('tokenA','トークンA','select','',tokens),field('tokenB','トークンB','select','',tokens),field('feeBps','手数料（1〜100 bps）','number','30')];
  else if(action==='add-liquidity')dexFieldSpec=[pool,field('amount0','token0 の最大数量'),field('amount1','token1 の最大数量'),field('minimumShares','最低LP数量（LPは18桁）'),recipient,ttl];
  else dexFieldSpec=[pool,field('shares','引き出すLP数量（LPは18桁）'),field('minimum0','token0 の最低受取数量'),field('minimum1','token1 の最低受取数量'),recipient,ttl];
  $('dexFields').replaceChildren(...dexFieldSpec.map(f=>{const label=node('label',f.label),control=node(f.type==='select'?'select':'input');control.id='dex_'+f.name;control.required=true;control.autocomplete='off';if(f.type==='select'){for(const [value,text]of f.options){const option=node('option',text);option.value=value;control.append(option);}}else{control.type=f.type;control.value=f.value;control.maxLength=f.name==='pools'?256:116;if(f.type==='text')control.inputMode=['recipient','pools'].includes(f.name)?'text':'decimal';}label.append(control);return label;}));
  $('dexPrepare').disabled=dexFieldSpec.some(f=>f.type==='select'&&!f.options.length);$('dexQuote').hidden=!['swap','route-swap'].includes(action);$('dexQuote').textContent=action==='route-swap'?'指定した経路を見積もる':'同じペアの登録プールを比較';$('dexQuote').disabled=$('dexPrepare').disabled;
  if(action==='create-pool'&&tokens.length>1)$('dex_tokenB').value=tokens[1][0];
  updateDexPair();
}
function dexInput() {const operation={action:$('dexAction').value};for(const f of dexFieldSpec)operation[f.name]=f.name==='pools'?$('dex_'+f.name).value.trim().split(/[,\s]+/).filter(Boolean):f.type==='number'?Number($('dex_'+f.name).value):$('dex_'+f.name).value;return operation;}
$('dexNetwork').addEventListener('change',resetDex);
$('dexAccount').addEventListener('change',renderDexFields);
$('dexAction').addEventListener('change',renderDexFields);
$('dexFields').addEventListener('input',clearDexQuotes);
$('dexFields').addEventListener('change',()=>{clearDexQuotes();updateDexPair();});
$('dexLoad').addEventListener('click',()=>run(async()=>{
  const chainId=$('dexNetwork').value,revision=dexRevision;
  const catalogue=await api('dex/catalog',{chainId});if(chainId!==$('dexNetwork').value||revision!==dexRevision)throw Error('DEX_FORM_CHANGED');
  dexCatalogue=catalogue;renderDexFields();$('dexCatalogStatus').textContent=`登録済み: ${catalogue.tokens.length} トークン / ${catalogue.pools.length} プール / ${catalogue.factories.length} Factory。読み込みだけでは安全性を証明しません。`;
}));
form('dexForm',async()=>{
  if(!dexCatalogue||dexCatalogue.chainId!==$('dexNetwork').value)throw Error('DEX_CATALOG_REQUIRED');
  const result=await api('dex/prepare',{accountId:$('dexAccount').value,chainId:$('dexNetwork').value,operation:dexInput()});
  message('内容を照合しました。承認待ちで受取先・数量・最低受取量を確認してください。まだ署名していません。');
  $('pending').scrollIntoView({behavior:'smooth',block:'start'});void result;
});
$('dexQuote').addEventListener('click',()=>run(async()=>{
  if(!dexCatalogue||!['swap','route-swap'].includes($('dexAction').value))throw Error('DEX_CATALOG_REQUIRED');
  if($('dexAction').value==='route-swap'){
    const input=dexInput(),revision=dexRevision,chainId=$('dexNetwork').value;
    const quote={router:input.router,pools:input.pools,tokenIn:input.tokenIn,amount:input.amount,slippageBps:Math.min(50,dexCatalogue.maxSlippageBps)};
    const result=await api('dex/quote-route',{chainId,quote});
    if(revision!==dexRevision||chainId!==$('dexNetwork').value)throw Error('DEX_FORM_CHANGED');
    const box=$('dexQuotes'),card=node('article',undefined,'request-card');let acceptedRevision=dexRevision;
    card.append(node('p','指定経路のみ・ガス代控除前 / 有効期限 '+new Date(result.expiresAt).toLocaleString(),'small'),row('経路',result.tokenPath.map(dexTokenLabel).join(' → ')),row('表示受取額',result.output+' '+result.outputSymbol),row('最低受取量',result.minimumOutput+' '+result.outputSymbol));
    for(const hop of result.hops)card.append(row('通過プール',hop.pool+' / '+hop.feeBps+' bps'));
    card.append(button('この見積りを入力欄へ',async()=>{
      if(Date.now()>=result.expiresAt||acceptedRevision!==dexRevision||chainId!==$('dexNetwork').value)throw Error('DEX_QUOTE_EXPIRED_OR_CHANGED');
      $('dex_minimumOutput').value=result.minimumOutput;acceptedRevision=++dexRevision;
      message('最終トークンの最低受取量を反映しました。承認・署名・送信はまだ行っていません。');
    }));box.replaceChildren(card);return;
  }
  const input=dexInput(),pool=dexPool();if(!pool)throw Error('DEX_POOL_REQUIRED');
  const quote={tokenIn:input.tokenIn,tokenOut:input.tokenIn===pool.token0?pool.token1:pool.token0,amount:input.amount,slippageBps:Math.min(50,dexCatalogue.maxSlippageBps)};
  const revision=dexRevision,chainId=$('dexNetwork').value,result=await api('dex/quote',{chainId,quote});
  if(revision!==dexRevision||chainId!==$('dexNetwork').value)throw Error('DEX_FORM_CHANGED');
  const box=$('dexQuotes');box.replaceChildren(node('p','追加費用を引く前の見積り / 有効期限 '+new Date(result.expiresAt).toLocaleString()+' / 許容差 '+quote.slippageBps+' bps','small'));
  let acceptedRevision=dexRevision;
  for(const c of result.candidates){const card=node('article',undefined,'request-card');card.append(node('code',c.pool),row('表示受取額',c.output+' '+result.outputSymbol),row('最低受取量',c.minimumOutput+' '+result.outputSymbol),row('プール手数料',c.feeBps+' bps'));
    card.append(button('この見積りを入力欄へ',async()=>{
      if(Date.now()>=result.expiresAt||acceptedRevision!==dexRevision||chainId!==$('dexNetwork').value)throw Error('DEX_QUOTE_EXPIRED_OR_CHANGED');
      $('dex_pool').value=c.pool;updateDexPair();$('dex_tokenIn').value=quote.tokenIn;updateDexPair();$('dex_minimumOutput').value=c.minimumOutput;
      acceptedRevision=++dexRevision;message('見積りを反映しました。追加費用を含む最適経路とは限りません。まだ承認依頼・署名・送信していません。');
    }));box.append(card);}
  if(!result.candidates.length)box.append(node('p','一致する見積りを得られませんでした。','small'));
  for(const c of result.excluded)box.append(node('p','除外: '+c.pool+' / '+c.error,'small'));
  if(!result.comparisonComplete)box.append(node('p','照合できなかった候補があります。比較は未完了です。','small'));
}));

document.addEventListener('keydown', e => { if (e.key === 'Escape') void lockNow(); });
window.addEventListener('pagehide', () => { generation++; clearSecrets(); if (capability) void fetch('/api/lock', {method: 'POST', credentials: 'omit', keepalive: true, headers: {'content-type': 'application/json', authorization: 'Bearer ' + capability}, body: '{}'}).catch(() => {}); capability = null; });
if (capability) { void run(async () => { await refresh(); message('ローカル署名サービスに接続しました。実資産は使用しないでください。'); }); }
setInterval(() => { if (!busy && capability) refresh().catch(() => message('ローカルサービスとの接続を確認してください。', true)); }, 2000);

// Non-EVM owner panel. Uses the existing in-memory owner capability, never a dapp/agent session.
function renderNonEvm(current) {
  if (!$('nonEvmPanel')) return;
  if (current.locked) { authzRevision++;if($('authzResult'))$('authzResult').textContent='';cosmosRevision++;if($('cosmosOnlineResult'))$('cosmosOnlineResult').textContent=''; if($('accountOnlineResult'))$('accountOnlineResult').textContent='';accountOnlineRevision++;$('solanaResult').textContent='';$('splAccountsResult').textContent='';splRevision++;bitcoinRevision++;if($('bitcoinScanResult')){$('bitcoinScanResult').textContent='';$('bitcoinUtxos').value='';}$('nonEvmJournal').replaceChildren();return; }
  refreshAccountOnline(current);refreshCosmosOnline(current);refreshAuthz(current);
  selectItems('solanaAccount',current.accounts.filter(a=>a.family==='solana'&&a.kind==='local').map(a=>[a.id,a.label+' · '+a.address]));
  selectItems('icpAccount',current.accounts.filter(a=>a.family==='icp'&&a.kind==='local').map(a=>[a.id,a.label+' · '+a.address]));
  selectItems('solanaNetwork',(current.solanaNetworks||[]).map(n=>[n.id,n.name]));
  if (!$('solanaRequestKey').value) $('solanaRequestKey').value=newPaymentKey();
  if (!$('icpRequestKey').value) $('icpRequestKey').value=newPaymentKey();
  selectItems('splAccount',current.accounts.filter(a=>a.family==='solana'&&a.kind==='local').map(a=>[a.id,a.label+' · '+a.address]));
  selectItems('splNetwork',(current.solanaNetworks||[]).map(n=>[n.id,n.name]));refreshSplMint();refreshOfflineAccounts();
  if(!$('splRequestKey').value)$('splRequestKey').value=newPaymentKey();
  selectItems('bitcoinAccount',current.accounts.filter(a=>a.family==='bitcoin'&&a.kind==='local').map(a=>[a.id,a.label+' · '+a.address]));selectItems('bitcoinNetwork',(current.bitcoinNetworks||[]).map(n=>[n.id,n.name]));if(!$('bitcoinRequestKey').value)$('bitcoinRequestKey').value=newPaymentKey();if($('injectiveOwnerAccount'))selectItems('injectiveOwnerAccount',current.accounts.filter(a=>a.family==='evm'&&a.kind==='local').map(a=>[a.id,a.label+' · '+a.address]));if($('injectiveActionAccount'))selectItems('injectiveActionAccount',current.accounts.filter(a=>a.family==='evm'&&a.kind==='local').map(a=>[a.id,a.label+' · '+a.address]));if($('injectiveActionKey')&&!$('injectiveActionKey').value)$('injectiveActionKey').value=newPaymentKey();
}
function nonEvmFeeText(s){
  if(s.family==='injective')return s.feeAtomic+' INJ atoms（署名前に固定したgas上限費用）';
  if(s.family==='cosmos'&&s.operation.endsWith('-online'))return displayAtomic(s.feeAtomic,s.feeDecimals)+' '+s.feeAsset+' ('+s.feeAtomic+' 最小単位)';
  if(s.family==='bitcoin')return displayAtomic(s.feeAtomic,8)+' BTC-regtest ('+s.feeAtomic+' satoshi)';
  if(s.family==='solana')return displayAtomic(s.feeAtomic,9)+' SOL ('+s.feeAtomic+' lamports)';
  if(s.family==='stellar')return displayAtomic(s.feeAtomic,7)+' XLM ('+s.feeAtomic+' stroops)';
  if(s.family==='aptos')return displayAtomic(s.feeAtomic,8)+' APT ('+s.feeAtomic+' octas)';
  return s.feeAtomic+' '+(s.feeAsset||'台帳単位')+'（最小単位）';
}
function renderNonEvmApproval(r) {
  const s=r.summary,card=node('article',undefined,'request-card'),isSolana=['non-evm-solana','non-evm-spl'].includes(r.kind);card.dataset.request=r.id;
  const isBitcoin=r.kind==='non-evm-bitcoin-online',isAccountOnline=r.kind==='non-evm-account-online',isCosmosOnline=r.kind==='non-evm-cosmos-online',isAuthz=r.kind==='non-evm-cosmos-authz',isInjective=r.kind==='non-evm-injective-local',canSubmit=isSolana||isBitcoin||isAccountOnline||isCosmosOnline||isAuthz;
  const titles={'non-evm-injective-local':'Injective · '+(s.action==='cancel'?'注文取消':s.action==='withdraw'?'自分の銀行残高へ出金':s.action==='deposit'?'自分の交換口座へ入金':'ローカル注文')+'署名の確認','non-evm-cosmos-authz':'Cosmos · 代理権限の確認','non-evm-cosmos-online':'Cosmos · ローカル送金の確認','non-evm-account-online':s.family.toUpperCase()+' · ローカル送金の確認','non-evm-bitcoin-online':'Bitcoin regtest · UTXO照合済み送金','non-evm-solana':'SOL送金','non-evm-spl':'SPL TransferChecked','non-evm-icp':'ICPオフライン署名','non-evm-bitcoin':'Bitcoin regtestオフライン署名','non-evm-cosmos':'Cosmos SDKオフライン署名','non-evm-stellar':'Stellar standaloneオフライン署名','non-evm-aptos':'Aptos localオフライン署名'};
  card.append(node('h3',titles[r.kind]||'未対応の操作'),row('ネットワーク',s.networkId),row('送信元',s.networkFrom||s.from),row('受取先',s.recipient),row('資産',s.asset),row('数量（最小単位）',s.amountAtomic),row(s.feeIsMaximum?'最大手数料':'手数料',nonEvmFeeText(s)),row('支払いキー',s.requestKey),row('承認期限',new Date(r.expiresAt).toLocaleString()));
  if(isSolana){
    card.append(row('表示数量',displayAtomic(s.amountAtomic,s.decimals??9)),row('genesis',s.genesisHash),row('recent blockhash',s.recentBlockhash),row('有効な最終ブロック高',s.lastValidBlockHeight));
    if(r.kind==='non-evm-spl')card.append(row('ミント',s.mint),row('ミントの桁数',s.decimals),row('送信元トークン口座',s.source),row('受取トークン口座',s.destination));
  }else if(r.kind==='non-evm-icp')card.append(row('Ledger',s.ledger),row('受取subaccount',s.subaccount),row('作成時刻ns',s.transfer.createdAtTimeNs),row('memo',s.transfer.memoHex));
  else if(isInjective){const details=node('details'),pre=node('pre',JSON.stringify(s.review,null,2));details.open=true;details.append(node('summary','署名前に照合した注文・口座・費用・simulation'),pre);if(s.action)card.append(row('操作',s.action==='cancel'?'未約定残の取消':s.action==='deposit'?'自分の交換口座への入金':'自分の銀行残高への出金'),row('subaccount ID',s.subaccountId),...(s.action==='cancel'?[row('対象注文ハッシュ',s.orderHash),row('元の注文記録',s.sourceRecordId)]:[row(s.action==='deposit'?'固定した入金先':'固定した出金先',s.destination)]));card.append(...(s.action&&s.action!=='cancel'?[]:[row('注文方向',s.side),row('指値',s.limitPrice),row('client order ID',s.clientOrderId)]),row('preflight SHA-256',s.reviewSha256),row('tx timeout height',s.timeoutHeight),details,node('p','この承認では署名済みTxRawを暗号化保存するだけです。送信は履歴画面の別操作で、保存済みtx hashの全文確認後に一度だけ行います。','notice'));}
  else {const details=node('details'),pre=node('pre',JSON.stringify(s.transfer,null,2));details.open=true;details.append(node('summary','署名に固定される全条件'),pre);card.append(details);}
  if(isBitcoin)card.append(row('UTXO照合ブロック',s.checkedHeight+' / '+s.checkedBlock),row('初期ハッシュ',s.genesisHash),row('固定checkpoint',s.checkpoint.height+' / '+s.checkpoint.hash),node('p','RPCの観測と署名の整合を検査しました。PoW・分散合意・最終確定の独立証明ではありません。','small'));
  if(isCosmosOnline)card.append(row('表示数量',displayAtomic(s.amountAtomic,s.decimals)+' '+s.assetSymbol),row('固定checkpoint',s.checkpoint.height+' / '+s.checkpoint.hash),row('設定fingerprint',s.networkFingerprint),node('p','受付は決済完了ではありません。独立した合意・状態証明は未実装です。結果不明時に別のsequenceや期限で署名し直しません。','small'));
  if(isAccountOnline)card.append(row('固定checkpoint',s.checkpoint.height+' / '+s.checkpoint.hash),row('設定fingerprint',s.networkFingerprint),node('p','独立した決済証明ではありません。結果不明時は予約を維持し、自動で別のsequence・期限に置き換えません。','small'));
  if(isInjective)card.append(node('p','ローカルInjective単一ノードの照合結果であり、公開合意・state proof・決済確定ではありません。署名後も自動送信しません。','small'));
  else if(!canSubmit)card.append(node('p','オフライン署名のみ。ネットワーク状態・残高・手数料の正しさは認証していません。使用済みUTXO・sequenceの予約は、この保管庫に記録されている範囲です。','small'));
  if(isAuthz)card.append(row('操作',s.action),row('資金の所有者',s.granter),row('代理人',s.grantee),row('手数料の支払人',s.feePayer),row('許可数量（最小単位）',s.limitAtomic??'変更なし'),node('p','オンチェーン許可はPCをロックしても残ります。日次・1回制限はありません。取消しは取引の収録後に有効になります。','notice'),row('確認文',s.confirmationText));
  const label=node('label',isInjective?'preflight SHA-256を全文再入力':isAuthz?'表示された確認文を全文再入力':'受取先を全文再入力'),confirm=node('input');confirm.autocomplete='off';confirm.spellcheck=false;label.append(confirm);card.append(label);
  const broadcast=node('input');broadcast.type='checkbox';broadcast.disabled=s.submissionEnabled===false;
  if(canSubmit){const l=node('label',undefined,'check');l.append(broadcast,node('span','署名・保存後にローカルRPCへ送信する'));card.append(l);}
  // The gap this copy cannot account for, shown before it is accepted rather than after
  // a refusal. The range comes from the read-only continuity question, so what the owner
  // affirms is what the signing path will check, and the sentence is typed rather than
  // clicked — a button would make it the checkbox it was written not to be.
  const gapSentence=node('input');gapSentence.autocomplete='off';gapSentence.spellcheck=false;
  let gap=null;
  if(isAccountOnline)card.append(button('この口座の記録との差を確認',async()=>{
    const seen=await api('non-evm/account-online/continuity',{accountId:r.intent.accountId,networkId:r.intent.networkId});
    if(seen.status==='accounted-for'||seen.status==='nothing-recorded'){gap=null;gapSentence.remove();message('この複製の記録で、この口座の進みは説明が付きます。'+(seen.notice?' '+seen.notice:''));return;}
    if(seen.status==='impossible-rewind'){gap=null;gapSentence.remove();message(errorText.ACCOUNT_CONTINUITY_CHAIN_BEHIND_RECORD,true);return;}
    gap=seen.acknowledgeGap;
    const detail=node('div');
    detail.append(node('p',errorText.ACCOUNT_UNACCOUNTED_ACTIVITY,'small'),
      row('この複製が最後に署名したsequence',seen.sequenceFloor),row('口座の現在のsequence',seen.accountSequence),
      row('説明の付かない件数',seen.unaccountedFor),row('この複製の記録件数',String(seen.signedSequences)),
      node('p','受け入れる場合は、次の文をそのまま入力してください。押すだけでは進みません。','small'),
      node('pre',gap.acknowledgement),node('label','差を受け入れる文を全文入力'));
    // The backup rules belong here, in front of the person looking at a gap, not only in
    // a document they would have to already know to go and read.
    if(Array.isArray(seen.policy?.rules)){const rules=node('details'),list=node('ul');for(const rule of seen.policy.rules)list.append(node('li',rule,'small'));rules.append(node('summary','複製とバックアップの決まり'),list);detail.append(rules);}
    detail.lastChild.append(gapSentence);
    card.append(detail);
    message('説明の付かない署名が '+seen.unaccountedFor+' 件あります。何だったかを確かめてから進めてください。',true);
  },''));
  card.append(button('この非EVM操作だけ承認',async()=>{const acknowledgeGap=gap&&gapSentence.value?{...gap,acknowledgement:gapSentence.value}:undefined;const result=await api('non-evm/approve',{id:r.id,intentId:r.intentId,confirmation:confirm.value,broadcast:canSubmit&&broadcast.checked,...(acknowledgeGap?{acknowledgeGap}:{})});message('非EVM記録: '+result.record.state+'（受取完了とは別）');await showNonEvmJournal();},''),button('非EVM要求を拒否',async()=>{await api('reject',{id:r.id});message('要求を拒否しました。');}));return card;
}
function refreshSplMint(){const n=state?.solanaNetworks?.find(n=>n.id===$('splNetwork').value);selectItems('splMint',(n?.splTokens||[]).map(t=>[t.mint,t.symbol+' · '+t.mint+' · '+t.decimals+'桁']));}
function refreshOfflineAccounts(){const family=$('offlineFamily').value;selectItems('offlineAccount',(state?.accounts||[]).filter(a=>a.family===family&&a.kind==='local').map(a=>[a.id,a.label+' · '+a.address]));$('offlineFamilyHint').textContent={bitcoin:'自分のP2WPKH入力のみ。相手への出力と同じ口座へのお釣りのみ。UTXOは手動指定です。',cosmos:'標準SDKのsecp256k1 / SIGN_MODE_DIRECT / MsgSendのみ。Ethermint・IBC送信は未対応。',stellar:'既存の通常口座へのXLM支払いのみ。Standalone passphrase固定。',aptos:'鍵ローテーションのないEd25519初期口座・chain ID 4・0x1::aptos_account::transferのみ。'}[family];}
async function showNonEvmJournal(){
  const {records}=await api('non-evm/history');
  $('nonEvmJournal').replaceChildren(...records.slice().reverse().map(r=>{
    const card=node('article',undefined,'request-card');card.append(node('h3',r.family.toUpperCase()+' · '+r.state),row('支払いキー',r.requestKey),row('受取先',r.summary.recipient),row('数量（最小単位）',r.summary.amountAtomic),row('署名／request ID',r.signed.signature||r.signed.requestId));
    if(r.report)card.append(row('観測理由',r.report.reason),row('観測日時',new Date(r.report.observedAt).toLocaleString()),row('受取の観測',r.report.received?'RPCが報告（独立証明ではない）':'未確認'));
    if(r.family==='injective'){
      if(r.summary.action)card.append(row('操作',r.summary.action==='cancel'?'注文取消':r.summary.action==='deposit'?'自分の交換口座への入金':'自分への出金'),row('subaccount',r.summary.subaccountId));if(r.report?.actionEffect){const e=r.report.actionEffect;card.append(row('収録後の別照合',e.status==='unavailable'?'取得できず。入金や取消の独立証明はありません。':e.kind==='cancel'?(e.orderPresent?'対象注文はまだ観測されています':'対象注文は観測されません。因果関係や最終確定の独立証明ではありません。'):'銀行残高 '+e.bankBalanceAtomic+' / available残高 '+e.availableAtomic+'（同じノードの観測。入出金との因果関係を独立証明しません）'));}card.append(...(r.summary.action&&r.summary.action!=='cancel'?[]:[row('market',r.summary.marketId),row('client order ID',r.summary.clientOrderId)]),row('preflight SHA-256',r.summary.reviewSha256),row('取引ID',r.signed.requestId));
      const submissionExpired=r.state==='retired-submission-expired';
      const canInspectSubmission=['broadcast','broadcast-unknown'].includes(r.state)&&r.report?.received===false&&r.report?.height===undefined||(r.state==='reported-reverted'&&r.report?.reason==='CHECKTX_REJECTED'&&r.report?.received===false&&r.report?.code>0&&r.report?.height===undefined);
      if(r.state==='retired-unsent-expired'||submissionExpired){
        card.append(row(submissionExpired?'送信試行記録の期限超過終了':'未送信記録の終了',submissionExpired?'送信した可能性を残したまま、期限高超過と未消費sequenceを同じノードで照合しました。旧署名・送信観測は保持され、再送はできません。':'期限高超過を同じノードで照合し、所有者が終了しました。旧署名と履歴は保持され、再送はできません。'),row('終了確認の高さ',r.retirement?.check?.height??'未取得'),node('p','これは資金返還・注文取消・未実行の独立証明ではありません。新しい操作には別の確認と署名が必要です。','notice'));
      }else card.append(button('Injectiveの収録状態を再照合',async()=>{await api('non-evm/injective/reconcile',{id:r.id});await showNonEvmJournal();}));
      if(r.state==='signed'||canInspectSubmission){
        const attempted=r.state!=='signed';
        const recovery=node('section',undefined,'injective-recovery');
        recovery.append(node('p',attempted?'送信した可能性は取り消しません。署名内の期限高超過・未消費sequence・履歴・未収録応答を再検査します。404や通信失敗だけで解除せず、自動再送・資金返還もしません。':'未送信記録を終了するには、取引自身の期限高超過と口座状態を照合します。時刻期限切れ・対象消滅・404だけでは終了しません。','small'),button(attempted?'送信試行済み取引の期限・復旧条件を確認':'未送信取引の期限・復旧条件を確認',async()=>{
          const generationAtStart=generation,review=await api('non-evm/injective/recovery/prepare',{id:r.id});
          if(generationAtStart!==generation||!recovery.isConnected)return;
          if(review.schema!==(attempted?'realdex.injective-submission-expiry-review.v1':'realdex.injective-unsent-retirement-review.v1')||review.recordId!==r.id||review.transactionHash!==r.signed.requestId||review.neverSubmittedByWallet!==!attempted||(attempted&&(review.originalState!==r.state||review.submissionMayHaveOccurred!==true)))throw Error('INJECTIVE_RECOVERY_REVIEW_BINDING');
          const shaLabel=node('label','復旧確認SHA-256を全文再入力'),shaInput=node('input'),txLabel=node('label','終了する旧tx hashを全文再入力'),txInput=node('input');
          shaInput.autocomplete=txInput.autocomplete='off';shaInput.spellcheck=txInput.spellcheck=false;shaLabel.append(shaInput);txLabel.append(txInput);
          recovery.replaceChildren(node('h4',attempted?'送信の可能性を残す期限超過記録の終了確認':'未送信・期限超過記録の終了確認'),row('取引期限高',review.boundary.timeoutHeight),row('照合した高さ',review.evidence.height),row('旧取引ID',review.transactionHash),row('復旧確認SHA-256',review.reviewSha256),node('p','同じローカルノードの観測です。終了しても署名済みバイトと履歴は削除しません。新しい取引を自動作成・送信する操作ではありません。','notice'),shaLabel,txLabel,button(attempted?'旧送信試行記録を終了する（再送しない）':'旧未送信記録を終了する（送信しない）',async()=>{
            await api('non-evm/injective/recovery/retire',{id:r.id,review,confirmation:shaInput.value,transactionHash:txInput.value});await showNonEvmJournal();
          }));
        }));card.append(recovery);
      }

      if(r.state==='signed'){const label=node('label','初回送信するtx hashを全文再入力'),input=node('input');input.autocomplete='off';input.spellcheck=false;label.append(input);card.append(label,button('保存済みInjective署名を初めて送信',async()=>{await api('non-evm/injective/submit',{id:r.id,confirmation:input.value});await showNonEvmJournal();}));}
      else if(r.state!=='retired-unsent-expired'&&!submissionExpired)card.append(node('p','送信開始後は自動再送しません。保存済みtx hashの照合を続け、期限超過の復旧も全条件と別の所有者承認を必要とします。','small'));
    }
    else if(r.family==='solana'){
      card.append(button('Solanaの状態を再照合',async()=>{await api('non-evm/solana/reconcile',{id:r.id});await showNonEvmJournal();}));
      if(r.state==='signed'){
        const label=node('label','送信する署名IDを全文再入力'),input=node('input');input.autocomplete='off';label.append(input);card.append(label);
        card.append(button('保存済みSolana署名を初めて送信',async()=>{await api('non-evm/solana/submit',{id:r.id,confirmation:input.value});await showNonEvmJournal();}));
      }
    }
    else if(r.family==='bitcoin'&&r.summary.operation==='bitcoin-p2wpkh-online'){
      if(r.report)card.append(row('確認数',r.report.confirmations??'未確認'),row('収録ブロック',r.report.blockHash??'未確認'));
      card.append(button('Bitcoinの収録状態を再照合',async()=>{await api('non-evm/bitcoin-online/reconcile',{id:r.id});await showNonEvmJournal();}));
      if(r.state==='signed'){const label=node('label','送信するtxidを全文再入力'),input=node('input');input.autocomplete='off';label.append(input);card.append(label,button('保存済みBitcoin署名を初めて送信',async()=>{await api('non-evm/bitcoin-online/submit',{id:r.id,confirmation:input.value});await showNonEvmJournal();}));}
      else card.append(node('p','送信受付後の再送・RBFは、この版では行いません。確認は読み取りだけです。','small'));
    }
    else if(['cosmos','stellar','aptos'].includes(r.family)&&r.summary.operation.endsWith('-online')){
      const onlineRoute=r.summary.operation.startsWith('cosmos-authz-')?'cosmos-authz':r.family==='cosmos'?'cosmos-online':'account-online';
      if(onlineRoute==='cosmos-authz')card.append(row('権限操作',r.summary.action),row('資金の所有者',r.summary.granter),row('代理人',r.summary.grantee),row('権限操作の完了観測',r.report?.completed?'RPCで観測（現在の許可は別途照合）':'未確認'));
      card.append(row('取引ID',r.signed.requestId));
      if(r.report)card.append(row('収録位置（RPC観測）',r.report.version??r.report.ledger??r.report.height??'不明'),row('確認数',r.report.confirmations??'不明'));
      card.append(button(r.family.toUpperCase()+'の状態を再照合',async()=>{await api('non-evm/'+onlineRoute+'/reconcile',{id:r.id});await showNonEvmJournal();}));
      if(r.state==='signed'){
        const label=node('label','初回送信する取引IDを全文再入力'),input=node('input');input.autocomplete='off';label.append(input);
        card.append(label,button('保存済み署名を初めて送信',async()=>{await api('non-evm/'+onlineRoute+'/submit',{id:r.id,confirmation:input.value});await showNonEvmJournal();}));
      }else card.append(node('p','送信受付・結果不明後の自動再送や署名し直しは行いません。再照合は読み取りのみです。','small'));
    }
    else card.append(node('p','オフライン署名済み・未送信。別の時刻やmemoへ変更して再送しないでください。','small'),button(r.family.toUpperCase()+'署名済み要求を保存',async()=>download('realdex-'+r.family+'-signed-'+r.id+'.json',JSON.stringify(r,null,2))));
    return card;
  }));
}
if($('nonEvmPanel')){
  form('solanaSendForm',async()=>{
    const raw=$('solanaAmount').value;
    if(!/^(0|[1-9][0-9]*)(\.[0-9]{1,9})?$/.test(raw))throw Error('SOL_AMOUNT_PRECISION');
    // Service receives a decimal string and performs the authoritative conversion.
    const result=await api('non-evm/solana/prepare',{accountId:$('solanaAccount').value,networkId:$('solanaNetwork').value,payment:{requestKey:$('solanaRequestKey').value,to:$('solanaRecipient').value,amount:raw}});
    message(result.alreadyRecorded?'同じ支払いは記録済みです。新規送信せず履歴を確認してください。':'SOLの照合が完了しました。承認待ちを確認してください。');
    if(result.alreadyRecorded)await showNonEvmJournal();
  });
  $('solanaBalance').addEventListener('click',()=>run(async()=>{const revision=nonEvmBalanceRevision,accountId=$('solanaAccount').value,networkId=$('solanaNetwork').value;const r=await api('non-evm/solana/balance',{accountId,networkId});if(revision!==nonEvmBalanceRevision||accountId!==$('solanaAccount').value||networkId!==$('solanaNetwork').value)throw Error('SOLANA_FORM_CHANGED');$('solanaResult').textContent=displayAtomic(r.lamports,9)+' SOL（RPC観測）';}));
  for(const id of ['solanaAccount','solanaNetwork'])$(id).addEventListener('change',()=>{nonEvmBalanceRevision++;$('solanaResult').textContent='';});
  $('solanaNewKey').addEventListener('click',()=>{$('solanaRequestKey').value=newPaymentKey();message('別の支払いキーです。前の送金が不明な場合は支払わず、履歴を照合してください。');});
  form('solanaNetworkForm',async()=>{await api('non-evm/networks/add',{network:JSON.parse($('solanaNetworkJson').value),confirmation:$('solanaNetworkConfirmation').value});message('Solana設定を追加してロックしました。再解除してください。');});
  form('icpOfflineForm',async()=>{
    const sub=$('icpSubaccount').value,payment={requestKey:$('icpRequestKey').value,networkId:$('icpNetwork').value,ledger:$('icpLedger').value,to:{owner:$('icpRecipient').value,...(sub?{subaccount:sub}:{})},amountAtomic:$('icpAmount').value,feeAtomic:$('icpFee').value};
    const r=await api('non-evm/icp/prepare',{accountId:$('icpAccount').value,payment});message(r.alreadyRecorded?'ICP要求は記録済みです。再署名・再送していません。':'ICPのオフライン署名内容を確認してください。送信はしません。');if(r.alreadyRecorded)await showNonEvmJournal();
  });
  if($('injectiveActionForm')){
    const refreshSources=async()=>{const {records}=await api('non-evm/history');selectItems('injectiveCancelSource',records.filter(r=>r.family==='injective'&&r.state==='reported-confirmed'&&r.summary.operation==='injective-spot-order-local'&&r.accountId===$('injectiveActionAccount').value).map(r=>[r.id,r.requestKey+' · '+r.summary.marketId]));};
    $('injectiveActionRefresh').addEventListener('click',()=>refreshSources().catch(e=>message(e.message,true)));
    $('injectiveActionAccount').addEventListener('change',()=>refreshSources().catch(e=>message(e.message,true)));
    $('injectiveActionKind').addEventListener('change',()=>{const cancel=$('injectiveActionKind').value==='cancel';$('injectiveCancelFields').hidden=!cancel;$('injectiveWithdrawFields').hidden=cancel;const deposit=$('injectiveActionKind').value==='deposit';$('injectiveAmountLabel').textContent=(deposit?'入金':'出金')+'数量（最小単位の整数）';$('injectiveActionForm').querySelector('button[type=submit]').textContent=deposit?'入金条件を照合して承認待ちへ':'取消・出金条件を照合して承認待ちへ';});
    form('injectiveActionForm',async()=>{const kind=$('injectiveActionKind').value,accountId=$('injectiveActionAccount').value,requestKey=$('injectiveActionKey').value;
      const policy={gasLimit:$('injectiveActionGas').value,gasPriceAtomic:$('injectiveActionGasPrice').value,maxGasFeeAtomic:$('injectiveActionMaxFee').value,gasMarginBps:12500,timeoutBlocks:40,maxAgeMs:30000};
      const body=kind==='cancel'?{accountId,sourceRecordId:$('injectiveCancelSource').value,payment:{requestKey,orderHash:$('injectiveCancelHash').value,policy}}:{accountId,payment:{requestKey,endpoint:$('injectiveActionEndpoint').value,subaccountId:$('injectiveActionSubaccount').value,denom:$('injectiveActionDenom').value,amountAtomic:$('injectiveActionAmount').value,policy}};
      const result=await api('non-evm/injective/'+kind+'/prepare',body);
      message(result.alreadyRecorded?'同じ要求は署名保存済みです。再署名・再送しません。':'条件を照合しました。承認画面の操作・対象・数量・SHAを確認してください。まだ署名・送信していません。');
      if(result.alreadyRecorded)await showNonEvmJournal();else await refresh();
    });
  }
  if($('injectiveReviewForm'))form('injectiveReviewForm',async()=>{const review=JSON.parse($('injectiveReviewJson').value),result=await api('non-evm/injective/prepare',{accountId:$('injectiveOwnerAccount').value,review});message(result.alreadyRecorded?'同じInjective注文は記録済みです。再署名・再送しません。':'Injective注文を承認待ちへ追加しました。preflight SHA-256と全条件を確認してください。');if(result.alreadyRecorded)await showNonEvmJournal();else await refresh();});
  $('nonEvmHistory').addEventListener('click',()=>run(showNonEvmJournal));
}

if($('splSendForm')){
  form('splSendForm',async()=>{const r=await api('non-evm/spl/prepare',{accountId:$('splAccount').value,networkId:$('splNetwork').value,payment:{requestKey:$('splRequestKey').value,mint:$('splMint').value,source:$('splSource').value,destination:$('splDestination').value,to:$('splRecipient').value,amount:$('splAmount').value}});message(r.alreadyRecorded?'同じSPL支払いは記録済みです。再送しません。':'SPL送金の照合が済みました。承認待ちを確認してください。');if(r.alreadyRecorded)await showNonEvmJournal();});
  for(const id of ['splAccount','splNetwork','splMint'])$(id).addEventListener('change',()=>{splRevision++;$('splAccountsResult').textContent='';if(id==='splNetwork')refreshSplMint();});
  $('splDiscover').addEventListener('click',()=>run(async()=>{const revision=splRevision,a=state?.accounts.find(a=>a.id===$('splAccount').value);if(!a)throw Error('ACCOUNT_REQUIRED');const r=await api('non-evm/spl/accounts',{networkId:$('splNetwork').value,owner:a.address,mint:$('splMint').value});if(revision!==splRevision)throw Error('SPL_FORM_CHANGED');$('splAccountsResult').textContent=JSON.stringify(r,null,2);}));
  $('offlineFamily').addEventListener('change',()=>{refreshOfflineAccounts();$('offlinePaymentJson').value='';$('offlineStateAck').checked=false;});
  $('offlineExample').addEventListener('click',()=>{const expiry=String(Math.floor(Date.now()/1000)+180),requestKey=newPaymentKey();const examples={bitcoin:{requestKey,networkId:'bitcoin:regtest',to:'受取先のbcrt1アドレス',amountAtomic:'100000',feeAtomic:'1000',maxFeeRateSatVb:'50',utxos:[{txid:'照合した64桁のtxid',vout:0,amountAtomic:'200000',scriptHex:'0014と自分の公開鍵hash160'}]},cosmos:{requestKey,chainId:'realdex-local-development',hrp:'cosmos',to:'受取先のcosmos1アドレス',denom:'utest',amountAtomic:'1000000',feeDenom:'utest',feeAtomic:'2500',gasLimit:'200000',accountNumber:'0',sequence:'0',timeoutHeight:'1000',memo:''},stellar:{requestKey,networkPassphrase:'Standalone Network ; February 2017',to:'受取先のGアドレス',amountAtomic:'10000000',feeAtomic:'100',sequence:'1',maxTime:expiry,memo:''},aptos:{requestKey,chainId:4,to:'受取先0xと64桁hex',amountAtomic:'100000000',sequence:'0',maxGasAmount:'2000',gasUnitPrice:'100',expirationTimestampSecs:expiry}};$('offlinePaymentJson').value=JSON.stringify(examples[$('offlineFamily').value],null,2);$('offlineStateAck').checked=false;});
  form('offlineSignerForm',async()=>{if(!$('offlineStateAck').checked)throw Error('UNVERIFIED_STATE_ACK_REQUIRED');const payment=JSON.parse($('offlinePaymentJson').value);payment.acknowledgeUnverifiedState=true;const r=await api('non-evm/'+$('offlineFamily').value+'/prepare',{accountId:$('offlineAccount').value,payment});message(r.alreadyRecorded?'同じ要求は署名済みです。履歴を確認してください。':'ネットワークへ送信しません。承認待ちで全条件を確認してください。');if(r.alreadyRecorded)await showNonEvmJournal();});
}

// Bitcoin uses the owner capability only. No discovery node or AI may invoke this panel.
if($('bitcoinOnlineSection')){
  const fields=['bitcoinAccount','bitcoinNetwork','bitcoinRecipient','bitcoinAmount','bitcoinFee','bitcoinMaxRate','bitcoinRequestKey','bitcoinUtxos'];
  for(const id of fields)$(id).addEventListener('input',()=>{bitcoinRevision++;});
  for(const id of ['bitcoinAccount','bitcoinNetwork'])$(id).addEventListener('change',()=>{bitcoinRevision++;$('bitcoinScanResult').textContent='';$('bitcoinUtxos').value='';});
  $('bitcoinScan').addEventListener('click',()=>run(async()=>{
    const revision=bitcoinRevision,accountId=$('bitcoinAccount').value,networkId=$('bitcoinNetwork').value;
    const result=await api('non-evm/bitcoin-online/utxos',{accountId,networkId});
    if(revision!==bitcoinRevision||state?.locked)throw Error('BITCOIN_FORM_CHANGED');
    $('bitcoinScanResult').textContent=JSON.stringify(result,null,2);
    $('bitcoinUtxos').value=JSON.stringify(result.utxos.filter(u=>u.eligible).slice(0,1).map(({txid,vout,amountAtomic,scriptHex})=>({txid,vout,amountAtomic,scriptHex})),null,2);bitcoinRevision++;
  }));
  $('bitcoinNewKey').addEventListener('click',()=>{$('bitcoinRequestKey').value=newPaymentKey();bitcoinRevision++;});
  form('bitcoinSendForm',async()=>{
    const revision=bitcoinRevision;
    const r=await api('non-evm/bitcoin-online/prepare',{accountId:$('bitcoinAccount').value,networkId:$('bitcoinNetwork').value,payment:{requestKey:$('bitcoinRequestKey').value,to:$('bitcoinRecipient').value,amount:$('bitcoinAmount').value,feeAtomic:$('bitcoinFee').value,maxFeeRateSatVb:$('bitcoinMaxRate').value,utxos:JSON.parse($('bitcoinUtxos').value)}});
    if(revision!==bitcoinRevision||state?.locked){if(r.id)await api('reject',{id:r.id});throw Error('BITCOIN_FORM_CHANGED');}
    message(r.alreadyRecorded?'同じBitcoin支払いは記録済みです。再送していません。':'UTXO照合済み。承認待ちで受取先・数量・手数料・お釣りを確認してください。');if(r.alreadyRecorded)await showNonEvmJournal();
  });
  form('bitcoinNetworkForm',async()=>{await api('non-evm/bitcoin-online/networks/add',{network:JSON.parse($('bitcoinNetworkJson').value),confirmation:$('bitcoinNetworkConfirmation').value});message('Bitcoin設定を登録してロックしました。再解除してください。');});
}

function refreshAccountOnline(current){
  if(!$('accountOnlineSection'))return;
  selectItems('accountOnlineNetwork',(current.accountNetworks||[]).map(n=>[n.id,n.name]));
  const n=(current.accountNetworks||[]).find(n=>n.id===$('accountOnlineNetwork').value),family=n?.family??'stellar';
  selectItems('accountOnlineAccount',current.accounts.filter(a=>a.kind==='local'&&a.family===family).map(a=>[a.id,a.label+' · '+a.address]));
  $('stellarOnlineFields').hidden=family!=='stellar';$('aptosOnlineFields').hidden=family!=='aptos';
  $('stellarOnlineFee').required=family==='stellar';
  if(!$('accountOnlineKey').value)$('accountOnlineKey').value=newPaymentKey();
}
if($('accountOnlineSection')){
  const fields=['accountOnlineNetwork','accountOnlineAccount','accountOnlineRecipient','accountOnlineAmount','accountOnlineKey','stellarOnlineFee','stellarOnlineMemo','aptosOnlineMaxGas','aptosOnlineGasPrice'];
  for(const id of fields)$(id).addEventListener('input',()=>{accountOnlineRevision++;$('accountOnlineResult').textContent='';});
  $('accountOnlineNetwork').addEventListener('change',()=>{accountOnlineRevision++;$('accountOnlineResult').textContent='';if(state)refreshAccountOnline(state);});
  $('accountOnlineNewKey').addEventListener('click',()=>{accountOnlineRevision++;$('accountOnlineKey').value=newPaymentKey();$('accountOnlineResult').textContent='';message('別の支払いキーを作成しました。結果不明の取引がある場合は、先に履歴を照合してください。');});
  $('accountOnlineBalance').addEventListener('click',()=>run(async()=>{
    const revision=accountOnlineRevision;
    const r=await api('non-evm/account-online/balance',{accountId:$('accountOnlineAccount').value,networkId:$('accountOnlineNetwork').value});
    if(revision!==accountOnlineRevision)throw Error('ACCOUNT_FORM_CHANGED');
    $('accountOnlineResult').textContent=displayAtomic(r.account.balanceAtomic,r.decimals)+' '+r.asset+' · sequence '+r.account.sequence+'\nRPC観測のみ・確定証明なし';
  }));
  form('accountOnlineForm',async()=>{
    const revision=accountOnlineRevision,networkId=$('accountOnlineNetwork').value,n=state.accountNetworks.find(n=>n.id===networkId);
    if(!n)throw Error('ACCOUNT_NETWORK_NOT_CONFIGURED');
    const payment={requestKey:$('accountOnlineKey').value,to:$('accountOnlineRecipient').value,amount:$('accountOnlineAmount').value,...(n.family==='stellar'?{feeAtomic:$('stellarOnlineFee').value,memo:$('stellarOnlineMemo').value}:{maxGasAmount:$('aptosOnlineMaxGas').value,gasUnitPrice:$('aptosOnlineGasPrice').value})};
    const r=await api('non-evm/account-online/prepare',{accountId:$('accountOnlineAccount').value,networkId,payment});
    if(revision!==accountOnlineRevision){if(r.id)await api('reject',{id:r.id});throw Error('ACCOUNT_FORM_CHANGED');}
    message(r.alreadyRecorded?'同じ支払いは記録済みです。新規送信せず履歴を確認してください。':'承認待ちで受取先・数量・sequence・期限・手数料を確認してください。まだ署名していません。');
    if(r.alreadyRecorded)await showNonEvmJournal();
  });
  form('accountOnlineNetworkForm',async()=>{
    await api('non-evm/account-online/networks/add',{network:JSON.parse($('accountOnlineNetworkJson').value),confirmation:$('accountOnlineConfirmation').value});
    message('ネットワークを登録し、ロックしました。再解除して内容を確認してください。');
  });
}


function refreshCosmosOnline(current){
  if(!$('cosmosOnlineSection'))return;
  selectItems('cosmosOnlineNetwork',(current.cosmosNetworks||[]).map(n=>[n.id,n.name]));
  selectItems('cosmosOnlineAccount',current.accounts.filter(a=>a.family==='cosmos'&&a.kind==='local').map(a=>[a.id,a.label+' · '+a.address]));
  const n=(current.cosmosNetworks||[]).find(n=>n.id===$('cosmosOnlineNetwork').value);
  $('cosmosUnits').textContent=n?'数量: '+n.symbol+' / '+n.denom+' ('+n.decimals+'桁) · 手数料: '+n.feeDenom+' の最小単位 / 上限 '+n.maxFeeAtomic:'接続設定がありません。自分で確認したローカル設定を登録してください。';
  if(!$('cosmosOnlineKey').value)$('cosmosOnlineKey').value=newPaymentKey();
}
if($('cosmosOnlineSection')){
  for(const id of ['cosmosOnlineNetwork','cosmosOnlineAccount','cosmosOnlineRecipient','cosmosOnlineAmount','cosmosOnlineKey','cosmosOnlineFee','cosmosOnlineGas','cosmosOnlineMemo'])$(id).addEventListener('input',()=>{cosmosRevision++;$('cosmosOnlineResult').textContent='';});
  $('cosmosOnlineNetwork').addEventListener('change',()=>{cosmosRevision++;if(state)refreshCosmosOnline(state);});
  $('cosmosOnlineNewKey').addEventListener('click',()=>{cosmosRevision++;$('cosmosOnlineKey').value=newPaymentKey();$('cosmosOnlineResult').textContent='';message('別の支払いキーです。前の支払いの取消しや再送ではありません。');});
  $('cosmosOnlineBalance').addEventListener('click',()=>run(async()=>{
    const revision=cosmosRevision;
    const r=await api('non-evm/cosmos-online/balance',{accountId:$('cosmosOnlineAccount').value,networkId:$('cosmosOnlineNetwork').value});
    if(revision!==cosmosRevision)throw Error('COSMOS_FORM_CHANGED');
    $('cosmosOnlineResult').textContent=displayAtomic(r.account.balanceAtomic,r.decimals)+' '+r.symbol+' / '+r.asset+'\n手数料残高: '+displayAtomic(r.account.feeBalanceAtomic,r.feeDecimals)+' '+r.feeAsset+'\naccountNumber '+r.account.accountNumber+' · sequence '+r.account.sequence+' · height '+r.head.height+'\nRPC観測のみ・独立した状態証明なし';
  }));
  form('cosmosOnlineForm',async()=>{
    const revision=cosmosRevision;
    const payment={requestKey:$('cosmosOnlineKey').value,to:$('cosmosOnlineRecipient').value,amount:$('cosmosOnlineAmount').value,feeAtomic:$('cosmosOnlineFee').value,gasLimit:$('cosmosOnlineGas').value,memo:$('cosmosOnlineMemo').value};
    const r=await api('non-evm/cosmos-online/prepare',{accountId:$('cosmosOnlineAccount').value,networkId:$('cosmosOnlineNetwork').value,payment});
    if(revision!==cosmosRevision){if(r.id)await api('reject',{id:r.id});throw Error('COSMOS_FORM_CHANGED');}
    message(r.alreadyRecorded?'記録済みの支払いです。新しい署名・送信は行いません。':'受取先・denom・数量・sequence・期限・手数料を承認待ちで確認してください。まだ署名していません。');
    if(r.alreadyRecorded)await showNonEvmJournal();
  });
  form('cosmosOnlineNetworkForm',async()=>{
    await api('non-evm/cosmos-online/networks/add',{network:JSON.parse($('cosmosOnlineNetworkJson').value),confirmation:$('cosmosOnlineConfirmation').value});
    message('ローカルCosmos設定を登録してロックしました。再解除して確認してください。');
  });
}

// Smart-account panel: owner-only. No capability or secret is passed to the shared node.
function renderSmart(s){
  if(!$('smartPanel'))return;
  if(s.locked){smartRevision++;smartDraft=null;smartRenderKey='';$('smartRegisterReview').hidden=true;$('smartRegisterConfirm').value='';$('smartInspection').hidden=true;$('smartInspection').textContent='';$('smartMessages').replaceChildren();$('smartMessage').value='';$('smartFields').replaceChildren();smartFields=[];$('smartRegisterDetails').textContent='';return;}
  selectItems('smartOwner',accountChoices());selectItems('smartNetwork',s.networks.map(n=>[n.chainId,n.name]));
  selectItems('smartAccount',(s.smartAccounts||[]).map(d=>[d.id,d.label+' · '+d.address]));
  const d=(s.smartAccounts||[]).find(d=>d.id===$('smartAccount').value);
  $('smartSelected').textContent=d?`資産保有先: ${d.address} / chain ${d.chainId} / 所有者: ${s.accounts.find(a=>a.id===d.ownerAccountId)?.address||'未確認'}`:'最初にFactoryと所有者を確認し、アカウントを登録してください。';
  const key=JSON.stringify([$('smartAccount').value,$('smartAction').value,accountChoices(),s.networks]);
  if(key!==smartRenderKey){smartRenderKey=key;smartRevision++;renderSmartFields();}
  if(!$('smartSalt').value)$('smartSalt').value='0x'+newPaymentKey()+newPaymentKey();
}
function renderSmartFields(){
  smartFields=[];const host=$('smartFields');host.replaceChildren();
  const d=(state?.smartAccounts||[]).find(d=>d.id===$('smartAccount').value),n=state?.networks.find(n=>n.chainId===d?.chainId);
  const input=(key,title,{kind='input',value='',options=null,placeholder=''}={})=>{
    const label=node('label',title),field=node(options?'select':kind);field.id='smartField_'+key;field.required=true;field.spellcheck=false;
    if(options)for(const [v,name]of options){const o=node('option',name);o.value=v;field.append(o);}else{field.value=value;field.placeholder=placeholder;if(kind==='textarea')field.rows=4;}
    field.addEventListener('input',()=>{smartRevision++;$('smartInspection').hidden=true;});label.append(field);host.append(label);smartFields.push([key,field]);return field;
  };
  const assets=[['native',n?.symbol||'ネイティブ通貨'],...(n?.tokens||[]).map(t=>[t.address,t.symbol+' · '+t.address])];
  const keyOptions=accountChoices().filter(([id])=>id!==d?.ownerAccountId);
  const t=$('smartAction').value;
  if(t==='fund')input('amount','入金額（ネイティブ通貨）',{placeholder:'0.01'});
  if(t==='payment'){input('asset','資産',{options:assets});input('recipient','受取先アドレス',{placeholder:'0x…'});input('amount','送金額（選択資産）',{placeholder:'0.001'});}
  if(t==='payments')input('transfers','支払い配列（amountは小数文字列、最大8件）',{kind:'textarea',placeholder:'[{"asset":"native","recipient":"0x…","amount":"0.001"}]'});
  if(t==='swap'){
    input('router','登録済みRouter',{placeholder:'0x…'});input('pools','通過する登録済みPoolのJSON配列（最大4件）',{placeholder:'["0x…"]'});
    input('tokenIn','入力トークン',{options:assets.filter(([a])=>a!=='native')});input('amount','入力数量');input('minimumOutput','最終出力トークンの最低受取数量');input('recipient','受取先',{value:d?.address||''});
    host.append(node('p','有限額の承認・交換・承認取消しを同じ取引で実行します。ガス控除後の最適経路探索ではありません。失敗時には全操作が巻き戻ります。','small'));
  }
  if(['grant-session','session-transfer'].includes(t))input('sessionAccountId','補助鍵（所有者と別のローカルEVM口座）',{options:keyOptions});
  if(t==='grant-session'){
    input('asset','許可する資産',{options:assets});input('recipient','許可する受取先（1つ）');input('perCall','1回の上限');input('daily','UTC暦日ごとの上限');input('total','許可全体の累計上限');input('minutes','有効時間（分、最大10080）',{value:'60'});
    host.append(node('p','この鍵はチェーン上の許可を持ちます。同じPCの「AI停止」だけでは取消できません。オンチェーンの取消取引か期限到達が必要です。','error'));
  }
  if(t==='session-transfer')input('amount','補助鍵が送金する数量');
  if(t==='revoke-session')input('key','取り消す補助鍵の公開アドレス',{options:keyOptions.map(([id,label])=>[state.accounts.find(a=>a.id===id).address,label])});
}
function renderSmartApproval(r){
  const s=r.summary,card=node('article',undefined,'request-card');card.dataset.request=r.id;
  const isMessage=r.kind==='smart-message';card.append(node('h3',isMessage?'スマートアカウントの署名内容を確認':'スマートアカウントの操作を確認'),row('要求元',r.origin),row('ネットワーク',s.network+' / '+s.chainId),row('確認期限',new Date(r.expiresAt).toLocaleString()));
  if(isMessage){card.append(row('アカウント',s.recipient),row('署名の有効期限',new Date(Number(s.validUntil)*1000).toLocaleString()),row('署名世代',s.epoch),row('アプリケーションhash',s.hash));const pre=node('pre',s.message);card.append(pre,node('p','これは送金取引ではありません。ただし認証に使用できる署名です。内容を確認してください。','small'));}
  else{
    const d=s.smart.descriptor;card.append(row('資産を持つアカウント',d.address),row('所有者',s.smart.owner),row('ガス代を払う鍵',s.from),row('操作',s.operation),row('確認用アドレス',s.recipient),row('ガス代上限（wei）',s.executionFeeCapWei),row('EOA nonce',s.nonce));
    for(const a of s.assetMoves||[])card.append(row('数量',displayAtomic(a.amountAtomic,a.decimals)+' '+a.symbol));
    card.append(node('pre',JSON.stringify(s.details,null,2)));
    if(s.smart.operation.calls)card.append(node('details',undefined,'small')); // Full signed calls are shown, never arbitrary UI HTML.
    if(s.smart.operation.calls){const details=card.lastChild;details.append(node('summary','署名する全呼び出し'),node('pre',JSON.stringify(s.smart.operation.calls,null,2)));}
    card.append(node('p','固定した未監査の開発コードとの照合です。メインネットでは使用しないでください。','small'));
  }
  const confirmation=node('input');confirmation.placeholder=s.recipient;confirmation.autocomplete='off';confirmation.spellcheck=false;
  const label=node('label','確認用アドレスを省略せず再入力');label.append(confirmation);card.append(label);
  let broadcast=null;if(!isMessage){broadcast=node('input');broadcast.type='checkbox';const label=node('label',undefined,'check');label.append(broadcast,node('span','保存後に初回送信する（既定OFF）'));card.append(label);}
  const actions=node('div',undefined,'actions');actions.append(button(isMessage?'この文字列への署名を許可':'この操作だけ署名を許可',async()=>{
    const result=await api('approve',{id:r.id,intentId:r.intentId,confirm:confirmation.value,broadcast:Boolean(broadcast?.checked)});
    message(isMessage?'署名を暗号化保存しました。':'処理状態: '+result.broadcastState);if(isMessage)await showSmartMessages();else await showJournal();
  },''),button('拒否',async()=>{await api('reject',{id:r.id});message('要求を拒否しました。');}));card.append(actions);return card;
}
async function showSmartMessages(){
  const revision=smartRevision,{messages}=await api('smart/messages');if(revision!==smartRevision||state?.locked)return;
  $('smartMessages').replaceChildren(...messages.slice().reverse().map(m=>{
    const card=node('article',undefined,'request-card');card.append(node('pre',m.message),row('hash',m.hash),row('有効期限',new Date(Number(m.validUntil)*1000).toLocaleString()));
    card.append(button('ERC-1271を現在のRPCで検証',async()=>{const r=await api('smart/message/verify',{messageId:m.id});message(r.valid?'署名を有効と観測しました（確定証明ではありません）。':'署名が無効・失効・期限切れです。');}),button('署名ファイルを保存',async()=>download('realdex-smart-message-'+m.id+'.json',JSON.stringify(m,null,2))));return card;
  }));
}
if($('smartPanel')){
  $('smartAccount').addEventListener('change',()=>{smartRevision++;smartRenderKey='';$('smartInspection').hidden=true;renderSmart(state);});
  $('smartAction').addEventListener('change',()=>{smartRevision++;smartRenderKey='';renderSmart(state);});
  form('smartRegisterForm',async()=>{
    smartDraft=null;$('smartRegisterReview').hidden=true;const rev=++smartRevision;
    const draft=await api('smart/register/prepare',{ownerAccountId:$('smartOwner').value,chainId:$('smartNetwork').value,factory:$('smartFactory').value,salt:$('smartSalt').value,label:$('smartLabel').value});
    if(rev!==smartRevision||state.locked)throw Error('SMART_FORM_CHANGED');smartDraft=draft;$('smartRegisterDetails').textContent=JSON.stringify(draft,null,2);$('smartRegisterConfirm').value='';$('smartRegisterConfirm').placeholder=draft.confirmation;$('smartRegisterReview').hidden=false;
  });
  for(const id of ['smartOwner','smartNetwork','smartFactory','smartSalt','smartLabel'])$(id).addEventListener('input',()=>{smartRevision++;smartDraft=null;$('smartRegisterReview').hidden=true;});
  $('smartRegisterCommit').addEventListener('click',()=>run(async()=>{if(!smartDraft)throw Error('SMART_REGISTRATION_EXPIRED');await api('smart/register/commit',{draftId:smartDraft.draftId,digest:smartDraft.digest,confirm:$('smartRegisterConfirm').value});smartDraft=null;$('smartRegisterReview').hidden=true;message('アカウントを登録しました。最新バックアップを保存・再読込してからデプロイしてください。');}));
  form('smartOperationForm',async()=>{
    const type=$('smartAction').value,fields=Object.fromEntries(smartFields.map(([k,e])=>[k,e.value]));let operation={type,...fields};
    if(type==='payment')operation={type:'payments',transfers:[fields]};
    if(type==='payments')operation={type,transfers:JSON.parse(fields.transfers)};
    if(type==='swap')operation={...operation,pools:JSON.parse(fields.pools),validUntil:String(Math.floor(Date.now()/1000)+300)};
    if(type==='grant-session'){if(!/^[1-9][0-9]{0,4}$/.test(fields.minutes)||Number(fields.minutes)>10080)throw Error('SMART_SESSION_EXPIRY_INVALID');delete operation.minutes;operation.validUntil=String(Math.floor(Date.now()/1000)+Number(fields.minutes)*60);}
    const revision=smartRevision,result=await api('smart/prepare',{id:$('smartAccount').value,operation});
    if(revision!==smartRevision||state.locked){await api('reject',{id:result.id});throw Error('SMART_FORM_CHANGED');}
    message('承認待ちへ追加しました。全受取先・数量・費用を確認してください。まだ署名していません。');
  });
  const inspect=async(session=false)=>{const revision=smartRevision,body={id:$('smartAccount').value};if(session){const e=$('smartField_sessionAccountId');if(!e?.value)throw Error('SMART_SESSION_KEY_REQUIRED');body.sessionAccountId=e.value;}
    const r=await api('smart/inspect',body);if(revision!==smartRevision||state.locked)throw Error('SMART_FORM_CHANGED');$('smartInspection').textContent=JSON.stringify(r,null,2);$('smartInspection').hidden=false;};
  $('smartInspect').addEventListener('click',()=>run(()=>inspect()));$('smartInspectSession').addEventListener('click',()=>run(()=>inspect(true)));
  form('smartMessageForm',async()=>{const minutes=Number($('smartMessageMinutes').value);if(!Number.isInteger(minutes)||minutes<1||minutes>60)throw Error('SMART_MESSAGE_EXPIRY_INVALID');const revision=smartRevision,r=await api('smart/message/prepare',{id:$('smartAccount').value,message:$('smartMessage').value,validUntil:String(Math.floor(Date.now()/1000)+minutes*60)});if(revision!==smartRevision||state.locked){await api('reject',{id:r.id});throw Error('SMART_FORM_CHANGED');}message('署名内容を承認待ちに追加しました。');});
  $('smartMessage').addEventListener('input',()=>smartRevision++);$('smartMessageMinutes').addEventListener('input',()=>smartRevision++);
  $('smartMessageHistory').addEventListener('click',()=>run(showSmartMessages));
}

// Cosmos native authz: this owner panel never exposes arbitrary authz messages to a dapp.
function refreshAuthz(current){
  if(!$('cosmosAuthzSection'))return;
  selectItems('authzNetwork',(current.cosmosNetworks||[]).map(n=>[n.id,n.name]));
  selectItems('authzAccount',current.accounts.filter(a=>a.family==='cosmos'&&a.kind==='local').map(a=>[a.id,a.label+' · '+a.address]));
  const n=(current.cosmosNetworks||[]).find(n=>n.id===$('authzNetwork').value);
  $('authzUnits').textContent=n?'許可資産: '+n.denom+' / '+n.symbol+' ('+n.decimals+'桁) · 費用: '+n.feeDenom+' · 設定上限 '+n.maxTransferAtomic:'確認済みのローカルCosmos接続設定が必要です。';
  if(!$('authzKey').value)$('authzKey').value=newPaymentKey();
  if(!$('authzExpiry').value){const d=new Date(Date.now()+3600000);d.setMinutes(d.getMinutes()-d.getTimezoneOffset());$('authzExpiry').value=d.toISOString().slice(0,16);}
  updateAuthzAction();
}
function updateAuthzAction(){
  const action=$('authzAction').value;
  $('authzPeerLabel').textContent=action==='execute'?'資金の所有者（許可を与えた口座）':'代理人の完全なアドレス';
  $('authzAmountTitle').textContent=action==='grant'?'許可する累計数量（最小単位）':'送金数量（最小単位）';
  for(const id of ['authzRecipient','authzAmount']){const input=$(id);input.required=action!=='revoke';input.disabled=action==='revoke';$(id+'Label').hidden=action==='revoke';}
  $('authzExpiry').required=action==='grant';$('authzExpiry').disabled=action!=='grant';$('authzExpiryLabel').hidden=action!=='grant';
}
if($('cosmosAuthzSection')){
  for(const id of ['authzNetwork','authzAccount','authzAction','authzPeer','authzRecipient','authzAmount','authzExpiry','authzFee','authzGas','authzKey'])$(id).addEventListener('input',()=>{authzRevision++;$('authzResult').textContent='';});
  $('authzAction').addEventListener('change',updateAuthzAction);
  $('authzNetwork').addEventListener('change',()=>{if(state)refreshAuthz(state);});
  $('authzNewKey').addEventListener('click',()=>{authzRevision++;$('authzKey').value=newPaymentKey();$('authzResult').textContent='';message('別の依頼キーです。以前の支払い・許可を取り消す操作ではありません。');});
  $('authzStatus').addEventListener('click',()=>run(async()=>{
    const revision=authzRevision,account=(state?.accounts||[]).find(a=>a.id===$('authzAccount').value);
    if(!account)throw Error('ACCOUNT_NOT_FOUND');
    // Alternate HRPs are converted inside the signer for transactions. Status takes explicit network addresses.
    const selectedNetwork=$('authzNetwork').value,action=$('authzAction').value,peer=$('authzPeer').value;
    const balance=await api('non-evm/cosmos-online/balance',{accountId:account.id,networkId:selectedNetwork});
    if(revision!==authzRevision)throw Error('AUTHZ_FORM_CHANGED');
    const granter=action==='execute'?peer:balance.networkFrom,grantee=action==='execute'?balance.networkFrom:peer;
    const r=await api('non-evm/cosmos-authz/status',{networkId:$('authzNetwork').value,granter,grantee});
    if(revision!==authzRevision)throw Error('AUTHZ_FORM_CHANGED');$('authzResult').textContent=JSON.stringify(r,null,2);
  }));
  form('authzForm',async()=>{
    const revision=authzRevision,action=$('authzAction').value,payment={action,requestKey:$('authzKey').value,feeAtomic:$('authzFee').value,gasLimit:$('authzGas').value};
    payment[action==='execute'?'granter':'grantee']=$('authzPeer').value;
    if(action!=='revoke'){payment.recipient=$('authzRecipient').value;payment[action==='grant'?'limitAtomic':'amountAtomic']=$('authzAmount').value;}
    if(action==='grant'){const t=Date.parse($('authzExpiry').value);if(!Number.isSafeInteger(t))throw Error('AUTHZ_EXPIRATION_INVALID');payment.expirationSeconds=String(Math.floor(t/1000));}
    const r=await api('non-evm/cosmos-authz/prepare',{accountId:$('authzAccount').value,networkId:$('authzNetwork').value,payment});
    if(revision!==authzRevision){if(r.id)await api('reject',{id:r.id});throw Error('AUTHZ_FORM_CHANGED');}
    message(r.alreadyRecorded?'記録済みです。新しい署名・送信はしません。':'所有者・代理人・許可先・数量・期限を承認待ちで確認してください。まだ署名していません。');
    if(r.alreadyRecorded)await showNonEvmJournal();
  });
}

$('protectedSettingsLoad').addEventListener('click', () => run(async () => {
  const r = await api('protected/settings');
  $('protectedSettingsJson').value = JSON.stringify(r.settings, null, 2);
  protectedSettingsDraft = null; $('protectedSettingsReview').hidden = true;
  message('現在の設定を読み込みました。読み込みだけでは保存しません。');
}));
form('protectedSettingsForm', async () => {
  const raw = $('protectedSettingsJson').value;
  if (raw.length > 131072) throw Error('CP_SETTINGS_SIZE');
  let settings; try { settings = JSON.parse(raw); } catch { throw Error('JSON_INVALID'); }
  protectedSettingsDraft = await api('protected/settings/prepare', {settings});
  $('protectedSettingsDetails').textContent = JSON.stringify(protectedSettingsDraft, null, 2);
  $('protectedSettingsConfirm').value = ''; $('protectedSettingsReview').hidden = false;
  message('内容と接続先を確認してください。まだ保存していません。');
});
$('protectedSettingsCancel').addEventListener('click', () => {
  protectedSettingsDraft = null; $('protectedSettingsReview').hidden = true;
  $('protectedSettingsConfirm').value = ''; $('protectedSettingsDetails').textContent = '';
});
$('protectedSettingsApply').addEventListener('click', () => run(async () => {
  const r = protectedSettingsDraft;
  if (!r || $('protectedSettingsConfirm').value !== r.reviewSha256) throw Error('CP_SETTINGS_CONFIRMATION');
  await api('protected/settings/apply', {id:r.id,reviewSha256:r.reviewSha256,confirmation:'SAVE SETTINGS AND LOCK'});
  protectedSettingsDraft = null; message('設定を暗号化保存してロックしました。解除後に最新バックアップを保存してください。');
}));
