// Real pinned DSH Agent/Session/Team/tool executor and JSONL persistence.
// Only the HTTP listener is replaced with a route collector (sandbox denies sockets).
// All tool calls are synthetic direct invocations, never model intelligence.
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {Readable} from 'node:stream'
import {pathToFileURL} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'
import {randomUUID} from 'node:crypto'
import {boot,loadOverlayPatches} from '@deepseek-ai/dsh-app-boot'

const root=process.cwd()
test('real DSH coordinator / executor lifecycle, routing, role guards and restart',{timeout:45000},async t=>{
 const dir=await mkdtemp(join(root,'.acceptance/san-'))
 await mkdir(join(dir,'config'));await writeFile(join(dir,'config/projects.json'),JSON.stringify({projects:[]}));await writeFile(join(dir,'empty.yml'),'[]')
 const core=new Set(['timer','llm','session','agent','session-persistence-jsonl','working-directory','session-projection','storage','storage-json','storage-domain','session-projection-cache','subprocess','sandbox','sandbox-policy','bash-sandbox','approval','permission','shell-env','subagent','subagent-spawn-in-process','subagent-fork-in-process','tools','tool-executor-native','system-prompt','agent-loop','fs-sandbox','typert','typert-loader'])
 const base=loadOverlayPatches('test',join(root,'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml')).flatMap(p=>p.insert||[]).filter(p=>core.has(p.id))
 for(const row of base)if(row.id==='session-persistence-jsonl')row.config={root:join(dir,'sessions')};else if(row.id==='storage-json')row.config={root:join(dir,'storages')}
 const own=loadOverlayPatches('test',join(root,'cordis.patch.yml')).flatMap(p=>p.insert||[])
 const production=own.find(r=>r.id==='dsh-workbench');production.config={root:dir,stateFile:'state.json',projectsFile:'config/projects.json',ingressFile:'config/none.json'}
 const rows=[...base,{id:'presets',name:'@deepseek-ai/dsh-agent-preset-registry',config:{default:'workbench'}},...loadOverlayPatches('test',join(root,'node_modules/@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml')).flatMap(p=>p.insert||[]).filter(p=>p.id!=='ui-agent-team'),...own]
 let ctx
 const routes=[]
 const syntheticEnv={DSH_WORKBENCH_TOKEN:'synthetic-socketless-local-token',DSH_WORKBENCH_COORDINATOR_PROVIDER:'synthetic-coordinator-unavailable',DSH_WORKBENCH_COORDINATOR_MODEL:'synthetic-c',DSH_WORKBENCH_EXECUTOR_PROVIDER:'synthetic-executor-unavailable',DSH_WORKBENCH_EXECUTOR_MODEL:'synthetic-e'}
 const previous=Object.fromEntries(Object.keys(syntheticEnv).map(k=>[k,process.env[k]]));Object.assign(process.env,syntheticEnv)
 t.after(()=>{for(const [key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value})
 async function start(){ctx=await boot('superagent-test',join(dir,'empty.yml'),[{insert:rows}],ctx=>{ctx.provide('webServer',{host:'127.0.0.1',getOrigin:()=> 'http://127.0.0.1:3080',register:row=>{routes.push(row);return()=>{const i=routes.indexOf(row);if(i>=0)routes.splice(i,1)}}})},pathToFileURL(root+'/').href);for(let i=0;i<200&&!ctx.workbench;i++)await delay(20);if(!ctx.workbench)throw Error('production plugin did not activate: '+JSON.stringify(ctx.loader.entries().filter(e=>!e.fiber?.uid).map(e=>({id:e.id,name:e.options?.name}))));return ctx.workbench}
 t.after(async()=>{await ctx?.fiber.dispose();await rm(dir,{recursive:true,force:true})})
 const app=await start()
 const request=async(path,{method='GET',headers={},body}={})=>{
  const row=routes.find(r=>r.kind==='exact'&&r.path===path);assert.ok(row)
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{method,url:path,headers:{host:'127.0.0.1:3080',authorization:'Bearer '+syntheticEnv.DSH_WORKBENCH_TOKEN,origin:'http://127.0.0.1:3080','content-type':'application/json',...headers}})
  const res={status:200,writeHead(status){this.status=status;this.headersSent=true},end(raw){this.data=JSON.parse(raw)},destroy(){throw Error('unexpected destroy')}}
  await row.handler(req,res);return res
 }
 assert.equal((await request('/workbench/api/coordinator',{headers:{authorization:''}})).status,401)
 assert.equal((await request('/workbench/api/coordinator',{headers:{host:'evil.invalid'}})).status,403)
 assert.equal((await request('/workbench/api/coordinator',{method:'POST',headers:{origin:'http://evil.invalid'},body:{key:'evil',text:'denied'}})).status,403)
 assert.equal((await request('/workbench/api/coordinator',{method:'POST',body:{text:'missing stable key'}})).status,400)
 assert.equal((await request('/workbench/api/coordinator')).status,200)
 const manager=await app.coordinator.ensure(),canonical=manager.id
 const invoke=async(agent,name,args,callId=randomUUID())=>{
  const signal=new AbortController().signal
  const toolSet=await ctx.tools.resolve({agent,modelSelection:{provider:'synthetic-not-configured',model:'synthetic'},signal})
  try{return (await ctx.tools.execute({agent,signal,toolSet,calls:[{type:'tool-call',id:callId,name,arguments:JSON.stringify(args)}]})).results[0].result}finally{toolSet.dispose()}
 }
 assert.deepEqual(manager.model.current(),{provider:syntheticEnv.DSH_WORKBENCH_COORDINATOR_PROVIDER,model:'synthetic-c'})
 assert.equal(ctx.agentPresets.presetForSession(manager.session),'workbench-coordinator')
 const forbidden=await invoke(manager,'bash',{command:'echo forbidden'});assert.equal(forbidden.isError,true)
 assert.equal((await invoke(manager,'workbench_report',{state:'ready',summary:'spoof'})).isError,true)
 await app.coordinator.discuss('human-a','Selected request A')
 const nativeHumanId=randomUUID();manager.send({id:nativeHumanId,role:'user',source:{kind:'user'},content:[{type:'text',text:'Native chat discussion only'}]},'next-turn',false);await ctx.sessions.flush(manager.session)
 const c={key:'dispatch-a',title:'合成任务 A',context:'Only A context',goal:'Summarize A',acceptance:['A summary'],constraints:['no sends']}
 const dispatch=await invoke(manager,'workbench_dispatch',c);assert.equal(dispatch.isError,false,JSON.stringify(dispatch))
 const task=app.store.listTasks()[0],worker=await app.native.ensure(task)
 await assert.rejects(()=>ctx.tools.get('workbench_dispatch',manager).execute(c,{agent:{id:manager.id},signal:new AbortController().signal}),/canonical coordinator/)
 await assert.rejects(()=>ctx.tools.get('workbench_report',worker).execute({state:'ready',summary:'foreign'},{agent:manager,signal:new AbortController().signal}),/exact native lead/)
 const session=await ctx.sessionPersistence.stat(worker.id);assert.equal(session.header.parentSession,undefined);assert.ok(!session.header.isSeeded)

 assert.deepEqual(worker.model.current(),{provider:syntheticEnv.DSH_WORKBENCH_EXECUTOR_PROVIDER,model:'synthetic-e'})
 assert.notEqual(worker.id,canonical);assert.equal(ctx.agentTeams.membership(worker).role,'lead')
 assert.equal((await invoke(manager,'workbench_dispatch',c)).isError,false);assert.equal(app.store.listTasks().length,1)
 const before=JSON.stringify([...worker.inbox.nextTurn,...worker.inbox.nextStep])
 await app.coordinator.discuss('human-b','Unrelated private B')
 assert.equal(JSON.stringify([...worker.inbox.nextTurn,...worker.inbox.nextStep]),before)
 assert.equal((await invoke(worker,'workbench_dispatch',{...c,key:'forged'})).isError,true)
 assert.equal((await invoke(manager,'workbench_amend',{key:'a1',taskId:task.id,assignmentId:task.assignmentId,revision:1,text:'A only clarification'})).isError,false)
 const inputCount=app.store.getTask(task.id).inputs.length
 await invoke(manager,'workbench_amend',{key:'a1',taskId:task.id,assignmentId:task.assignmentId,revision:1,text:'A only clarification'})
 assert.equal(app.store.getTask(task.id).inputs.length,inputCount)
 assert.equal((await invoke(manager,'workbench_amend',{key:'stale',taskId:task.id,assignmentId:task.assignmentId,revision:1,text:'stale'})).isError,true)
 await writeFile(join(task.outputRoot,'native-result.txt'),'Synthetic direct native tool result')
 const artifact=await invoke(worker,'workbench_artifact',{root:'output',path:'native-result.txt',label:'合成原生产物'})
 assert.equal(artifact.isError,false,JSON.stringify(artifact));assert.equal(app.store.notices()[0].artifacts[0].id,app.store.getTask(task.id).artifacts[0].id)
 const reportCall=randomUUID()
 const report=await invoke(worker,'workbench_report',{state:'failed',summary:'Synthetic failure',question:'Select material?'},reportCall);assert.equal(report.isError,false,JSON.stringify(report))
 await invoke(worker,'workbench_report',{state:'failed',summary:'Synthetic failure',question:'Select material?'},reportCall)
 assert.equal(app.store.notices().length,2)
 const notice=app.store.notices().at(-1);assert.ok([...manager.inbox.nextTurn,...manager.inbox.nextStep].some(i=>i.id===notice.id&&i.source.kind==='workbench-feedback'))
 assert.equal((await invoke(manager,'workbench_retry',{key:'r1',taskId:task.id,assignmentId:task.assignmentId,revision:2})).isError,false)
 assert.equal((await invoke(worker,'workbench_report',{state:'ready',summary:'late retired'})).isError,true)
 const replacement=app.store.getTask(task.id);assert.notEqual(replacement.sessionId,task.sessionId)
 assert.equal(replacement.reports.length,2)
 const initialView=await app.coordinator.view();assert.equal(initialView.model.status,'missing-model')
 await ctx.fiber.dispose();ctx=null
 const reopened=await start();assert.equal((await reopened.coordinator.ensure()).id,canonical)
 assert.equal(reopened.store.notices().length,2);assert.equal(reopened.store.getTask(task.id).revision,2)
 const coordinatorView=await reopened.coordinator.view();assert.equal(coordinatorView.pendingInputIds.filter(id=>id===notice.id).length,1)
 const worker2=await reopened.native.ensure(reopened.store.getTask(task.id))
 assert.ok(!JSON.stringify([...worker2.inbox.nextTurn,...worker2.inbox.nextStep]).includes('Unrelated private B'))
 await reopened.stop(task.id)
 assert.equal((await invoke(await reopened.coordinator.ensure(),'workbench_retry',{key:'r2',taskId:task.id,assignmentId:replacement.assignmentId,revision:2})).isError,true)
})
