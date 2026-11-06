import {extendedRegistry,extendedCapabilities} from '/node/extended/registry.mjs';
import {observeExtended} from '/node/extended/observe.mjs';
import {observeIcrcLedger} from '/node/icp/reader.mjs';
import {extensionError} from '/node/extended/guard.mjs';
const $=id=>document.getElementById(id);let registry,ledgers=[],controller=null,revision=0,timer;
function invalidate(message='入力が変わりました。以前の結果は無効です。'){revision++;controller?.abort();controller=null;clearTimeout(timer);$('result').textContent='未実行';$('cancel').disabled=true;$('run').disabled=!registry;$('status').textContent=message;}
function selected(){return $('mode').value==='icrc'?null:registry.get($('selection').value);}
function render(){invalidate();const icrc=$('mode').value==='icrc',p=icrc?null:selected();
 $('endpoints').placeholder=icrc?'http://127.0.0.1:4943':p.family==='icp'?'http://127.0.0.1:8081':p.family==='monero'?'http://127.0.0.1:18081/json_rpc':p.family==='cometbft'?'http://127.0.0.1:26657':p.family==='utxo-core'?'http://127.0.0.1:8232':'http://127.0.0.1:8545';
 $('selectedTitle').textContent=icrc?'ICRC台帳メタデータ':p.name;$('chainFields').hidden=icrc;$('checkpointRow').hidden=icrc||p.family!=='cometbft';$('ledgerFields').hidden=!icrc&&p.family!=='icp';$('rosettaRow').hidden=icrc;
 if(icrc){const l=ledgers.find(x=>x.canister===$('selection').value);$('ledger').value=l.canister;$('description').textContent='台帳IDを指定して、名前・記号・桁数・手数料・対応規格を2回読みます。未認証のquery応答であり、暗号学的な証明ではありません。テスト元資産の台帳もICPメインネット上です。';}
 else{const c=extendedCapabilities(p);$('description').textContent=`${p.id} / ${p.family}\n申告上の方式：${c.privacyModel}。${p.family==='icp'?'ICP全体のブロックではなく、選んだ台帳の取引記録を照合します。':'独立に確認した初期ハッシュまたはチェックポイントで接続先を区別します。'} 実チェーン動作は未検証です。`;
 $('pin').value=p.genesisHash??'';}
}
function options(){invalidate();$('selection').replaceChildren();const values=$('mode').value==='icrc'?ledgers.map(l=>[l.canister,l.label]):registry.list().map(p=>[p.id,p.name]);
 for(const [value,label]of values){const o=document.createElement('option');o.value=value;o.textContent=label;$('selection').append(o);}$('endpoints').value='';$('remote').checked=false;render();}
for(const id of ['endpoints','remote','pin','checkpointHeight','ledger','networkFormat'])$(id).addEventListener('input',()=>invalidate());
$('mode').addEventListener('change',options);$('selection').addEventListener('change',()=>{$('endpoints').value='';$('remote').checked=false;render();});
$('privateRegistry').addEventListener('change',async()=>{
 invalidate('ローカル設定を検査しています。');const run=revision;
 try{const file=$('privateRegistry').files?.[0];if(!file)return;if(file.size>2097152)throw Error('REGISTRY_SIZE_LIMIT');
  const imported=extendedRegistry(JSON.parse(await file.text()));if(revision!==run)return;
  if(imported.size===0||imported.list().some(p=>!p.restricted))throw Error('PRIVATE_REGISTRY_REQUIRED');
  const combined=extendedRegistry({schema:'realdex.extended-networks.v1',profiles:[...registry.list(),...imported.list()]});
  registry=combined;$('profileCount').textContent=String(registry.size);$('mode').value='network';options();$('selection').value=imported.list()[0].id;render();
  $('status').textContent='私設ネットワーク設定をこの画面にだけ追加しました。接続先の問い合わせはまだ行っていません。';
 }catch(e){if(revision===run)$('status').textContent='設定を追加できませんでした：'+extensionError(e);}
 finally{$('privateRegistry').value='';}
});
$('cancel').addEventListener('click',()=>invalidate('中止しました。結果は破棄しました。'));
$('form').addEventListener('submit',async e=>{e.preventDefault();if(!registry)return;invalidate();const run=revision;controller=new AbortController();$('run').disabled=true;$('cancel').disabled=false;$('status').textContent='許可した接続先だけを読み取っています。';
 try{const endpoints=$('endpoints').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean),origins=[...new Set(endpoints.map(s=>new URL(s).origin))].filter(o=>!['127.0.0.1','[::1]'].includes(new URL(o).hostname));
  const access=$('remote').checked&&origins.length?{mode:'explicit-remote',allowedOrigins:origins}:{mode:'local-only'};let result;
  if($('mode').value==='icrc')result=await observeIcrcLedger({network:'icp:mainnet',ledger:$('ledger').value.trim(),endpoints,access,signal:controller.signal});
  else{const p=selected(),params={profile:p,endpoints,access,signal:controller.signal};if(p.family==='cometbft')params.identityAnchor={height:$('checkpointHeight').value,hash:$('pin').value.trim()};else params.genesisPin=$('pin').value.trim();
   if(p.family==='icp')params.ledger={canister:$('ledger').value.trim(),networkFormat:$('networkFormat').value};result=await observeExtended(params);}
  if(revision!==run)return;$('result').textContent=JSON.stringify(result,null,2);$('status').textContent='読み取り完了。応答の観測結果であり、署名・送信・匿名性の保証はありません。';
  timer=setTimeout(()=>{if(revision===run)invalidate('有効期限が切れました。再照合してください。');},Math.max(0,result.expiresAt-Date.now()));
 }catch(error){if(revision===run){$('result').textContent='結果なし';$('status').textContent='照合できませんでした：'+extensionError(error);}}
 finally{if(revision===run){controller=null;$('run').disabled=false;$('cancel').disabled=true;}}
});
try{const read=async url=>{const r=await fetch(url,{credentials:'omit',redirect:'error',cache:'no-store'});if(!r.ok)throw Error('REGISTRY_READ_FAILED');return r.json();};
 registry=extendedRegistry(await read('/node/extended/networks.json'));ledgers=(await read('/node/icp/ledgers.json')).ledgers;
 $('profileCount').textContent=String(registry.size);$('ledgerCount').textContent=String(ledgers.length);options();$('status').textContent='読み取り対象を選び、利用者自身が管理・確認した接続先を指定してください。';
}catch(e){$('run').disabled=true;$('status').textContent='読み込み失敗：'+extensionError(e);}
