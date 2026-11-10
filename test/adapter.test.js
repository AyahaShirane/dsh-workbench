import test from 'node:test'
import assert from 'node:assert/strict'
import { SignedWebhookAdapter, webhookSignature } from '../src/adapter.js'
const config = { adapter: 'signed-webhook', account: 'test', allowedActors: ['alice'], allowedRooms: ['room'], selfActor: 'bot' }
const raw = JSON.stringify({text:'整理资料'})
const base = { 'x-dsh-timestamp': String(Math.floor(Date.now()/1000)), 'x-dsh-actor':'alice', 'x-dsh-room':'room', 'x-dsh-event-id':'one', 'x-dsh-thread':'thread-a', 'x-dsh-addressed':'direct' }
test('signature binds thread, addressing and follow-up target; identity ignores thread', () => {
  const a = new SignedWebhookAdapter(config, { secret:'test-only' })
  const headers = {...base, 'x-dsh-signature':webhookSignature(config, 'test-only', base, raw)}
  assert.equal(a.authenticate(headers, raw).thread, 'thread-a')
  for (const [key,value] of [['x-dsh-thread','thread-b'],['x-dsh-task-id','another-task'],['x-dsh-addressed','mention']]) {
    assert.throws(()=>a.authenticate({...headers,[key]:value},raw), /signature/)
  }
  assert.throws(()=>a.authenticate(headers, JSON.stringify({text:'x',role:'admin'})), /signature/)
})
test('empty admission denies; self and bot echoes suppressed; stale signatures rejected', () => {
  assert.throws(()=>new SignedWebhookAdapter({...config,allowedActors:[]},{secret:'test-only'}).authenticate(base,raw), /disabled/)
  const a = new SignedWebhookAdapter(config,{secret:'test-only'})
  assert.throws(()=>a.authenticate({...base,'x-dsh-bot':'true'},raw), /sender|echo/)
  assert.throws(()=>a.authenticate({...base,'x-dsh-timestamp':'1'},raw), /stale/)
})
