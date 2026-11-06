import {makeRegistry,capabilities,FAMILIES} from '/node/chains/registry.mjs';
import {observeChain} from '/node/chains/observation.mjs';
import {safeError} from '/node/chains/core.mjs';
const $=id=>document.getElementById(id);let registry,selected,controller,revision=0,expiryTimer;
const status=message=>{$('status').textContent=message;};
function invalidate(){revision++;controller?.abort();controller=null;clearTimeout(expiryTimer);$('run').disabled=!selected;$('cancel').disabled=true;$('result').textContent='未実行';status('入力が変更されました。以前の結果は無効です。');}
function choose(p){invalidate();selected=p;$('selectedName').textContent=p.name;$('selectedId').textContent=p.id;
 const c=capabilities(p);$('capability').textContent=`${p.family}専用の読み取り照合。${p.family==='evm'?'Factory / Pool / Router の既存ソースあり。実コンパイル・配置検証は別工程。':'この系統のネイティブPool契約と取引送信は未実装。'}`;
 $('pinRequirement').textContent=c.identityPinRequired?'（必須）':'（任意）';$('genesis').required=c.identityPinRequired;$('genesis').value=p.genesisHash??'';$('endpoints').value='';$('run').disabled=false;render();}
function render(){if(!registry)return;const query=$('search').value.toLowerCase(),family=$('family').value,environment=$('environment').value;
 const matches=registry.list().filter(p=>(!query||(p.name+' '+p.id).toLowerCase().includes(query))&&(!family||p.family===family)&&(!environment||p.environment===environment));
 $('shownCount').textContent=`${matches.length} 件`;$('rows').replaceChildren();for(const p of matches){const button=document.createElement('button');button.type='button';button.className='chain';button.setAttribute('role','listitem');button.setAttribute('aria-pressed',String(selected?.id===p.id));
 const span=document.createElement('span'),name=document.createElement('b'),id=document.createElement('small'),tag=document.createElement('em');name.textContent=p.name;id.textContent=p.id+' · '+p.environment;tag.textContent=p.family;span.append(name,id);button.append(span,tag);button.addEventListener('click',()=>choose(p));$('rows').append(button);}}
$('search').addEventListener('input',render);$('family').addEventListener('change',render);$('environment').addEventListener('change',render);
for(const id of ['endpoints','genesis'])$(id).addEventListener('input',invalidate);
$('cancel').addEventListener('click',()=>{invalidate();status('中止しました。結果は破棄しました。');});
$('probe').addEventListener('submit',async e=>{e.preventDefault();if(!selected)return;invalidate();const version=revision;controller=new AbortController();$('run').disabled=true;$('cancel').disabled=false;status('利用者指定のRPCを照合しています。');
 try{const result=await observeChain({profile:selected,endpoints:$('endpoints').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean),...($('genesis').value.trim()?{genesisPin:$('genesis').value.trim()}:{}),signal:controller.signal});
  if(version!==revision)return;$('result').textContent=JSON.stringify(result,null,2);status(result.assurance.freshnessEstablished?'RPCの観測結果は一致しました。送信許可ではありません。':'RPC結果は一致しましたが、ブロックの鮮度は未確認です。');
  expiryTimer=setTimeout(()=>{if(version===revision){$('result').textContent='期限切れ：結果を破棄しました。';status('再照合が必要です。');}},Math.max(0,result.expiresAt-Date.now()));
 }catch(error){if(version===revision){$('result').textContent='結果なし';status('照合できませんでした：'+safeError(error));}}
 finally{if(version===revision){controller=null;$('run').disabled=false;$('cancel').disabled=true;}}
});
try{const response=await fetch('/node/chains/profiles.json',{credentials:'omit',redirect:'error',cache:'no-store'});if(!response.ok)throw Error('REGISTRY_READ_FAILED');registry=makeRegistry(await response.json());
 $('networkCount').textContent=String(registry.size);$('familyCount').textContent=String(FAMILIES.length);for(const family of FAMILIES){const o=document.createElement('option');o.value=family;o.textContent=family;$('family').append(o);}choose(registry.get('eip155:1'));status('ネットワーク候補を読み込みました。取引機能は無効です。');
}catch(error){$('run').disabled=true;status('設定を読み込めません：'+safeError(error));}
