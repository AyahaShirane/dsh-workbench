// Test-only DSH contributor: excluded from the production bundle and launcher.
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
export const inject=['workbench','webServer','tools','sessionPersistence']
export function apply(ctx) {
  let aborted=false
  ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/__acceptance/probe',handler:async(req,res)=>{
    try {
      if(req.headers.authorization!==`Bearer ${process.env.DSH_WORKBENCH_TOKEN}`){res.statusCode=401;res.end('{}');return}
      let raw='';for await(const chunk of req)raw+=chunk
      const b=JSON.parse(raw),app=ctx.workbench,task=app.store.getTask(b.taskId)
      if(b.kind==='status'){res.end(JSON.stringify({aborted}));return}
      const agent=app.native.handles.get(task.sessionId)?.agent || await app.native.ensure(task)
      if(b.kind==='maintenance'){
        agent.runMaintenance(signal=>new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve()},{once:true}))).catch(()=>{})
        res.end(JSON.stringify({started:true}));return
      }
      const name=b.kind==='read'?'read':b.kind==='artifact'||b.kind==='escape'?'workbench_artifact':'workbench_report'
      let args={state:'ready',summary:'Synthetic native tool report',question:'Which source should be checked next?'}
      if(['blocked','failed'].includes(b.kind))args={state:b.kind,summary:'Synthetic '+b.kind}
      if(b.kind==='change-artifact'){await writeFile(join(task.outputRoot,'result.txt'),'changed synthetic file');res.end('{}');return}
      if(b.kind==='read')args={file_path:'input.txt'}
      if(b.kind==='foreign')args.taskId='not-the-bound-task'
      if(b.kind==='artifact'){await writeFile(join(task.outputRoot,'result.txt'),'synthetic verified file\n');args={root:'output',path:'result.txt',label:'合成文件'}}
      if(b.kind==='escape')args={root:'output',path:'../secret.txt'}
      const results=await ctx.tools.execute({agent,signal:new AbortController().signal,calls:[{type:'tool-call',id:randomUUID(),name,arguments:JSON.stringify(args)}]})
      const persisted=await ctx.sessionPersistence.stat(agent.id)
      res.end(JSON.stringify({results,persisted:{id:persisted.header.id,cwd:persisted.header.cwd,eventCount:persisted.eventCount},lateEnqueue:b.kind==='late'?await app.store.enqueue({conversation:'evil'},'late',task.id):null}))
    }catch(e){res.statusCode=500;res.end(JSON.stringify({error:e.stack}))}
  }}),'acceptance-only')
}
