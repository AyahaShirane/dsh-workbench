import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { WorkbenchStore, eventKey } from '../src/store.js'
import { canonicalRoot, resolveInside } from '../src/workspaces.js'

async function temp(t) {
  const dir = await mkdtemp(join(process.cwd(), '.test-tmp-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('event identity includes adapter and account; duplicate intake is atomic', async t => {
  const dir = await temp(t)
  const store = await WorkbenchStore.open(join(dir, 'state.json'))
  const event = { adapter: 'webhook', account: 'a', conversation: 'room', thread: 't', message: 'm', actor: 'u', text: 'Research this topic' }
  const bind = async () => ({ text: event.text, workspace: join(dir, 'task'), channel: { adapter: 'webhook', account: 'a', conversation: 'room', thread: 't' }, sessionId: 's1' })
  const [a, duplicate, b] = await Promise.all([
    store.accept(event, bind), store.accept(event, bind),
    store.accept({ ...event, account: 'b' }, bind),
  ])
  assert.equal(a.duplicate, false)
  assert.equal(duplicate.duplicate, true)
  assert.equal(a.task.id, duplicate.task.id)
  assert.notEqual(a.task.id, b.task.id)
  assert.equal(eventKey(event), eventKey({ ...event }))
})

test('task binding survives reopen, follow-up, stop, and rejects stale reports', async t => {
  const dir = await temp(t)
  const file = join(dir, 'state.json')
  let store = await WorkbenchStore.open(file)
  const task = await store.createTask({ text: 'Organize these notes', workspace: join(dir, 'task'), channel: { adapter: 'webhook', account: 'local', conversation: 'c', thread: 't' }, sessionId: 'session-1', projectId: null })
  await store.followUp(task.id, 'Add a short summary')
  store = await WorkbenchStore.open(file)
  const rebound = store.getTask(task.id)
  assert.equal(rebound.sessionId, 'session-1')
  assert.equal(rebound.channel.conversation, 'c')
  assert.equal(rebound.followUps.length, 1)
  await store.stop(task.id)
  assert.equal(await store.report(task.id, { state: 'ready', text: 'late' }), false)
  assert.equal(store.getTask(task.id).state, 'stopped')
})

test('outbox retry keeps an id and bound destination through storage reopen', async t => {
  const dir = await temp(t)
  const file = join(dir, 'state.json')
  let store = await WorkbenchStore.open(file)
  const binding = { adapter: 'webhook', account: 'local', conversation: 'c', thread: 't' }
  const id = await store.enqueue(binding, 'correlated response')
  store = await WorkbenchStore.open(file)
  const pending = store.pendingOutbox()
  assert.equal(pending.length, 1)
  assert.equal(pending[0].id, id)
  assert.deepEqual(pending[0].destination, binding)
})

test('canonical roots accept non-Git directories and reject traversal and symlink escapes', async t => {
  const dir = await temp(t)
  const root = join(dir, 'plain-project')
  await mkdir(root)
  await mkdir(join(dir, 'outside'))
  const canonical = await canonicalRoot(root)
  assert.equal(await resolveInside(canonical, 'notes/today.txt'), join(root, 'notes/today.txt'))
  await assert.rejects(resolveInside(canonical, '../outside/secret'), /outside|traversal/i)
  await symlink(join(dir, 'outside'), join(root, 'escape'))
  await assert.rejects(resolveInside(canonical, 'escape/secret'), /outside|symlink/i)
})

test('changing thread cannot change the identity of the same source message', () => {
  const e = { adapter: 'signed-webhook', account: 'a', conversation: 'room', message: 'm', thread: 'one' }
  assert.equal(eventKey(e), eventKey({ ...e, thread: 'tampered' }))
})

test('stop rejects new outbox messages and durable pending input survives reopen', async t => {
  const dir = await temp(t), file = join(dir, 'state.json')
  let store = await WorkbenchStore.open(file)
  const task = await store.createTask({ text: 'Initial question', workspace: dir, sessionId: 'native-session', channel: { adapter: 'signed-webhook', conversation: 'fixed' } })
  await store.followUp(task.id, 'Durable follow-up')
  store = await WorkbenchStore.open(file)
  assert.equal(store.getTask(task.id).inputs.filter(x => x.status === 'pending').length, 2)
  await store.stop(task.id)
  assert.equal(await store.enqueue({ conversation: 'attacker' }, 'late', task.id), false)
  assert.equal(await store.followUp(task.id, 'late'), false)
  assert.equal(store.pendingOutbox().length, 0)
})

test('exclusive storage ownership and failed writes cannot publish speculative state', async t => {
  const dir=await temp(t),file=join(dir,'state.json')
  const store=await WorkbenchStore.open(file,{exclusive:true})
  await assert.rejects(WorkbenchStore.open(file,{exclusive:true}),/owned|live/)
  const task=await store.createTask({text:'Original',workspace:dir,sessionId:'native',channel:{conversation:'fixed'}})
  await rename(file,file+'.backup');await mkdir(file)
  await assert.rejects(store.followUp(task.id,'must not appear'))
  assert.equal(store.getTask(task.id).followUps.length,0)
  await rm(file,{recursive:true});await rename(file+'.backup',file)
  await store.followUp(task.id,'committed')
  const out=await store.enqueue({conversation:'evil'},'bound response',task.id)
  assert.equal(store.pendingOutbox().find(row=>row.id===out).destination.conversation,'fixed')
  await store.close()
  const reopened=await WorkbenchStore.open(file,{exclusive:true});assert.equal(reopened.getTask(task.id).followUps.length,1);await reopened.close()
})

test('replacing a configured artifact root with an outside symlink is rejected', async t => {
  const dir=await temp(t),root=await canonicalRoot(join(dir,'root'))
  await mkdir(join(dir,'outside'));await rename(root,root+'-old');await symlink(join(dir,'outside'),root)
  await assert.rejects(resolveInside(root,'file.txt'),/root changed|symlink/)
})
