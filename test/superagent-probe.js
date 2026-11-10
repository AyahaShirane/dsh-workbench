// Acceptance-only direct tool caller; never shipped or enabled by the launcher.
import {randomUUID} from 'node:crypto'
export const inject=['workbench','webServer','tools','agents','agentPresets']
export function apply(ctx) {
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/__acceptance/superagent',handler:async(req,res)=>{
  const origin=ctx.webServer.getOrigin()
  if(req.headers.host!==new URL(origin).host||req.headers.origin!==origin||req.headers.authorization!==`Bearer ${process.env.DSH_WORKBENCH_TOKEN}`){res.writeHead(403);res.end('{}');return}
  try {
   let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>32768)throw Error('too large')}
   const b=JSON.parse(raw),app=ctx.workbench
   if(b.view){res.end(JSON.stringify({coordinator:await app.coordinator.view(),tasks:app.store.listTasks()}));return}
   const task=b.taskId?app.store.getTask(b.taskId):null
   if(b.sessionId&&!ctx.agents.get(b.sessionId))throw Error('requested assignment is not live')
   const agent=task?ctx.agents.get(b.sessionId||task.sessionId)||await app.native.ensure(task):await app.coordinator.ensure()
   if(task&&b.sessionId&&!task.attempts.some(a=>a.sessionId===b.sessionId))throw Error('unknown assignment')
   const signal=new AbortController().signal,toolSet=await ctx.tools.resolve({agent,modelSelection:agent.model.current()||{provider:'synthetic-unavailable',model:'synthetic'},signal})
   try {const result=await ctx.tools.execute({agent,signal,toolSet,calls:[{type:'tool-call',id:b.callId||randomUUID(),name:b.name,arguments:JSON.stringify(b.args||{})}]});res.end(JSON.stringify({result:result.results[0].result,sessionId:agent.id,preset:ctx.agentPresets.presetForSession(agent.session)}))}finally{toolSet.dispose()}
  }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}))}
 }}),'superagent-acceptance-only')
}
