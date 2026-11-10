// Read-only projections. Inactive is a runtime fact, never a completion signal.
export function hasQuestion(t) {
 const r=t.report
 return !!r?.question && (r.inputCount!==undefined ? (t.inputs?.length||0)<=r.inputCount : !(t.inputs||[]).some(i=>i.at>r.at))
}
export function taskState(t,n={}) {
 if(['stopped','failed','blocked'].includes(t.state))return t.state
 if(hasQuestion(t))return 'question'
 if(t.state==='ready')return 'review'
 if(n.status==='running')return 'running'
 if(n.model?.status==='missing-model')return 'missing-model'
 return 'waiting'
}
export function records(t) {
 return [...(t.inputs||[]).map(i=>({id:i.id,kind:t.contract?'assignment':'human',text:i.text,at:i.at,status:i.status})),...(t.reports|| (t.report?[t.report]:[])).map((r,i)=>({id:'report-'+i,kind:'report',text:r.summary,question:r.question,state:r.state,at:r.at})),...(t.events||[]).filter(e=>e.type==='stopped').map(e=>({id:'stop',kind:'stopped',text:'操作员停止任务',at:e.at}))].sort((a,b)=>a.at.localeCompare(b.at))
}
export function dashboard(tasks,projects,native={},filter={}) {
 const all=tasks.map(t=>({...t,displayState:taskState(t,native[t.id])}))
 const rows=all.filter(t=>(!filter.project || (filter.project==='general'?!t.projectId:t.projectId===filter.project))&&(!filter.search || [t.title,t.text,t.report?.summary].filter(Boolean).join(' ').toLocaleLowerCase().includes(filter.search.toLocaleLowerCase()))&&(!filter.state||t.displayState===filter.state))
 const counts=Object.fromEntries(['question','review','blocked','failed','running','waiting','missing-model','stopped'].map(s=>[s,rows.filter(t=>t.displayState===s).length]))
 return {tasks:rows,counts,total:rows.length,projects:[{id:'general',name:'通用任务',root:null},...projects].map(p=>({...p,count:all.filter(t=>p.id==='general'?!t.projectId:t.projectId===p.id).length})),attention:rows.filter(t=>['question','review','blocked','failed'].includes(t.displayState)).map(t=>t.id)}
}
// Only bounded public text / tool names, never streams, reasoning or raw arguments.
export function publicEvent(e) {
 const at=typeof e.time==='number'?new Date(e.time).toISOString():''
 const text=blocks=>(blocks||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n').slice(0,4000)
 if(e.type==='assistant/message'){const value=text(e.data.message?.content);return value?{id:'native-'+e.seq,kind:'assistant',text:value,at}:null}
 if(e.type==='tool/call')return {id:'native-'+e.seq,kind:'tool',text:String(e.data.name).slice(0,100),status:'已请求',at}
 if(e.type==='tool/result')return {id:'native-'+e.seq,kind:'tool',text:'工具返回',status:e.data.message?.isError?'失败':'已返回',at}
 if(e.type==='user/message'&&e.data.source?.kind==='team-message'){return {id:'native-'+e.seq,kind:'team',text:text(e.data.content),at}}
 return null
}
