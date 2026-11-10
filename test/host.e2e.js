import { promisify } from 'node:util'
const execute=promisify(execFile)
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { randomUUID, createHmac } from 'node:crypto'
import { mkdir, writeFile, readFile, lstat, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { webhookSignature } from '../src/adapter.js'
import { browserEvidence } from '../scripts/browser-evidence.mjs'

const root=process.cwd(),token='synthetic-local-test-operator-token',secret='synthetic-test-hmac-only'
const config={adapter:'signed-webhook',account:'loopback-account',allowedActors:['alice'],allowedRooms:['synthetic-room'],selfActor:'bot'}
async function until(fn,ms=15000){const start=Date.now();while(Date.now()-start<ms){const value=await fn();if(value)return value;await delay(80)}throw Error('timed out')}

test('pinned real DSH host: native Team/tools, HTTP transport, stop and reopen',{timeout:120000},async t=>{
  const dir=join(root,'.acceptance','host-e2e-'+randomUUID()),app=join(dir,'app'),home=join(dir,'home')
  await mkdir(join(app,'config'),{recursive:true});await mkdir(join(dir,'tmp'))
  const projects=[{id:'a',name:'非 Git 资料 A',root:'projects/a'},{id:'b',name:'非 Git 资料 B',root:'projects/b'}]
  for(const p of projects){await mkdir(join(app,p.root),{recursive:true});await writeFile(join(app,p.root,'input.txt'),'existing synthetic project '+p.id)}
  await writeFile(join(app,'config/projects.json'),JSON.stringify({projects}));await writeFile(join(app,'config/ingress.json'),JSON.stringify(config))
  const overlay=join(dir,'probe.yml');await writeFile(overlay,`- insert:\n    - id: acceptance-probe\n      name: ${join(root,'test/native-probe.js')}\n`)
  let accept=false,records=[]
  const receiver=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;records.push({url:req.url,headers:req.headers,payload:JSON.parse(raw),raw,status:accept?200:503});res.writeHead(accept?200:503);res.end('local recording receiver')})
  await new Promise(r=>receiver.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>receiver.close(r)))
  const receiverUrl=`http://127.0.0.1:${receiver.address().port}/recorded-replies`
  const env={PATH:process.env.PATH || '',LANG:'C.UTF-8',DSH_HOME:home,DSH_AGENTS_HOME:join(home,'agents'),TMPDIR:join(dir,'tmp'),DSH_WORKBENCH_ROOT:app,DSH_WORKBENCH_TOKEN:token,DSH_WORKBENCH_INGRESS_SECRET:secret,DSH_WORKBENCH_OUTBOUND_SECRET:secret,DSH_WORKBENCH_OUTBOUND_URL:receiverUrl}
  await execute(process.execPath,['scripts/prepare-profile.mjs'],{cwd:root,env})
  let child,origin,logs=''
  async function boot(){let output='';child=spawn(process.execPath,['node_modules/@deepseek-ai/dsh/lib/bin.js','--profile','workbench','--patch',overlay,'--host','127.0.0.1','--port','0','--no-open'],{cwd:root,env,stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output+=b;logs+=b.toString().replace(/([?&]token=)[^\s]+/g,'$1[redacted]')});origin=await until(()=>{if(child.exitCode!==null)throw Error('DSH exited: '+output);return /dsh web: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1]});await until(async()=>{const r=await fetch(origin+'/workbench/api/tasks',{headers:{authorization:'Bearer '+token}});return r.status===200});return origin}
  async function halt(signal='SIGINT'){if(!child||child.exitCode!==null)return;const c=child;c.kill(signal);await until(()=>c.exitCode!==null||c.signalCode!==null,15000)}
  t.after(async()=>{await halt();await writeFile(join(root,'evidence/dashboard-v0.2/host.log'),logs)})
  const request=async(path,{method='GET',body,authorized=true,originHeader=true}={})=>{const r=await fetch(origin+path,{method,headers:{'content-type':'application/json',...(authorized?{authorization:'Bearer '+token}:{}),...(originHeader?{origin}:{} )},...(body!==undefined?{body:JSON.stringify(body)}:{})});const raw=await r.text();let data;try{data=JSON.parse(raw)}catch{data=raw}return {status:r.status,data}}
  const create=async(projectId=null)=>{const r=await request('/workbench/api/tasks',{method:'POST',body:{text:'整理合成资料并提出问题 '+(projectId||'general'),projectId}});assert.equal(r.status,201,JSON.stringify(r));return r.data}
  const probe=async(taskId,kind)=>request('/__acceptance/probe',{method:'POST',body:{taskId,kind}})
  const signedHeaders=(extra={})=>{const h={'x-dsh-timestamp':String(Math.floor(Date.now()/1000)),'x-dsh-actor':'alice','x-dsh-room':'synthetic-room','x-dsh-event-id':'source-event-1','x-dsh-thread':'original-thread','x-dsh-addressed':'direct',...extra};return h}
  const signed=async(h,body={text:'来自签名桥的通用研究任务'},signature)=>{const raw=JSON.stringify(body);const r=await fetch(origin+'/workbench/ingress/webhook',{method:'POST',headers:{'content-type':'application/json',...h,'x-dsh-signature':signature||webhookSignature(config,secret,h,raw)},body:raw});return {status:r.status,data:await r.json()}}
  await boot()
  assert.equal((await request('/workbench/api/tasks',{authorized:false})).status,401)
  assert.equal((await request('/workbench/api/tasks',{method:'POST',originHeader:false,body:{text:'x'}})).status,403)
  assert.equal((await request('/workbench/api/tasks',{method:'POST',body:{text:'x',role:'admin'}})).status,400)
  assert.equal((await request('/workbench/api/tasks',{method:'POST',body:{text:'x'.repeat(40000)}})).status,413)
  assert.equal((await request('/workbench')).status,200)
  assert.equal((await request('/workbench/api/overview',{authorized:false})).status,401)
  const emptyOverview=await request('/workbench/api/overview');assert.equal(emptyOverview.data.total,0)

  // Use a wire-controlled Host header; fetch/undici may replace the override.
  const deniedHost=await new Promise((resolve,reject)=>{
    const req=httpRequest(origin+'/workbench/api/overview',{headers:{authorization:'Bearer '+token,host:'untrusted.invalid'}},res=>{
      let raw='';res.setEncoding('utf8');res.on('data',chunk=>raw+=chunk);res.on('error',reject)
      res.on('end',()=>resolve({status:res.statusCode,raw}))
    })
    req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('Host-header negative request timed out')));req.end()
  })
  assert.equal(deniedHost.status,403)
  assert.deepEqual(JSON.parse(deniedHost.raw),{error:'host denied'})
  assert.equal((await fetch(origin+'/workbench/api/tasks',{method:'POST',headers:{authorization:'Bearer '+token,origin:'http://untrusted.invalid','content-type':'application/json'},body:JSON.stringify({text:'denied'})})).status,403)
  const a=await create('a'),b=await create('b'),general=await create()
  assert.notEqual(a.task.workspace,b.task.workspace);assert.equal(a.task.workspace,join(app,'projects/a'));assert.equal(b.native.effectiveCwd,join(app,'projects/b'))
  assert.equal(await readFile(join(a.native.effectiveCwd,'input.txt'),'utf8'),'existing synthetic project a')
  await assert.rejects(lstat(join(a.task.workspace,'.git')));await assert.rejects(lstat(join(b.task.workspace,'.git')));await assert.rejects(lstat(join(general.task.workspace,'.git')))
  assert.equal(a.native.membership.role,'lead');assert.equal(a.native.membership.id,a.task.sessionId);assert.equal(a.native.tasks.length,1);assert.equal(a.native.tasks[0].revision,1)
  assert.ok(a.native.tools.includes('read'), 'native project filesystem tools must be composed');assert.ok(a.native.tools.includes('spawn_teammate'));assert.ok(a.native.tools.includes('workbench_report'));assert.equal(a.native.model.status,'missing-model');assert.equal(a.native.receivedInputIds.length,1)
  const nativeRead=await probe(a.task.id,'read');assert.equal(nativeRead.data.results.results[0].result.isError,false,JSON.stringify(nativeRead));assert.ok(JSON.stringify(nativeRead.data).includes('existing synthetic project a'));
  const nativeReport=await probe(general.task.id,'report');assert.equal(nativeReport.status,200,JSON.stringify(nativeReport));assert.equal(nativeReport.data.results.results[0].result.isError,false,JSON.stringify(nativeReport))
  assert.equal(nativeReport.data.persisted.id,general.task.sessionId)
  const artifact=await probe(general.task.id,'artifact');assert.equal(artifact.data.results.results[0].result.isError,false,JSON.stringify(artifact))
  const reportView=(await request('/workbench/api/tasks/'+general.task.id)).data
  assert.equal(reportView.task.displayState,'question');assert.ok(reportView.records.some(r=>r.kind==='report'))
  const answer=await request('/workbench/api/tasks/'+general.task.id+'/followups',{method:'POST',body:{text:'Use the first source'}})
  assert.equal(answer.data.task.displayState,'missing-model');assert.equal(answer.data.task.sessionId,general.task.sessionId)
  const query=await request('/workbench/api/overview?project=a&search='+encodeURIComponent('合成'))
  assert.equal(query.data.total,1);assert.equal(query.data.tasks[0].id,a.task.id);assert.equal(Object.values(query.data.counts).reduce((a,b)=>a+b,0),query.data.total)
  const registered=(await request('/workbench/api/tasks/'+general.task.id)).data.task.artifacts[0]
  assert.equal((await request('/workbench/api/tasks/'+general.task.id+'/artifacts/'+registered.id)).data,'synthetic verified file\n')
  const preview=await request('/workbench/api/tasks/'+general.task.id+'/artifacts/'+registered.id+'?preview=1')
  assert.equal(preview.data.text,'synthetic verified file\n');assert.equal(preview.data.type,'text/plain')
  await probe(general.task.id,'change-artifact')
  assert.equal((await request('/workbench/api/tasks/'+general.task.id+'/artifacts/'+registered.id)).status,409)
  assert.equal((await request('/workbench/api/tasks/'+general.task.id+'/artifacts/'+registered.id+'?preview=1')).status,409)
  await probe(general.task.id,'artifact')
  await probe(b.task.id,'blocked');assert.equal((await request('/workbench/api/overview?state=blocked')).data.counts.blocked,1)
  const escaped=await probe(general.task.id,'escape');assert.equal(escaped.data.results.results[0].result.isError,true)
  const foreign=await probe(general.task.id,'foreign');assert.equal(foreign.data.results.results[0].result.isError,true)
  const h=signedHeaders(),raw=JSON.stringify({text:'来自签名桥的通用研究任务'}),sig=webhookSignature(config,secret,h,raw)
  const first=await signed(h);assert.equal(first.status,202,JSON.stringify(first));const duplicate=await signed(h);assert.equal(duplicate.status,200);assert.equal(duplicate.data.taskId,first.data.taskId)
  assert.equal((await signed({...h,'x-dsh-thread':'tampered'},undefined,sig)).status,401);const recorrelation=await signed({...h,'x-dsh-thread':'changed-with-new-signature'});assert.equal(recorrelation.data.taskId,first.data.taskId)
  assert.equal((await signed(signedHeaders({'x-dsh-actor':'outsider'}))).status,403)
  assert.equal((await signed(signedHeaders({'x-dsh-room':'outside'}))).status,403)
  assert.equal((await signed(signedHeaders({'x-dsh-bot':'true'}))).status,403)
  assert.equal((await signed(signedHeaders(),{text:'x',destination:'evil'})).status,400)
  await until(()=>records.length)
  const outboxId=records[0].payload.id
  await halt('SIGKILL');accept=true;await boot()
  await until(()=>records.some(r=>r.status===200&&r.payload.id===outboxId))
  const delivered=records.find(r=>r.status===200&&r.payload.id===outboxId)
  assert.equal(delivered.url,'/recorded-replies');assert.equal(delivered.payload.destination.conversation,'synthetic-room');assert.equal(delivered.payload.destination.thread,'original-thread');assert.equal(delivered.payload.destination.message,'source-event-1');assert.equal(delivered.payload.taskId,first.data.taskId);assert.equal(delivered.payload.content,'已接收任务：来自签名桥的通用研究任务')
  assert.equal(delivered.headers['x-dsh-signature'],'sha256='+createHmac('sha256',secret).update(outboxId+'.'+delivered.raw).digest('hex'))
  const reloaded=(await request('/workbench/api/tasks/'+first.data.taskId)).data
  assert.equal(reloaded.task.sessionId,first.data.sessionId);assert.equal(reloaded.native.receivedInputIds.length,1);assert.equal(reloaded.native.pendingInputIds.length,1,'unconsumed original input must remain pending after reopen')
  const follow=await request('/workbench/api/tasks/'+first.data.taskId+'/followups',{method:'POST',body:{text:'reopened follow-up'}})
  assert.equal(follow.status,200,JSON.stringify(follow));assert.equal(follow.data.task.sessionId,first.data.sessionId);assert.equal(follow.data.native.receivedInputIds.length,2);assert.equal(follow.data.task.channel.thread,'original-thread')
  assert.equal((await signed(h)).data.taskId,first.data.taskId)
  await halt();await boot();const resumedAgain=(await request('/workbench/api/tasks/'+first.data.taskId)).data;assert.equal(resumedAgain.native.pendingInputIds.length,2);assert.equal(resumedAgain.native.receivedInputIds.length,2)
  const signedFollow=signedHeaders({'x-dsh-task-id':first.data.taskId,'x-dsh-event-id':'followup-event'});assert.equal((await signed(signedFollow,{text:'signed follow-up'})).status,202);assert.equal((await signed(signedFollow,{text:'signed follow-up'})).data.duplicate,true);assert.equal((await request('/workbench/api/tasks/'+first.data.taskId)).data.native.receivedInputIds.length,3)
  accept=false;await probe(first.data.taskId,'report');const pendingReport=await until(()=>records.find(r=>r.payload.taskId===first.data.taskId&&r.payload.content.startsWith('ready:')));
  await probe(first.data.taskId,'maintenance')
  const stopped=await request('/workbench/api/tasks/'+first.data.taskId+'/stop',{method:'POST',body:{}});assert.equal(stopped.status,200,JSON.stringify(stopped));assert.equal(stopped.data.task.state,'stopped');accept=true;await delay(500);assert.equal(records.filter(r=>r.payload.id===pendingReport.payload.id&&r.status===200).length,0)
  assert.equal((await probe(first.data.taskId,'status')).data.aborted,true)
  const late=await probe(first.data.taskId,'late');assert.equal(late.data.lateEnqueue,false);assert.equal(late.data.results.results[0].result.isError,true)
  assert.equal((await request('/workbench/api/tasks/'+first.data.taskId+'/followups',{method:'POST',body:{text:'late'}})).status,409)
  const sameReplay=await signed(h);assert.equal(sameReplay.data.taskId,first.data.taskId);assert.equal((await request('/workbench/api/tasks/'+first.data.taskId)).data.task.state,'stopped')
  const browser=await browserEvidence(origin,token,dir,env)
  await writeFile(join(root,'evidence/dashboard-v0.2/browser-result.json'),JSON.stringify(browser,null,2))
  await halt()
  const state=JSON.parse(await readFile(join(app,'.workbench/data/state.json'),'utf8'))
  assert.equal(state.outbox.find(row=>row.id===pendingReport.payload.id).status,'dropped')
  assert.equal(Object.values(state.tasks).filter(t=>t.channel.message==='source-event-1').length,1)
  await writeFile(join(root,'evidence/dashboard-v0.2/host-readback.json'),JSON.stringify({fixture:dir,nativeProject:a,nativeGeneral:general,nativeToolReport:nativeReport.data,nativeRead:nativeRead.data,reopened:reloaded,followup:follow.data,stopped:stopped.data,transport:delivered,taskCount:Object.keys(state.tasks).length},null,2))
  console.log('REAL DSH evidence: '+dir+'; native sessions, DAG, scoped tools, signed adapter retry/reopen, immutable follow-up, cancellation and stop passed')
})
