import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {modelRoute} from '../src/contracts.js'
import {WorkbenchStore} from '../src/store.js'
const contract={title:'选定任务',context:'selected context',goal:'produce a summary',materials:['supplied note'],constraints:['no external sends'],acceptance:['summary exists'],provenanceIds:[]}
async function fixture(t){const dir=await mkdtemp(join(process.cwd(),'.acceptance/sa-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,'state.json');const store=await WorkbenchStore.open(file);t.after(()=>store.close());return {dir,file,store}}
const binding=async c=>({id:'logical-task',sessionId:'independent-root',text:c.text,workspace:'fixed-root',outputRoot:'fixed-output'})
test('contracts isolate discussion, atomically dedupe dispatch/amend, reject conflicts and stale revisions',async t=>{
 const {store,file}=await fixture(t)
 const human=await store.discuss('h1','Unrelated private discussion B')
 const value={...contract,provenanceIds:[human.id]}
 const [first,duplicate]=await Promise.all([store.dispatch('d1',value,binding),store.dispatch('d1',value,binding)])
 assert.equal(first.task.id,duplicate.task.id);assert.equal(duplicate.duplicate,true)
 assert.ok(!first.task.text.includes('Unrelated private discussion B'));assert.ok(first.task.text.includes(human.id))
 await assert.rejects(store.dispatch('d1',{...value,goal:'changed'},binding),/conflict/)
 await assert.rejects(store.dispatch('d2',{...value,provenanceIds:['forged']},binding),/provenance/)
 const other=await store.createTask({id:'other',text:'other project',sessionId:'other-root',workspace:'other-root'})
 const amended=await store.amend('a1',first.task.id,first.task.assignmentId,1,'Only selected material',[human.id])
 assert.equal(amended.task.revision,2)
 assert.equal((await store.amend('a1',first.task.id,first.task.assignmentId,1,'Only selected material',[human.id])).duplicate,true)
 await assert.rejects(store.amend('a2',first.task.id,first.task.assignmentId,1,'stale'),/stale/)
 assert.equal(store.getTask(other.id).inputs.length,1)
 const reopened=await WorkbenchStore.open(file);t.after(()=>reopened.close())
 assert.deepEqual(reopened.coordinator(),store.coordinator());assert.equal(reopened.getTask(first.task.id).revision,2)
 assert.equal((await reopened.dispatch('d1',value,binding)).duplicate,true)
})
test('feedback and retry preserve logical identity/results, fence retired assignments and never revive stopped tasks',async t=>{
 const {store}=await fixture(t);const {task}=await store.dispatch('d1',contract,binding)
 await store.report(task.id,{state:'failed',summary:'bounded failure',question:'choose source',artifacts:[{id:'file',label:'result',sha256:'hash'}]},task.assignmentId)
 assert.equal(store.notices().length,1);assert.equal(store.notices()[0].assignmentId,task.assignmentId)
 const replaced=await store.retry('r1',task.id,task.assignmentId,1)
 assert.equal(replaced.task.id,task.id);assert.equal(replaced.task.workspace,task.workspace);assert.notEqual(replaced.task.sessionId,task.sessionId)
 assert.equal(replaced.task.artifacts[0].id,'file');assert.equal(replaced.task.reports.length,1);assert.equal(replaced.task.attempts.length,2)
 assert.equal(await store.report(task.id,{state:'ready',summary:'late'},task.assignmentId),false)
 assert.equal((await store.retry('r1',task.id,task.assignmentId,1)).duplicate,true)
 await store.stop(task.id)
 await assert.rejects(store.retry('r2',task.id,replaced.task.assignmentId,1),/requires/)
 await assert.rejects(store.amend('a1',task.id,replaced.task.assignmentId,1,'revive'),/stopped/)
 assert.equal(await store.report(task.id,{state:'ready',summary:'late'},replaced.task.assignmentId),false)
 assert.equal(store.notices().length,1)
})
test('old v1 data migrates additively without clearing original channel, inputs or result history',async t=>{
 const {dir}=await fixture(t),file=join(dir,'legacy.json')
 const task={id:'old',text:'legacy task',sessionId:'old-session',workspace:'immutable',channel:{adapter:'signed-webhook',thread:'original'},state:'blocked',createdAt:'2026-01-01',report:{state:'blocked',summary:'old report'},artifacts:[{id:'old-file'}],events:[],followUps:[]}
 await writeFile(file,JSON.stringify({version:1,tasks:{old:task},events:{old:'old'},outbox:[]}))
 const store=await WorkbenchStore.open(file);t.after(()=>store.close())
 assert.equal(store.getTask('old').channel.thread,'original');assert.equal(store.getTask('old').reports[0].summary,'old report');assert.equal(store.getTask('old').attempts[0].sessionId,'old-session')
 const identity=store.coordinator().sessionId
 await store.close();const reopened=await WorkbenchStore.open(file);t.after(()=>reopened.close());assert.equal(reopened.coordinator().sessionId,identity)
 const raw=JSON.parse(await readFile(file,'utf8'));assert.equal(raw.events.old,'old');assert.equal(raw.version,1)
})

test('independent server model routes use complete pairs and preserve legacy fallback',()=>{
 const env={DSH_WORKBENCH_PROVIDER:'legacy',DSH_WORKBENCH_MODEL:'fallback',DSH_WORKBENCH_COORDINATOR_PROVIDER:'coordinator',DSH_WORKBENCH_COORDINATOR_MODEL:'coord-model'}
 assert.deepEqual(modelRoute(env,'COORDINATOR'),{provider:'coordinator',model:'coord-model'})
 assert.deepEqual(modelRoute(env,'EXECUTOR'),{provider:'legacy',model:'fallback'})
 assert.throws(()=>modelRoute({...env,DSH_WORKBENCH_EXECUTOR_PROVIDER:'executor'},'EXECUTOR'),/together/)
 assert.deepEqual(modelRoute({},'COORDINATOR'),{})
})
