import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {slackFullAction} from '../extension/slack-full.js';
const identity={workspace:'https://fixture.slack.com',teamId:'T01234567',userId:'U01234567'};
function fixture(options={}) {
  const calls=[],location={protocol:'https:',hostname:'app.slack.com',origin:'https://app.slack.com',pathname:'/client/E01234567/C01234567'};
  const context=vm.createContext({location,Date,Map,URL,URLSearchParams,AbortSignal,TextEncoder,TextDecoder,Uint8Array,btoa,
    localStorage:{getItem:()=>JSON.stringify({teams:{T01234567:{domain:'fixture',url:identity.workspace,token:'xoxc-synthetic-only'}}})},
    fetch:async(url,init)=>{
      calls.push({url,init});
      if(url.endsWith('/api/auth.test'))return new Response(JSON.stringify({ok:true,url:identity.workspace+'/',team_id:identity.teamId,user_id:options.userId??identity.userId,enterprise_id:'E01234567'}));
      return options.fetch?.(url,init) ?? new Response(JSON.stringify({ok:true,fixture:'unchanged'}));
    },
  });
  const run=vm.runInContext(`(${slackFullAction.toString()})`,context);
  return {calls,location,call:(method,args={params:{}},expected=identity)=>run(method,args,expected,identity.workspace)};
}
test('Enterprise discovery selects the requested workspace and exports no credentials',async()=>{
  const f=fixture();const result=await f.call('account.identify',{},undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{ok:true,result:identity});
  assert(!JSON.stringify(result).includes('xoxc-'));
});
test('all maintained API families return their original response object',async()=>{
  const f=fixture();
  const operations=['auth.test','users.list','users.info','conversations.list','conversations.info','conversations.members','conversations.history','conversations.replies','conversations.genericInfo','users.conversations','search.all','search.messages','files.info','client.userBoot','client.counts','client.dms','im.list','users.prefs.get','search.modules.channels','usergroups.list','usergroups.users.list','saved.list','chat.postMessage','reactions.add','reactions.remove','conversations.mark','conversations.leave','conversations.join','conversations.open','conversations.view','usergroups.create','usergroups.update','usergroups.users.update','saved.update','saved.clearCompleted'];
  for(const method of operations){const result=await f.call('api.'+method);assert.equal(result.ok,true,method);assert.equal(result.result.body.ok,true);}
  for(const method of ['users/info','users/list','users/search','channels/membership'])assert.equal((await f.call('edge.'+method)).ok,true,method);
});
test('write is dispatched once and a lost response remains uncertain',async()=>{
  const f=fixture({fetch:()=>{throw Error('response lost');}});
  const result=await f.call('api.chat.postMessage',{params:{channel:'C01234567',text:'fixture'}});
  assert.equal(result.error,'SAVE_UNVERIFIED');
  assert.equal(f.calls.filter(x=>x.url.endsWith('/chat.postMessage')).length,1);
});
test('rejects changed account, arbitrary methods and caller credential injection',async()=>{
  const f=fixture({userId:'U07654321'});
  assert.equal((await f.call('api.users.list')).ok,false);
  assert.equal(f.calls.length,1);
  const g=fixture();
  for(const [method,args] of [['api.admin.users.remove',{}],['api.chat.postMessage',{params:{token:'xoxc-other'}}],['api.chat.postMessage',{params:{authorization:'other'}}],['edge.https://evil.test',{}]]) assert.equal((await g.call(method,args)).ok,false);
  assert.equal(g.calls.length,0);
});
test('shared attachment downloads require files.info from the same approved account',async()=>{
  const url='https://files.slack.com/files-pri/TOTHER01-F01234567/download/file.txt';
  const binary=Buffer.alloc(2*1024*1024,7);
  const f=fixture({fetch:(target)=>target.endsWith('/files.info')?new Response(JSON.stringify({ok:true,file:{url_private_download:url}})):new Response(binary)});
  assert.equal((await f.call('files.download',{url})).ok,false);
  assert.equal((await f.call('api.files.info',{params:{file:'F01234567'}})).ok,true);
  const result=await f.call('files.download',{url});
  assert.equal(result.ok,true);assert(Buffer.from(result.result.base64,'base64').equals(binary));
  assert.equal((await f.call('files.download',{url:url+'?other=1'})).ok,false);
  assert.equal((await f.call('files.download',{url:'https://evil.test/a'})).ok,false);
});
