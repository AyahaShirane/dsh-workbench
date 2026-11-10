import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {superagentBrowserEvidence} from '../scripts/superagent-browser-evidence.mjs'
const execute=promisify(execFile),root=process.cwd(),evidence=join(root,'evidence/superagent-v0.3'),token='synthetic-superagent-host-operator'
async function until(fn,ms=20000){const at=Date.now();while(Date.now()-at<ms){const result=await fn();if(result)return result;await delay(60)}throw Error('host readiness timed out')}
test('real DSH root client asset, coordinator tool flow and native browser navigation',{timeout:120000},async t=>{
 await mkdir(evidence,{recursive:true});const dir=await mkdtemp(join(root,'.acceptance/sah-')),home=join(dir,'home'),app=join(dir,'app')
 await mkdir(join(app,'config'),{recursive:true});await mkdir(join(dir,'tmp'));await writeFile(join(app,'config/projects.json'),'{"projects":[]}')
 // Skip only empty-provider key onboarding in this isolated fixture; native login and operator auth stay active.
 const overlay=join(dir,'probe.yml');await writeFile(overlay,`- insert:\n    - id: ui-settings-models\n      config:\n        credentialOnboarding: false\n    - id: superagent-acceptance-probe\n      name: ${join(root,'test/superagent-probe.js')}\n`)
 const env={PATH:process.env.PATH || '',LANG:'C.UTF-8',DSH_HOME:home,DSH_AGENTS_HOME:join(home,'agents'),TMPDIR:join(dir,'tmp'),DSH_WORKBENCH_ROOT:app,DSH_WORKBENCH_TOKEN:token}
 await execute(process.execPath,['scripts/prepare-profile.mjs'],{cwd:root,env})
 let child,origin,nativeUrl,logs=''
 async function boot(){let output='';child=spawn(process.execPath,['node_modules/@deepseek-ai/dsh/lib/bin.js','--profile','workbench','--patch',overlay,'--host','127.0.0.1','--port','0','--no-open'],{cwd:root,env,stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output+=b;logs+=b.toString().replace(/([?&]token=)[^\s]+/g,'$1[redacted]')});nativeUrl=await until(()=>{if(child.exitCode!==null)throw Error('DSH failed (code='+child.exitCode+', signal='+child.signalCode+'): '+output.replace(/([?&]token=)[^\s]+/g,'$1[redacted]'));return /dsh web: (http:\/\/127\.0\.0\.1:\d+[^\s]*)/.exec(output)?.[1]});origin=new URL(nativeUrl).origin;await until(async()=>{try{return (await fetch(origin+'/workbench/api/coordinator',{headers:{authorization:'Bearer '+token}})).status===200}catch{return false}})}
 async function halt(){if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGINT');await until(()=>child.exitCode!==null||child.signalCode!==null)}}
 t.after(async()=>{await halt();await writeFile(join(evidence,'native-host.log'),logs)})
 await boot()
 const api=async(path,body)=>{const r=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.equal(r.status,200,await r.clone().text());return r.json()}
 const invoke=(name,args,taskId)=>api('/__acceptance/superagent',{name,args,taskId})
 const coordinator=await api('/workbench/api/coordinator');assert.equal(coordinator.role,'coordinator');assert.equal(coordinator.model.status,'missing-model')
 const dispatched=await invoke('workbench_dispatch',{key:'host-a',title:'原生 Host 合成任务',context:'selected material A',goal:'Summarize A',acceptance:['A summary']});assert.equal(dispatched.result.isError,false,JSON.stringify(dispatched))
 const view=await api('/__acceptance/superagent',{view:true}),task=view.tasks[0]
 assert.equal((await invoke('workbench_dispatch',{key:'forged'},task.id)).result.isError,true)
 assert.equal((await invoke('workbench_report',{state:'ready',summary:'Synthetic host feedback',question:'Which source?'},task.id)).result.isError,false)
 assert.equal((await api('/workbench/api/coordinator')).notices.length,1)
 await superagentBrowserEvidence(nativeUrl,token,dir,env)
 const afterNavigation=await invoke('workbench_tasks',{});assert.equal(afterNavigation.result.isError,false);assert.equal(afterNavigation.preset,'workbench-coordinator')
 assert.equal((await api('/__acceptance/superagent',{view:true})).tasks.length,1,'browser discussion cannot create another task')
 await halt();await boot()
 const reopened=await api('/workbench/api/coordinator');assert.equal(reopened.sessionId,coordinator.sessionId);assert.equal(reopened.notices.length,1)
 await writeFile(join(evidence,'native-host-result.json'),JSON.stringify({passed:true,synthetic:true,coordinatorId:reopened.sessionId,taskId:task.id,notices:reopened.notices.length},null,2))
})
