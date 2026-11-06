import { VerifiedCatalogue } from './verified/catalogue.mjs';
import { createReadOnlyRpc, openPinnedReadSession } from './verified/rpc.mjs';
import { observeLocalPools, assertCurrentObservation, simulateObservedPool, compareObservedPools, planObservedGrossSplit, observationJson, recheckObservation } from './verified/evm.mjs';

const $=id=>document.getElementById(id);
let generation=0,controller=null,observation=null,catalogue=null,cataloguePolicy='',timer=null,account='',working=false;
function text(tag,value,className=''){const node=document.createElement(tag);node.textContent=value;if(className)node.className=className;return node;}
const clear=id=>$(id).replaceChildren();
const short=a=>a.slice(0,8)+'…'+a.slice(-6);
const errors={FACTORY_CODE_MISMATCH:'Factoryの実行コードが、この版の信頼対象と一致しません。',RPC_DISAGREEMENT:'RPCの回答が一致しません。候補を採用せず停止しました。',RPC_ANCHOR_DISAGREEMENT:'照合するブロックがRPC間で一致しません。',SNAPSHOT_REORG:'照合ブロックの再編を検出しました。再検証が必要です。',SNAPSHOT_EXPIRED:'観測が期限切れです。再検証してください。',NO_CHAIN_CANDIDATES:'指定チェーンのFactory候補がありません。ノードのcatalogueと発信者の許可鍵を確認してください。',RPC_REMOTE_ERROR:'RPCが読み取りを拒否しました。EIP-1898対応・対象チェーン・トークンを確認してください。',APPROVAL_REQUIRED_NO_TRANSACTION_SENT:'既存の承認が不足しています。取引は作成・送信していません。',FACTORY_TIER_BUDGET_EXCEEDED:'Factory×料率が32組を超えています。対象を絞って再検証してください。',SPLIT_ROUTE_LIMIT:'分割計算は1〜8プールが対象です。候補を勝手に間引かず停止しました。'};
const errorText=e=>e?.name==='AbortError'||e?.name==='TimeoutError'?'中止またはタイムアウトしました。取引は送信していません。':errors[e?.message]??`検証を停止しました：${/^[A-Z][A-Z0-9_]+$/.test(e?.message??'')?e.message:'READ_FAILED'}`;
function status(message,error=false){$('progress').textContent=message;$('progress').className=error?'error-text':'';}
function busy(value){working=value;$('verify').disabled=value;$('cancel').disabled=!value;for(const id of ['simulate','split','export'])$(id).disabled=value;}
function invalidate(message){generation++;controller?.abort();controller=null;observation=null;clearInterval(timer);timer=null;$('observation-section').hidden=true;busy(false);if(message)status(message);}
function assertGeneration(id){if(id!==generation)throw new DOMException('Obsolete UI request','AbortError');}
function integerInput(id,min,max){const value=$(id).value.trim();if(!/^\d{1,20}$/.test(value))throw new Error('INPUT_INTEGER_INVALID');const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error('INPUT_INTEGER_INVALID');return n;}
function formatInteger(n){return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g,',');}
function render(value,source){
  observation=value;clear('pool-rows');clear('summary');clear('rejections');clear('simulation-result');clear('split-result');
  $('observation-section').hidden=false;
  $('anchor').textContent=`${value.anchor.chainId} · block ${value.anchor.number} · ${value.anchor.hash}\n${value.readerIds.join(' / ')}\n観測日時 ${new Date(value.anchor.observedAt).toLocaleString()}`;
  for(const [n,label]of[[value.pools.length,'照合できたプール'],[value.rejected.length,'除外した組合せ'],[source.candidates.length,'署名を確認したFactory候補']]){const m=text('div','', 'metric');m.append(text('strong',String(n)),text('span',label));$('summary').append(m);}
  const ranked=[...value.pools].sort((a,b)=>a.minimumOut>b.minimumOut?-1:a.minimumOut<b.minimumOut?1:a.routeId.localeCompare(b.routeId));
  for(const p of ranked){const tr=document.createElement('tr'),identity=text('td',`${p.feeBps} bps`);identity.append(text('small',short(p.pool)));identity.title=`Pool ${p.pool}\nFactory ${p.factory}`;
    tr.append(identity,text('td',formatInteger(p.expectedOut),'output-number'),text('td',formatInteger(p.minimumOut),'output-number'),text('td','未計算 — 実質比較不可'));$('pool-rows').append(tr);}
  for(const r of value.rejected)$('rejections').append(text('p',`${short(r.factory)} / ${r.feeBps??'—'} bps · ${r.code}`));
  for(const r of source.rejected)$('rejections').append(text('p',`発信者 ${short(r.publicKey)} · ${r.code}`));
  $('rejections').append(text('p','未確認：Factoryの初期化状態・Pool生成由来・Pool実行コード全体の同定・転送税・リベース・ブラックリスト・トークンの更新権限・全ネットワーク費用・RPC運営者の独立性。'));
  const comparison=compareObservedPools(value);
  status(`${value.pools.length}プールを照合しました。費用が未確定のため、最良経路の自動選択はしていません。${comparison.incomplete.length}件が費用比較未完了です。`);
  const tick=()=>{try{assertCurrentObservation(value);$('freshness').textContent=`有効な観測 · 残り${Math.max(0,Math.ceil((value.expiresAt-Date.now())/1000))}秒`;}catch(e){invalidate(errorText(e));}};
  timer=setInterval(tick,250);tick();
}
$('discovery-form').addEventListener('input',()=>invalidate('条件が変わったため、以前の観測を破棄しました。再検証してください。'));
$('cancel').addEventListener('click',()=>invalidate('読み取りを中止しました。取引は送信していません。'));
document.addEventListener('visibilitychange',()=>{if(document.hidden)invalidate('画面を離れたため観測を破棄しました。再検証してください。');});
$('discovery-form').addEventListener('submit',async event=>{
  event.preventDefault();invalidate();const id=generation;controller=new AbortController();const signal=controller.signal;busy(true);
  try{
    const relayPublicKey=$('relay-key').value.trim(),rawKeys=$('publisher-keys').value.trim();
    const publisherKeys=rawKeys?rawKeys.split(/[\s,;]+/):[relayPublicKey],key=JSON.stringify([relayPublicKey,publisherKeys]);
    if(key!==cataloguePolicy){catalogue=new VerifiedCatalogue({relayPublicKey,publisherKeys});cataloguePolicy=key;}
    const chain=$('chain-id').value.trim();if(!/^[1-9][0-9]{0,19}$/.test(chain))throw new Error('CHAIN_ID_INVALID');
    const rawAmount=$('amount-in').value.trim();if(!/^[1-9][0-9]{0,33}$/.test(rawAmount))throw new Error('AMOUNT_INVALID');
    const tiers=$('fee-tiers').value.trim().split(/[\s,;]+/);if(tiers.some(t=>!/^\d{1,3}$/.test(t)))throw new Error('FEE_TIERS_INVALID');
    const req={requestId:'observation-'+crypto.randomUUID(),chainId:'eip155:'+chain,tokenIn:$('token-in').value.trim(),tokenOut:$('token-out').value.trim(),
      amountIn:BigInt(rawAmount),slippageBps:integerInput('slippage-bps',0,1000),feeTiers:tiers.map(Number)};
    const readers=[$('rpc-one').value.trim(),$('rpc-two').value.trim()].map(url=>createReadOnlyRpc(url,{signal}));account=$('account').value.trim();
    status('ノードの応答と元の発信者署名を確認しています…');
    const source=await catalogue.pull(location.origin,{signal,base:location.origin,sameOrigin:true});assertGeneration(id);
    const candidates=source.candidates.filter(c=>c.chainId===req.chainId);if(!candidates.length)throw new Error('NO_CHAIN_CANDIDATES');
    status('2つのRPCで同じブロックを選び、Factory・プール・準備高・見積りを照合しています…');
    const session=await openPinnedReadSession({readers,chainId:req.chainId,signal});
    const value=await observeLocalPools(session,candidates,req);assertGeneration(id);render(value,source);
  }catch(e){if(id===generation){observation=null;$('observation-section').hidden=true;status(errorText(e),true);}}
  finally{if(id===generation)busy(false);}
});
$('simulate').addEventListener('click',async()=>{
  const value=observation;if(!value||working)return;
  if(!account){status('公開アドレスが必要です。入力すると観測を破棄するため、入力後に再検証してください。',true);return;}
  const id=generation;busy(true);clear('simulation-result');
  try{
    for(const p of value.pools){
      assertGeneration(id);const card=text('div','','result-card');
      try{const s=await simulateObservedPool(value,p.routeId,{account,recipient:account});assertGeneration(id);
        card.append(text('h3',`${short(p.pool)} · 読み取り事前確認`),text('p',`実行ガス見積り ${formatInteger(s.gas.gasUnits)} gas × ${formatInteger(s.gas.gasPriceWei)} wei`),
          text('p','追加ネットワーク費用と出力トークンへの換算価格は未確認です。費用控除後の順位・受取残高・本番実行成功を保証しません。'));
      }catch(e){assertGeneration(id);card.append(text('h3',`${short(p.pool)} · 事前確認を停止`),text('p',errorText(e)));}
      $('simulation-result').append(card);
    }
    await recheckObservation(value);assertGeneration(id);status('読み取り事前確認を終了しました。ウォレット接続・承認・署名・送信はしていません。');
  }catch(e){if(id===generation)invalidate(errorText(e));}
  finally{if(id===generation)busy(false);}
});
$('split').addEventListener('click',()=>{
  const value=observation;if(!value||working)return;
  try{let steps=100;while(value.request.amountIn%BigInt(steps)!==0n)steps--;
    const result=planObservedGrossSplit(value,{steps});clear('split-result');const card=text('div','','result-card');
    card.append(text('h3','ガス等を除外した分割案 · 送信不可'),text('p',`探索範囲：照合した${value.pools.length}プール、入力を${steps}等分、最大4経路。1刻み ${formatInteger(value.request.amountIn/BigInt(steps))} 最小単位。`));
    if(result.plan){for(const a of result.plan.allocations)card.append(text('p',`${short(a.routeId.split(':').at(-1))} へ ${formatInteger(a.amountIn)} → 最低受取 ${formatInteger(a.minimumOut)}`));card.append(text('p',`最低受取合計 ${formatInteger(result.plan.minimumOut)}（追加費用は引いていません）`));}
    else card.append(text('p','正の出力を持つ分割案がありません。'));
    card.append(text('p','この有限グリッド内の計算です。市場全体の最適性ではなく、既存Routerから送信できる取引でもありません。'));$('split-result').append(card);
  }catch(e){status(errorText(e),true);}
});
$('export').addEventListener('click',()=>{
  if(!observation||working)return;
  try{const blob=new Blob([observationJson(observation)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='realdex-readonly-observation.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){status(errorText(e),true);}
});
