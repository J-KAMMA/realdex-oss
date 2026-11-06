import test from 'node:test';
import assert from 'node:assert/strict';
import {processEvidence} from '../lib/acceptance.mjs';
const passed={status:0,signal:null};
const tap='# tests 4\n# pass 4\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
for(const field of ['tests','pass','fail','cancelled','skipped','todo']) {
  test(`Incomplete TAP cannot imply zero ${field}`,()=>{
    assert.equal(processEvidence(passed,tap.replace(new RegExp('^# '+field+' [0-9]+\\n','m'),''),{requireTap:true}).status,'failed');
  });
}
for(const field of ['tests','pass','fail','cancelled','skipped','todo']) {
  test(`Duplicate TAP summary field ${field} cannot be ignored`,()=>{
    const value=field==='tests'||field==='pass'?4:0;
    assert.equal(processEvidence(passed,tap+`# ${field} ${value}\n`,{requireTap:true}).status,'failed');
  });
}
test('Multiple concatenated TAP runs cannot be counted as one success',()=>{
  assert.equal(processEvidence(passed,tap+tap,{requireTap:true}).status,'failed');
});
test('Unsafe integer test counts cannot be accepted as completed evidence',()=>{
  assert.equal(processEvidence(passed,tap.replaceAll('4','9007199254740992'),{requireTap:true}).status,'failed');
});
test('Valid CRLF TAP summary remains accepted',()=>{
  assert.equal(processEvidence(passed,tap.replaceAll('\n','\r\n'),{requireTap:true}).status,'passed');
});
