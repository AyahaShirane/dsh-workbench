import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, realpath, lstat, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import z from '@deepseek-ai/schemastery'
import { isLoopbackHost } from '@deepseek-ai/dsh-host-webserver'
import { WorkbenchStore } from './store.js'
import { canonicalRoot, resolveInside } from './workspaces.js'
import { SignedWebhookAdapter, constantEqual, failure } from './adapter.js'
import { modelRoute } from './contracts.js'
import { Coordinator } from './coordinator.js'
import { NativeTasks } from './native.js'
import { dashboard, taskState, records } from './dashboard.js'
import { html } from './ui.js'

export const name='dsh-workbench'
export const inject=['webServer','agents','agentTeams','agentPresets','sessions','sessionPersistence','sessionProjections','workingDirectory','tools','systemPrompt','llm','subagents']
export const Config=z.object({root:z.string().default(process.cwd()),stateFile:z.string().default('.workbench/data/state.json'),projectsFile:z.string().default('config/projects.json'),ingressFile:z.string().default('config/ingress.json'),outboundUrl:z.string().default(''),maximumBodyBytes:z.number().default(32768)})
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value))}
async function body(req,max) { if(req.headers['content-type']?.split(';')[0]!=='application/json') throw failure(415,'JSON content type required'); const parts=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>max)throw failure(413,'body too large');parts.push(chunk)}return Buffer.concat(parts).toString('utf8') }
function parse(raw,keys) {let value;try{value=JSON.parse(raw)}catch{throw failure(400,'invalid JSON')}if(!value||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw failure(400,'unexpected fields');return value}
function text(value) {if(typeof value!=='string'||!value.trim()||value.length>12000)throw failure(400,'任务说明不能为空且不超过 12000 字符');return value}

export async function initialize(ctx,config,env=process.env) {
  if(!isLoopbackHost(ctx.webServer.host))throw Error('Workbench external deployment is disabled: bind loopback')
  const root=await realpath(config.root),pathOf=p=>isAbsolute(p)?p:resolve(root,p)
  const appVersion=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version
  const dshVersion=JSON.parse(await readFile(new URL(import.meta.resolve('@deepseek-ai/dsh/package.json')),'utf8')).version
  const token=env.DSH_WORKBENCH_TOKEN||''
  if(token.length<20)throw Error('DSH_WORKBENCH_TOKEN must contain at least 20 characters')
  const coordinatorRoute=modelRoute(env,'COORDINATOR'),executorRoute=modelRoute(env,'EXECUTOR')
  const store=await WorkbenchStore.open(pathOf(config.stateFile),{exclusive:true})
  const native=new NativeTasks(ctx,store,executorRoute)
  const remove=[],operations=new Map(),inflight=new Map();let closing=false,ready=false,worker,coordinator
  try {
    const source=JSON.parse(await readFile(pathOf(config.projectsFile),'utf8')),projects=[]
    for(const item of source.projects){if(!/^[a-z0-9][a-z0-9-]*$/.test(item.id)||projects.some(p=>p.id===item.id))throw Error('invalid or duplicate project id');projects.push({id:item.id,name:String(item.name),root:await canonicalRoot(pathOf(item.root))})}
    let ingress={adapter:'signed-webhook',account:'local-example',allowedActors:[],allowedRooms:[]}
    try{ingress={...ingress,...JSON.parse(await readFile(pathOf(config.ingressFile),'utf8'))}}catch(e){if(e.code!=='ENOENT')throw e}
    if([...ingress.allowedActors,...ingress.allowedRooms].some(v=>typeof v!=='string'||!v||v==='*'))throw Error('explicit actor and room IDs required')
    const adapter=new SignedWebhookAdapter(ingress,{secret:env.DSH_WORKBENCH_INGRESS_SECRET,outboundUrl:config.outboundUrl||env.DSH_WORKBENCH_OUTBOUND_URL,outboundSecret:env.DSH_WORKBENCH_OUTBOUND_SECRET})
    await native.init()
    const operate=(id,fn)=>{const p=(operations.get(id)||Promise.resolve()).catch(()=>{}).then(fn);operations.set(id,p);return p.finally(()=>{if(operations.get(id)===p)operations.delete(id)})}
    const makeBinding=async(event,projectId)=>{
      const project=projectId?projects.find(p=>p.id===projectId):null
      if(projectId&&!project)throw failure(400,'unknown project')
      const id=randomUUID(),workspace=project?await realpath(project.root):await canonicalRoot(pathOf(join('.workbench/tasks',id)))
      if(project&&workspace!==project.root)throw failure(400,'configured project root changed')
      const outputRoot=await canonicalRoot(project?await resolveInside(project.root,`.dsh-workbench-output/${id}`):join(workspace,'output'))
      return {id,title:event.title||event.text.split(/\r?\n/)[0].slice(0,100),text:text(event.text),projectId:project?.id??null,projectRoot:project?.root??null,workspace,outputRoot,sessionId:`workbench-${id}`,channel:{adapter:event.adapter,account:event.account,conversation:event.conversation,thread:event.thread,message:event.message,actor:event.actor,addressed:event.addressed}}
    }
    const intake=async(event,{taskId=null,projectId=null}={})=>{
      if(taskId){const t=store.getTask(taskId);if(!t)throw failure(404,'task not found');if(event.adapter!=='browser'&&['adapter','account','conversation','thread'].some(k=>event[k]!==t.channel[k]))throw failure(403,'follow-up channel does not match immutable binding')}
      const action=async()=>{const result=await store.accept(event,()=>makeBinding(event,projectId),taskId);if(!result.duplicate&&result.task.state!=='stopped')await native.deliver(result.task);return {...result,task:store.getTask(result.task.id)}}
      return taskId?operate(taskId,action):action()
    }
    const stop=(id,expected)=>operate(id,async()=>{const task=store.getTask(id);if(expected&&(!task||task.assignmentId!==expected.assignmentId||task.revision!==expected.revision))throw failure(409,'stale assignment/revision');if(!task)throw failure(404,'task not found');const snapshot=await native.view(task);await store.setNative(id,{...task.native,members:snapshot.members||[],tasks:snapshot.tasks||[],model:snapshot.model,records:snapshot.records||[]});await store.stop(id);for(const [controller,taskId]of inflight)if(taskId===id)controller.abort();await native.stop(task);return store.getTask(id)})
    const detail=async id=>{const task=store.getTask(id);if(!task)throw failure(404,'task not found');const view=await native.view(task);return {task:{...task,displayState:taskState(task,view)},native:view,records:[...records(task),...(view.records||[])].sort((a,b)=>a.at.localeCompare(b.at))}}
    const actions={projects,detail,
      dispatch:async(key,contract)=>{const result=await store.dispatch(key,contract,c=>makeBinding({adapter:'coordinator',account:'local',conversation:store.coordinator().sessionId,thread:key,actor:'coordinator',message:key,...c},c.projectId));if(result.task.state!=='stopped')await operate(result.task.id,()=>native.deliver(store.getTask(result.task.id)));return {duplicate:result.duplicate,task:store.getTask(result.task.id)}},
      amend:a=>operate(a.taskId,async()=>{const result=await store.amend(a.key,a.taskId,a.assignmentId,a.revision,a.text,a.provenanceIds);if(result.task.state!=='stopped')await native.deliver(result.task);return result}),
      stopChecked:async a=>stop(a.taskId,a),
      retry:a=>operate(a.taskId,async()=>{const old=store.getTask(a.taskId);const result=await store.retry(a.key,a.taskId,a.assignmentId,a.revision);if(!result.duplicate)await native.retire(old);if(result.task.state!=='stopped')await native.deliver(result.task);return result})
    }
    coordinator=new Coordinator(ctx,store,native,actions,{workspace:root,...coordinatorRoute})
    native.options.feedback=()=>coordinator.deliver()
    await coordinator.init()
    const origin=()=>ctx.webServer.getOrigin()
    const route=(kind,path,handler)=>remove.push(ctx.webServer.register({kind,path,handler:async(req,res)=>{
      try{
        if(closing||!ready)throw failure(503,'workbench is recovering or closing')
        if(req.headers.host!==new URL(origin()).host)throw failure(403,'host denied')
        await handler(req,res)
      }catch(e){if(!e.status)console.error('workbench:',e.stack||e);if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'native operation failed; inspect local host log'});else res.destroy()}
    }}))
    const auth=(req,mutation=false)=>{if(!constantEqual(req.headers.authorization,`Bearer ${token}`))throw failure(401,'unauthorized');if(mutation&&req.headers.origin!==origin())throw failure(403,'origin denied')}
    route('exact','/workbench',async(req,res)=>{if(!['GET','HEAD'].includes(req.method))throw failure(405,'method denied');res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",'x-content-type-options':'nosniff'});res.end(req.method==='HEAD'?'':html)})
    route('exact','/workbench/api/coordinator',async(req,res)=>{
      auth(req,req.method!=='GET')
      if(req.method==='GET')return json(res,200,await coordinator.view())
      if(req.method!=='POST')throw failure(405,'method denied')
      const b=parse(await body(req,config.maximumBodyBytes),['key','text'])
      const input=await coordinator.discuss(b.key,b.text);json(res,200,{input,coordinator:await coordinator.view()})
    })
    route('exact','/workbench/api/overview',async(req,res)=>{
      auth(req);if(req.method!=='GET')throw failure(405,'method denied')
      const tasks=store.listTasks(),views={}
      for(const task of tasks)views[task.id]=await native.view(task)
      const q=new URL(req.url,origin()).searchParams
      const data=dashboard(tasks,projects,views,{project:q.get('project'),search:q.get('search'),state:q.get('state')})
      json(res,200,{...data,connection:{appVersion,dshVersion,authentication:'operator-authenticated',modelAuthentication:'unverified',nativeUrl:'/'}})
    })
    route('exact','/workbench/api/tasks',async(req,res)=>{
      auth(req,req.method!=='GET')
      if(req.method==='GET')return json(res,200,{projects:projects.map(({id,name})=>({id,name})),tasks:store.listTasks()})
      if(req.method!=='POST')throw failure(405,'method denied')
      const b=parse(await body(req,config.maximumBodyBytes),['text','projectId','title'])
      const event={adapter:'browser',account:'local-ui',conversation:'workbench',thread:'workbench',actor:'local-operator',addressed:'direct',message:randomUUID(),text:text(b.text),title:b.title===undefined?undefined:text(b.title).slice(0,100)}
      const result=await intake(event,{projectId:b.projectId??null});json(res,201,{task:result.task,native:await native.view(result.task)})
    })
    route('prefix','/workbench/api/tasks',async(req,res)=>{
      auth(req,req.method!=='GET')
      const [id,action,artifactId,...extra]=new URL(req.url,origin()).pathname.split('/').filter(Boolean).slice(3).map(decodeURIComponent)
      if(extra.length)throw failure(404,'not found')
      const task=store.getTask(id);if(!task)throw failure(404,'task not found')
      if(!action&&req.method==='GET')return json(res,200,await detail(id))
      if(action==='followups'&&req.method==='POST'){
        const b=parse(await body(req,config.maximumBodyBytes),['text'])
        const event={adapter:'browser',account:'local-ui',conversation:'workbench',thread:'workbench',actor:'local-operator',addressed:'direct',message:randomUUID(),text:text(b.text)}
        await intake(event,{taskId:id});return json(res,200,await detail(id))
      }
      if(action==='stop'&&req.method==='POST'){parse(await body(req,config.maximumBodyBytes),[]);await stop(id);return json(res,200,await detail(id))}
      if(action==='artifacts'&&artifactId&&req.method==='GET'){
        const artifact=task.artifacts.find(a=>a.id===artifactId);if(!artifact)throw failure(404,'artifact not registered')
        const file=await resolveInside(artifact.root==='output'?task.outputRoot:task.projectRoot,artifact.path)
        const fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW)
        let bytes;try{const stat=await fd.stat();if(!stat.isFile()||stat.size>5*1024*1024)throw failure(409,'artifact changed');bytes=await fd.readFile()}finally{await fd.close()}
        if(createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)throw failure(409,'artifact changed since registration')
        if(new URL(req.url,origin()).searchParams.get('preview')==='1'){
          if(!/\.(txt|md|csv|json|log|js|mjs|css|py|ya?ml)$/i.test(artifact.path)||bytes.length>65536||bytes.includes(0))throw failure(415,'仅预览 64 KiB 内的纯文本文件；其他文件请下载')
          return json(res,200,{text:bytes.toString('utf8'),size:bytes.length,type:'text/plain'})
        }
        res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':'attachment; filename="artifact"','cache-control':'no-store','x-content-type-options':'nosniff'});return res.end(bytes)
      }
      throw failure(405,'method denied')
    })
    route('exact','/workbench/ingress/webhook',async(req,res)=>{
      if(req.method!=='POST')throw failure(405,'method denied')
      const event=adapter.authenticate(req.headers,await body(req,config.maximumBodyBytes))
      const result=await intake(event,{taskId:event.taskId});json(res,result.duplicate?200:202,{accepted:true,duplicate:result.duplicate,taskId:result.task.id,sessionId:result.task.sessionId})
    })
    // Replay committed pending input into the original DSH Session before accepting traffic.
    for(const task of store.listTasks())if(task.state!=='stopped')await native.deliver(task)
    ctx.provide('workbench',{store,native,coordinator,intake,stop,detail,projects})
    ready=true
    worker=(async()=>{while(!closing){
      if(adapter.outboundUrl)for(const row of store.pendingOutbox()){
        if(closing||!store.canDispatch(row.id))continue
        const controller=new AbortController();inflight.set(controller,row.taskId)
        try{if(!store.canDispatch(row.id))continue;await adapter.send(row,AbortSignal.any([controller.signal,AbortSignal.timeout(3000)]));await store.markOutbox(row.id,'sent')}
        catch{await store.markOutbox(row.id,'pending');await delay(300)}finally{inflight.delete(controller)}
      }
      await delay(200)
    }})()
    ctx.effect(()=>async()=>{closing=true;for(const c of inflight.keys())c.abort();for(const fn of remove)fn();await worker;await Promise.allSettled([...operations.values()]);try{await coordinator.close();await native.close()}finally{await store.close()}},'workbench-lifecycle')
    return {store,native,coordinator}
  }catch(e){closing=true;for(const fn of remove)fn();if(coordinator)await coordinator.close().catch(()=>{});if(native.receipts)await native.close().catch(()=>{});await store.close();throw e}
}
export function apply(ctx,config){return initialize(ctx,config)}
