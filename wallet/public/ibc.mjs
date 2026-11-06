/** IBC owner panel. Uses the main UI's in-memory capability through its API callback only. */
export function createIbcPanel({api,run,message,getGeneration}) {
 const newKey=()=> 'ibc-'+Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
 const $=id=>document.getElementById(id);let revision=0,draft=null,routeDraft=null,currentState=null;
 const el=(tag,value)=>{const e=document.createElement(tag);if(value!==undefined)e.textContent=value;return e;};
 const choices=(id,items)=>{const s=$(id),old=s.value,key=JSON.stringify(items);if(s.dataset.options===key)return;s.replaceChildren(...items.map(([v,t])=>{const o=el('option',t);o.value=v;return o;}));if(items.some(([v])=>v===old))s.value=old;s.dataset.options=key;};
 const action=(name,fn)=>{const b=el('button',name);b.type='button';b.className='subtle';b.addEventListener('click',()=>void run(fn));return b;};
 function clear(){revision++;draft=null;$('ibcApproval').replaceChildren();$('ibcBalanceResult').textContent='入力を変えたため、改めて照合してください。';}
 function render(s){currentState=s;const monitor=s.ibcMonitoring;const status=$('ibcMonitorStatus');if(status)status.textContent=monitor?JSON.stringify({enabled:monitor.enabled,running:monitor.running,reason:monitor.reason,intervalMs:monitor.intervalMs,entries:monitor.entries},null,2):'自動追跡は停止中です。';if(s.locked){if(status)status.textContent='ロック中：自動追跡は停止しました。';clear();$('ibcHistory').replaceChildren();routeDraft=null;return;}choices('ibcAccount',(s.accounts??[]).filter(a=>a.family==='cosmos'&&a.kind==='local').map(a=>[a.id,`${a.label} / ${a.address}`]));choices('ibcRoute',(s.ibcRoutes??[]).map(r=>[r.id,`${r.name} : ${r.source.network.chainId} → ${r.destination.network.chainId}`]));if(draft&&!(s.pending??[]).some(r=>r.id===draft.id)){draft=null;$('ibcApproval').replaceChildren();}}
 function approval(p){const box=$('ibcApproval');box.replaceChildren();const s=p.summary;box.append(el('h3','ブリッジの署名内容を確認'),el('pre',JSON.stringify({source:s.route.source.network.chainId,destination:s.route.destination.network.chainId,channel:s.route.source.channel,receiver:s.recipient,sourceAsset:s.asset,destinationAsset:s.destinationAsset,amountAtomic:s.amountAtomic,feeAtomic:s.feeAtomic,packetDeadlineNs:s.transfer.timeoutTimestamp,requestKey:s.requestKey},null,2)));
  const l=el('label','確認文を全文入力：'+s.confirmationText),confirm=el('input');confirm.id='ibcConfirm';confirm.autocomplete='off';l.append(confirm);const bl=el('label',' 署名の保存後、初回送信も行う'),broadcast=el('input');broadcast.id='ibcBroadcast';broadcast.type='checkbox';broadcast.checked=false;broadcast.disabled=!s.submissionEnabled;bl.prepend(broadcast);box.append(l,bl);
  box.append(action('承認して署名を保存',async()=>{if(draft?.id!==p.id)throw Error('UI_OPERATION_CANCELLED');const result=await api('ibc/approve',{id:p.id,intentId:p.intentId,confirmation:confirm.value,broadcast:broadcast.checked});clear();message('署名と取引履歴を保存しました。受取・返金は履歴で再照合してください。');await history();return result;}),action('署名せず破棄',async()=>{await api('reject',{id:p.id});clear();}));
 }
 async function history(){const epoch=getGeneration(),result=await api('ibc/history');if(epoch!==getGeneration())return;const host=$('ibcHistory');host.replaceChildren();for(const r of result.records){const c=el('article');c.className='request-card';c.append(el('h3',r.summary.route.name+' / '+(r.report?.stage??r.state)),el('p',r.signed.requestId),el('p','受取確認: '+Boolean(r.report?.received)+' / 返金確認: '+Boolean(r.report?.refunded)+' / 独立した確定証明: false'),el('p',r.report?.reason??'署名済み・未送信'));
   const dl=el('label','受取側の中継取引ハッシュ（任意）'),di=el('input');di.value=r.report?.evidenceRefs?.destinationTxHash??'';di.maxLength=64;dl.append(di);const sl=el('label','送信側のACK／タイムアウト処理ハッシュ（任意）'),si=el('input');si.value=r.report?.evidenceRefs?.settlementTxHash??'';si.maxLength=64;sl.append(si);c.append(dl,sl,action('元の取引を読み取り再照合',async()=>{await api('ibc/reconcile',{id:r.id,...(di.value?{destinationTxHash:di.value}:{}),...(si.value?{settlementTxHash:si.value}:{})});await history();}));
   c.append(action('中継取引を自動検出して再照合',async()=>{await api('ibc/track',{id:r.id});await history();}));
   if(r.state!=='signed')c.append(action('この取引の自動追跡を開始',async()=>{await api('ibc/monitor/start',{ids:[r.id]});message('この取引の読み取り追跡を開始しました。署名・中継・再送は行いません。');}));
   if(r.state==='signed'){const cl=el('label','初回送信する取引IDを全文入力'),ci=el('input');cl.append(ci);c.append(cl,action('保存済み署名を初回送信',async()=>{await api('ibc/submit',{id:r.id,confirmation:ci.value});await history();}));}
   if(r.report?.packet)c.append(action('中継用の公開パケット情報を表示',async()=>{const plan=await api('ibc/relay-plan',{id:r.id});$('ibcRelayPlan').textContent=JSON.stringify(plan,null,2);}));host.append(c);
  }if(!result.records.length)host.append(el('p','ブリッジ履歴はありません。'));
 }
 $('ibcForm').addEventListener('input',clear);$('ibcForm').addEventListener('change',clear);
 $('ibcForm').addEventListener('submit',e=>{e.preventDefault();void run(async()=>{const rev=revision,epoch=getGeneration();const p=await api('ibc/prepare',{accountId:$('ibcAccount').value,routeId:$('ibcRoute').value,payment:{requestKey:$('ibcRequestKey').value,receiver:$('ibcRecipient').value,amount:$('ibcAmount').value,feeAtomic:$('ibcFee').value,gasLimit:$('ibcGas').value,timeoutSeconds:Number($('ibcTimeout').value)}});if(rev!==revision||epoch!==getGeneration())throw Error('UI_OPERATION_CANCELLED');if(p.alreadyRecorded){message('同じ依頼は保存済みです。再署名・再送しません。');await history();return;}draft=p;approval(p);});});
 $('ibcBalance').addEventListener('click',()=>void run(async()=>{const rev=revision;const r=await api('ibc/balance',{accountId:$('ibcAccount').value,routeId:$('ibcRoute').value});if(rev!==revision)throw Error('UI_OPERATION_CANCELLED');$('ibcBalanceResult').textContent=JSON.stringify(r,null,2);}));
 $('ibcRefresh').addEventListener('click',()=>void run(history));
 $('ibcMonitorStart').addEventListener('click',()=>void run(async()=>{
  const r=await api('ibc/history'),ids=r.records.filter(x=>x.state!=='signed').map(x=>x.id);
  if(!ids.length||ids.length>16)throw Error('IBC_MONITOR_IDS');
  await api('ibc/monitor/start',{ids});message('署名しない自動追跡を開始しました。結果は追跡欄へ表示します。');
 }));
 // Deliberately bypass the main UI busy flag: a stop must not wait for a slow read.
 $('ibcMonitorStop').addEventListener('click',()=>{void (async()=>{
  try{const r=await api('ibc/monitor/stop');$('ibcMonitorStatus').textContent=JSON.stringify(r,null,2);message('自動追跡を停止しました。チェーン上の処理は取り消されません。');}
  catch{message('追跡の停止を確認できません。必要ならウォレットをロックしてください。',true);}
 })();});

 $('ibcNewKey').addEventListener('click',()=>{clear();$('ibcRequestKey').value=newKey();});$('ibcRequestKey').value=newKey();
 $('ibcRouteJson').addEventListener('input',()=>{routeDraft=null;$('ibcRouteInspect').textContent='変更した設定を再確認してください。';});
 $('ibcInspect').addEventListener('click',()=>void run(async()=>{const original=$('ibcRouteJson').value,result=await api('ibc/routes/inspect',{route:JSON.parse(original)});if(original!==$('ibcRouteJson').value)throw Error('UI_OPERATION_CANCELLED');routeDraft=result;$('ibcRouteInspect').textContent=JSON.stringify(result,null,2);}));
 $('ibcAddRoute').addEventListener('click',()=>void run(async()=>{if(!routeDraft)throw Error('IBC_ROUTE_CONFIRMATION');await api('ibc/routes/add',{route:routeDraft.route,confirmation:$('ibcRouteConfirmation').value});clear();routeDraft=null;message('経路を登録してロックしました。受取・返金の独立した確定証明は未実装です。');}));
 return {render,clear};
}
