import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, open, unlink, readlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { bounded, contractOf, contractText, fingerprint } from './contracts.js'
import { failure } from './adapter.js'

const now = () => new Date().toISOString()
const input = text => ({ id: randomUUID(), text, at: now(), status: 'pending' })
export function eventKey(e) {
  // A source message has one identity even if its correlation metadata changes.
  return createHash('sha256').update(JSON.stringify([e.adapter, e.account, e.conversation, e.message])).digest('hex')
}

export class WorkbenchStore {
  #file; #state; #tail = Promise.resolve(); #lock; #closed = false
  static async open(file, { exclusive = false } = {}) {
    const s = new WorkbenchStore(); s.#file = file
    await mkdir(dirname(file), { recursive: true })
    if (exclusive) {
      const lock = `${file}.lock`
      const pidNamespace = await readlink('/proc/self/ns/pid').catch(() => null)
      try { s.#lock = await open(lock, 'wx', 0o600) }
      catch (e) {
        if (e.code !== 'EEXIST') throw e
        const owner = JSON.parse(await readFile(lock, 'utf8'))
        if (!Number.isInteger(owner.pid) || owner.pid < 2 || owner.pidNamespace !== pidNamespace) throw Error('workbench lock ownership cannot be checked in this PID namespace; inspect the old owner before removing a stale lock')
        const pid = owner.pid
        try { process.kill(pid, 0); throw Error('workbench state is already owned by a live process') }
        catch (liveError) { if (liveError.code !== 'ESRCH') throw liveError }
        await unlink(lock); s.#lock = await open(lock, 'wx', 0o600)
      }
      await s.#lock.writeFile(JSON.stringify({pid:process.pid,pidNamespace})); await s.#lock.sync()
    }
    try {
      try { s.#state = JSON.parse(await readFile(file, 'utf8')) }
      catch (e) { if (e.code !== 'ENOENT') throw e; s.#state = { version: 1, tasks: {}, events: {}, outbox: [] }; await s.#save(s.#state) }
      if (s.#state.version !== 1 || !s.#state.tasks || !s.#state.events || !Array.isArray(s.#state.outbox)) throw Error('invalid workbench state')
      for (const task of Object.values(s.#state.tasks)) { task.inputs ??= [input(task.text)]; task.reports ??= task.report ? [task.report] : [] }
      // Additive v1 migration: original tasks, inputs, channels and reports stay intact.
      s.#state.superagent ??= { coordinator: { sessionId: `workbench-coordinator-${randomUUID()}`, inputs: [] }, operations: {}, notices: [] }
      s.#state.superagent.reportReceipts ??= {}
      s.#state.superagent.coordinator.nativeHumanIds ??= []
      for (const task of Object.values(s.#state.tasks)) {
        task.revision ??= 1
        task.assignmentId ??= task.sessionId
        task.attempts ??= [{ id: task.assignmentId, sessionId: task.sessionId, at: task.createdAt }]
      }
      await s.#save(s.#state)
      return s
    } catch (e) { await s.close(); throw e }
  }
  async #save(value) {
    const temp = `${this.#file}.${process.pid}.${randomUUID()}.tmp`
    let renamed = false
    try {
      const fd = await open(temp, 'wx', 0o600)
      try { await fd.writeFile(JSON.stringify(value)); await fd.sync() } finally { await fd.close() }
      await rename(temp, this.#file)
      renamed = true
      const dir = await open(dirname(this.#file), 'r'); try { await dir.sync() } finally { await dir.close() }
    } catch (error) { if (renamed) error.commitUncertain = true; throw error }
    finally { await unlink(temp).catch(() => {}) }
  }
  #tx(fn) {
    const result = this.#tail.then(async () => {
      if (this.#closed) throw Error('store is closed')
      const draft = structuredClone(this.#state)
      const value = await fn(draft)
      try { await this.#save(draft) }
      catch (error) { if (error.commitUncertain) { this.#state = draft; this.#closed = true }; throw error }
      this.#state = draft
      return structuredClone(value)
    })
    this.#tail = result.catch(() => {}); return result
  }
  async close() {
    await this.#tail; this.#closed = true
    if (this.#lock) { await this.#lock.close(); this.#lock = null; await unlink(`${this.#file}.lock`) }
  }
  #task(binding) {
    return { ...structuredClone(binding), id: binding.id ?? randomUUID(), projectId: binding.projectId ?? null,
      revision: 1, assignmentId: binding.assignmentId ?? binding.sessionId, attempts: [{id: binding.assignmentId ?? binding.sessionId, sessionId: binding.sessionId, at: now()}], state: 'waiting', createdAt: now(), reports: [], followUps: [], inputs: [input(binding.text)], artifacts: [],
      events: [{ type: 'created', at: now() }] }
  }
  #outbox(draft, task, content) {
    if (task.state === 'stopped') return false
    const id = randomUUID()
    draft.outbox.push({ id, taskId: task.id, destination: structuredClone(task.channel), content, status: 'pending', attempts: 0 })
    return id
  }
  accept(event, createBinding, taskId = null) {
    return this.#tx(async d => {
      const key = eventKey(event), prior = d.events[key]
      if (prior) return { duplicate: true, task: d.tasks[prior] }
      let task
      if (taskId) {
        task = d.tasks[taskId]
        if (!task || task.state === 'stopped') throw Object.assign(Error('task is stopped or absent'), { status: 409 })
        this.#operatorFollow(task,event.text)
      } else {
        task = this.#task(await createBinding()); d.tasks[task.id] = task
        if (task.channel?.adapter === 'signed-webhook') this.#outbox(d, task, `已接收任务：${task.text}`)
      }
      d.events[key] = task.id
      return { duplicate: false, task }
    })
  }
  createTask(binding) { return this.#tx(d => { const t = this.#task(binding); d.tasks[t.id] = t; return t }) }
  getTask(id) { return this.#state.tasks[id] ? structuredClone(this.#state.tasks[id]) : undefined }
  listTasks() { return Object.values(this.#state.tasks).map(t => structuredClone(t)).sort((a,b) => b.createdAt.localeCompare(a.createdAt)) }
  #follow(task, text) { if(task.report && task.report.inputCount===undefined)task.report.inputCount=task.inputs.length; const item = input(text); task.inputs.push(item); task.followUps.push({ id: item.id, text, at: item.at }); task.state = 'waiting'; task.events.push({ type: 'follow-up', at: now() }); return item }
  #operatorFollow(task,text) {
    if(task.contract){task.revision++;task.amendments??=[];task.amendments.push({text,revision:task.revision,assignmentId:task.assignmentId,source:'advanced-human',at:now()})}
    return this.#follow(task,text)
  }
  followUp(id, text) { return this.#tx(d => { const t = d.tasks[id]; return !t || t.state === 'stopped' ? false : this.#operatorFollow(t, text) }) }
  markInput(id, inputId) { return this.#tx(d => { const t = d.tasks[id], i = t?.inputs.find(x => x.id === inputId); if (!i || t.state === 'stopped') return false; i.status = 'delivered'; return true }) }
  setNative(id, value) { return this.#tx(d => { const t = d.tasks[id]; if (!t || t.state === 'stopped') return false; t.native = value; return true }) }
  stop(id) {
    return this.#tx(d => {
      const t = d.tasks[id]; if (!t || t.state === 'stopped') return false
      t.state = 'stopped'; t.stoppedAt = now(); t.events.push({ type: 'stopped', at: t.stoppedAt })
      for (const i of t.inputs) if (i.status === 'pending') i.status = 'canceled'
      for (const row of d.outbox) if (row.taskId === id && row.status === 'pending') row.status = 'dropped'
      return true
    })
  }
  report(id, report, assignmentId = undefined, receiptId = undefined) {
    return this.#tx(d => {
      const t = d.tasks[id]; if (!t || t.state === 'stopped' || (assignmentId !== undefined && t.assignmentId !== assignmentId)) return false
      const receipt=receiptId?`${id}:${t.assignmentId}:${receiptId}`:null
      if(receipt&&d.superagent.reportReceipts[receipt])return false
      if (!['waiting','ready','blocked','failed'].includes(report.state)) throw Error('invalid task state')
      t.state = report.state; t.report = { assignmentId:t.assignmentId,revision:t.revision,state: report.state, summary: String(report.summary ?? '').slice(0,4000), question: String(report.question ?? '').slice(0,2000), at: now(), inputCount: t.inputs.length }; t.reports ??= []; t.reports.push(structuredClone(t.report))
      if (report.artifacts) t.artifacts.push(...report.artifacts)
      const notice = { id: randomUUID(), kind: 'executor-feedback', taskId: t.id, assignmentId: t.assignmentId, revision: t.revision, state: t.state, summary: t.report.summary, question: t.report.question, artifacts: (report.artifacts||[]).map(({id,label,sha256})=>({id,label,sha256})), at: t.report.at }
      t.report.noticeId = notice.id
      t.reports[t.reports.length-1].noticeId = notice.id
      d.superagent.notices.push(notice)
      if(receipt)d.superagent.reportReceipts[receipt]=notice.id
      t.events.push({ type: report.state, at: now() })
      if (t.channel?.adapter === 'signed-webhook') this.#outbox(d, t, `${report.state}: ${t.report.summary}${t.report.question ? '\n问题：' + t.report.question : ''}`)
      return true
    })
  }
  coordinator() { return structuredClone(this.#state.superagent.coordinator) }
  registerHumanIds(ids) {return this.#tx(d=>{d.superagent.coordinator.nativeHumanIds=[...new Set([...d.superagent.coordinator.nativeHumanIds,...ids])];return true})}
  notices() { return structuredClone(this.#state.superagent.notices) }
  discuss(key, text) {
    bounded(key,'message key',160); bounded(text,'message',12000)
    return this.#tx(d=>{
      const c=d.superagent.coordinator, prior=c.inputs.find(i=>i.key===key)
      if(prior) { if(prior.text!==text)throw failure(409,'message key conflict'); return prior }
      const row={...input(text),key,kind:'human-discussion'}; c.inputs.push(row); return row
    })
  }
  dispatch(key, value, makeBinding) {
    bounded(key,'dispatch key',160); const contract=contractOf(value), hash=fingerprint(contract)
    return this.#tx(async d=>{
      const op=d.superagent.operations['dispatch:'+key]
      if(op) { if(op.hash!==hash)throw failure(409,'dispatch key conflict'); return {duplicate:true,task:d.tasks[op.taskId]} }
      const known=new Set([...d.superagent.coordinator.inputs.map(i=>i.id),...d.superagent.coordinator.nativeHumanIds])
      if(contract.provenanceIds.some(id=>!known.has(id)))throw failure(400,'unknown human provenance ID')
      const binding=await makeBinding({...contract,text:contractText(contract)})
      const task=this.#task({...binding,contract}); d.tasks[task.id]=task
      task.events.push({type:'coordinator-dispatch',key,at:now(),revision:1})
      d.superagent.operations['dispatch:'+key]={hash,taskId:task.id,assignmentId:task.assignmentId}
      return {duplicate:false,task}
    })
  }
  amend(key, id, assignmentId, revision, text, provenanceIds=[]) {
    bounded(key,'amend key',160); bounded(text,'amendment',8000)
    if(!Array.isArray(provenanceIds)||provenanceIds.length>30||provenanceIds.some(id=>typeof id!=='string'))throw failure(400,'invalid provenance IDs')
    const hash=fingerprint([id,assignmentId,revision,text,provenanceIds])
    return this.#tx(d=>{
      const prior=d.superagent.operations['amend:'+key]
      if(prior) { if(prior.hash!==hash)throw failure(409,'amend key conflict'); return {duplicate:true,task:d.tasks[id]} }
      const task=d.tasks[id]
      if(!task||task.state==='stopped'||task.assignmentId!==assignmentId||task.revision!==revision)throw failure(409,'stale or stopped assignment/revision')
      if(provenanceIds.some(id=>!d.superagent.coordinator.inputs.some(i=>i.id===id)&&!d.superagent.coordinator.nativeHumanIds.includes(id)))throw failure(400,'unknown human provenance ID')
      task.revision++
      this.#follow(task,`Targeted amendment / task ${id} / assignment ${assignmentId} / revision ${task.revision}\n${text}`)
      task.amendments ??= []; task.amendments.push({key,text,revision:task.revision,assignmentId,provenanceIds,at:now()})
      task.events.push({type:'coordinator-amend',key,revision:task.revision,at:now()})
      d.superagent.operations['amend:'+key]={hash,taskId:id}
      return {duplicate:false,task}
    })
  }
  retry(key,id,assignmentId,revision) {
    bounded(key,'retry key',160);const hash=fingerprint([id,assignmentId,revision])
    return this.#tx(d=>{
      const prior=d.superagent.operations['retry:'+key]
      if(prior){if(prior.hash!==hash)throw failure(409,'retry key conflict');return {duplicate:true,task:d.tasks[id]}}
      const task=d.tasks[id]
      if(!task||!['failed','blocked'].includes(task.state)||task.assignmentId!==assignmentId||task.revision!==revision)throw failure(409,'retry requires current failed/blocked assignment')
      const old=task.attempts.at(-1);old.retiredAt=now();old.state=task.state
      task.assignmentId=randomUUID();task.sessionId=`workbench-${task.id}-${task.assignmentId}`
      task.attempts.push({id:task.assignmentId,sessionId:task.sessionId,at:now()})
      for(const i of task.inputs)i.status='canceled'
      const payload=task.contract?contractText(task.contract,task.revision):task.text
      task.inputs.push(input(payload+'\nExplicit targeted amendments:\n'+JSON.stringify(task.amendments||[])))
      task.state='waiting';delete task.native
      task.events.push({type:'coordinator-retry',key,assignmentId:task.assignmentId,at:now()})
      d.superagent.operations['retry:'+key]={hash,taskId:id}
      return {duplicate:false,task}
    })
  }
  enqueue(destination, content, taskId = null) {
    return this.#tx(d => {
      if (taskId) { const t = d.tasks[taskId]; return t ? this.#outbox(d, t, content) : false }
      const id = randomUUID(); d.outbox.push({ id, taskId, destination, content, status: 'pending', attempts: 0 }); return id
    })
  }
  pendingOutbox() { return this.#state.outbox.filter(x => this.canDispatch(x.id)).map(x => structuredClone(x)) }
  canDispatch(id) { const r = this.#state.outbox.find(x => x.id === id); return !!r && r.status === 'pending' && (!r.taskId || this.#state.tasks[r.taskId]?.state !== 'stopped') }
  markOutbox(id, status) { return this.#tx(d => { const r = d.outbox.find(x => x.id === id); if (!r || r.status !== 'pending') return false; r.status = status; r.attempts++; r.updatedAt = now(); return true }) }
}
