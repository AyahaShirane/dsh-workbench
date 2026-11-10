import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WorkbenchStore } from '../src/store.js'
import { dashboard, taskState, records } from '../src/dashboard.js'

test('production overview separates review, question, failure, missing route and inactive; filters count the same rows',()=>{
 const tasks=[{id:'q',text:'查资料',projectId:'a',state:'ready',inputs:[{at:'1'}],report:{question:'哪份?',at:'2'}},{id:'r',text:'文档',projectId:'a',state:'ready'},{id:'f',text:'failure',state:'failed'},{id:'s',text:'stop',state:'stopped'},{id:'w',text:'等待',state:'waiting'}]
 const native={w:{status:'idle',model:{status:'missing-model'}}}
 assert.equal(taskState(tasks[1],{status:'idle'}),'review')
 assert.equal(taskState(tasks[0]),'question')
 const d=dashboard(tasks,[{id:'a',name:'资料',root:'/synthetic'}],native,{project:'a',search:'查'})
 assert.equal(d.tasks.length,1);assert.equal(d.counts.question,1);assert.equal(d.total,1)
 assert.equal(dashboard(tasks,[],native).counts['missing-model'],1)
 assert.equal(taskState({...tasks[0],inputs:[{at:'1'},{at:'3'}]}),'review')
 assert.equal(taskState({...tasks[0],state:'failed'}),'failed')
})

test('reports and human answers are durable; same-millisecond answer clears question and records whitelist fields',async t=>{
 const dir=await mkdtemp(join(process.cwd(),'.test-dashboard-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 let s=await WorkbenchStore.open(join(dir,'state.json'))
 const task=await s.createTask({text:'initial',workspace:dir,sessionId:'synthetic'})
 await s.report(task.id,{state:'waiting',summary:'first',question:'answer?'})
 assert.equal(taskState(s.getTask(task.id)),'question')
 await s.followUp(task.id,'answer')
 assert.equal(taskState(s.getTask(task.id)),'waiting')
 await s.report(task.id,{state:'ready',summary:'second'})
 await s.close();s=await WorkbenchStore.open(join(dir,'state.json'))
 const rows=records({...s.getTask(task.id),reasoning:'NEVER',system:'NEVER'})
 assert.equal(rows.filter(r=>r.kind==='report').length,2)
 assert.equal(rows.filter(r=>r.kind==='human').length,2)
 assert.ok(!JSON.stringify(rows).includes('NEVER'))
 await s.close()
})

test('native public event projection whitelists text and tool status; excludes hidden/system/raw fields',async()=>{
 const {publicEvent}=await import('../src/dashboard.js')
 const event={seq:1,time:1000,type:'assistant/message',data:{message:{content:[{type:'text',text:'public'},{type:'reasoning',text:'SECRET'}]},stream:[{text:'SECRET'}]}}
 assert.deepEqual(publicEvent(event),{id:'native-1',kind:'assistant',text:'public',at:'1970-01-01T00:00:01.000Z'})
 assert.equal(publicEvent({type:'system/message',data:{message:'SECRET'}}),null)
 assert.equal(publicEvent({type:'assistant/attempt',data:{stream:'SECRET'}}),null)
 assert.ok(!JSON.stringify(publicEvent({...event,type:'tool/call',data:{name:'read',arguments:'SECRET'}})).includes('SECRET'))
 assert.equal(publicEvent({...event,data:{message:{content:[{type:'text',text:'x'.repeat(9000)}]}}}).text.length,4000)
})

test('native GET view of an unloaded task never opens a Session or model',async()=>{
 const {NativeTasks}=await import('../src/native.js')
 const native=new NativeTasks({},{});native.ensure=()=>{throw Error('READ MUST NOT OPEN')}
 assert.equal((await native.view({state:'waiting',sessionId:'synthetic'})).status,'unloaded')
 assert.equal((await native.view({state:'stopped',sessionId:'synthetic'})).status,'stopped')
})


test('v1 legacy state is upgraded additively and old question clears on a new answer',async t=>{
 const dir=await mkdtemp(join(process.cwd(),'.test-dashboard-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const file=join(dir,'state.json');let store=await WorkbenchStore.open(file)
 const task=await store.createTask({text:'legacy',sessionId:'original',projectRoot:'/synthetic-original',workspace:dir})
 await store.report(task.id,{state:'waiting',summary:'legacy report',question:'legacy question'})
 await store.close()
 const legacy=JSON.parse(await readFile(file,'utf8'));delete legacy.tasks[task.id].reports;delete legacy.tasks[task.id].report.inputCount
 await writeFile(file,JSON.stringify(legacy));store=await WorkbenchStore.open(file)
 assert.equal(records(store.getTask(task.id)).filter(r=>r.kind==='report').length,1)
 await store.followUp(task.id,'human answer');assert.notEqual(taskState(store.getTask(task.id)),'question')
 await store.report(task.id,{state:'ready',summary:'new report'});await store.stop(task.id);await store.close()
 store=await WorkbenchStore.open(file);assert.equal(store.getTask(task.id).reports.length,2)
 assert.equal(store.getTask(task.id).projectRoot,'/synthetic-original');assert.equal(store.getTask(task.id).sessionId,'original')
 assert.equal(taskState(store.getTask(task.id)),'stopped');await store.close()
})
