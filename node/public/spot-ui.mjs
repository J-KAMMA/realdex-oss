import {createObservationSession}from'./external/observer.mjs';import {quoteSpot}from'./external/quote.mjs';import {units,format,need}from'./external/math.mjs';import {demoSnapshot}from'./external/demo.mjs';
const el=id=>document.getElementById(id),session=createObservationSession();let snapshot=null,generation=0,timer=null,mode='';
const message=s=>{el('status').textContent=s;};
function clear(text='入力が変わったため、古い観測・試算を消去しました。'){generation++;session.cancel();clearTimeout(timer);snapshot=null;el('output').hidden=true;el('calculate').disabled=true;message(text);}
function receive(value,label){snapshot=value;mode=label;el('calculate').disabled=false;message('観測しました。入力条件を確認して試算できます。注文は送信しません。');clearTimeout(timer);timer=setTimeout(()=>clear('観測値の有効期間が終了しました。板を取得し直してください。'),Math.max(0,value.expiresAt-Date.now()+1));calculate();}
function calculate(){if(!snapshot)return;try{const side=el('side').value,m=snapshot.market,inputAtomic=units(el('amount').value,side==='sell-base'?m.base.decimals:m.quote.decimals).toString(),r=quoteSpot(snapshot,{side,inputAtomic,limitPrice:el('limit').value});
 el('pair').textContent=m.ticker;el('mode').textContent=mode;el('identity').textContent=`${m.provider} / ${m.network} / ${m.id}\n受取残高の場所: ${m.balanceLocation}`;
 el('net').textContent=r.estimatedOutputAfterTradingFeeAtomic===null?'未計算（手数料・条件不足）':`${format(r.estimatedOutputAfterTradingFeeAtomic,r.outputAsset.decimals)} ${r.outputAsset.symbol}`;
 el('remaining').textContent=`${format(r.remainingInputAtomic,r.inputAsset.decimals)} ${r.inputAsset.symbol}`;el('fill').textContent=r.fillStatus;
 el('limits').textContent='表示は板を消費した場合の試算です。全体費用・出金・実約定・最終着金は保証しません。';el('details').textContent=JSON.stringify({snapshot,estimate:r},null,2);el('output').hidden=false;
 }catch(e){el('output').hidden=true;message(/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'入力を確認してください。');}}
for(const id of ['provider','network','endpoint','market','consent'])el(id).addEventListener('input',()=>clear());
for(const id of ['side','amount','limit'])el(id).addEventListener('input',()=>{el('output').hidden=true;message('数量条件が変わりました。「この板で試算」を押してください。');});
el('stop').addEventListener('click',()=>clear('停止しました。表示データも消去しました。'));
el('demo').addEventListener('click',()=>{clear();receive(demoSnapshot(el('provider').value),'架空データ / 通信なし');});
el('calculate').addEventListener('click',calculate);
el('observe').addEventListener('click',async()=>{clear('板を取得しています。');const mine=generation;try{need(el('consent').checked,'SPOT_CONSENT_REQUIRED');const endpoint=el('endpoint').value,u=new URL(endpoint),local=['127.0.0.1','[::1]'].includes(u.hostname),provider=el('provider').value;
 const result=await session.run({provider,endpoint,network:el('network').value,...(provider==='injective'?{marketId:el('market').value}:{pairIndex:el('market').value})},{access:local?{}:{mode:'explicit-remote',allowedOrigins:[u.origin]}});
 if(mine===generation)receive(result,'接続先の未認証観測');}catch(e){if(mine===generation)message(/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'接続または応答の検査に失敗しました。');}});
window.addEventListener('pagehide',()=>clear('終了しました。'));
