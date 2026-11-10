import { createHmac, timingSafeEqual } from 'node:crypto'
export const failure = (status, message) => Object.assign(Error(message), { status })
export function constantEqual(a, b) { if (typeof a !== 'string' || typeof b !== 'string') return false; const x=Buffer.from(a),y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y) }
export function webhookSignature(c, secret, h, raw) {
  const fields = ['v1',h['x-dsh-timestamp'],c.adapter,c.account,h['x-dsh-actor'],h['x-dsh-room'],h['x-dsh-event-id'],h['x-dsh-thread'] || h['x-dsh-event-id'],h['x-dsh-addressed'] || '',h['x-dsh-bot'] || 'false',h['x-dsh-task-id'] || '',raw]
  return 'sha256='+createHmac('sha256',secret).update(JSON.stringify(fields)).digest('hex')
}
// Transport port: authenticate trusted HTTP metadata -> envelope; send persisted outbox row.
export class SignedWebhookAdapter {
  constructor(config, { secret='', outboundUrl='', outboundSecret='' } = {}) {
    this.config=config; this.secret=secret; this.outboundUrl=outboundUrl; this.outboundSecret=outboundSecret
    if(outboundUrl && !outboundSecret) throw Error('outbound signing secret is required')
    if (config.adapter !== 'signed-webhook') throw Error('unsupported adapter')
    if (outboundUrl) { const u=new URL(outboundUrl); if (u.protocol!=='http:' || !['127.0.0.1','[::1]'].includes(u.hostname) || u.username || u.password) throw Error('outbound target must be a literal loopback HTTP URL') }
  }
  authenticate(h,raw) {
    const c=this.config
    if (!this.secret || !c.allowedActors?.length || !c.allowedRooms?.length) throw failure(403,'ingress disabled')
    const actor=h['x-dsh-actor'], room=h['x-dsh-room'], message=h['x-dsh-event-id'], thread=h['x-dsh-thread'] || message
    if (!c.allowedActors.includes(actor) || !c.allowedRooms.includes(room) || actor===c.selfActor || (h['x-dsh-bot'] || 'false')!=='false') throw failure(403,'sender, room or echo denied')
    if (!Number.isFinite(Number(h['x-dsh-timestamp'])) || Math.abs(Date.now()-Number(h['x-dsh-timestamp'])*1000)>300000) throw failure(401,'stale signature')
    if (!constantEqual(h['x-dsh-signature'],webhookSignature(c,this.secret,h,raw))) throw failure(401,'bad signature')
    if (![message,thread,actor,room].every(x=>typeof x==='string' && x.length>0 && x.length<=200) || !['direct','mention'].includes(h['x-dsh-addressed'])) throw failure(400,'invalid identity or explicit addressing')
    let body; try { body=JSON.parse(raw) } catch { throw failure(400,'invalid JSON') }
    if (!body || typeof body.text!=='string' || !body.text.trim() || body.text.length>12000 || Object.keys(body).some(k=>k!=='text')) throw failure(400,'only nonempty text is accepted')
    return {adapter:c.adapter,account:c.account,conversation:room,thread,message,actor,text:body.text,addressed:h['x-dsh-addressed'],taskId:h['x-dsh-task-id'] || null}
  }
  async send(row, signal) {
    if (!this.outboundUrl) throw Error('outbound adapter not configured')
    const payload=JSON.stringify({id:row.id,taskId:row.taskId,destination:row.destination,content:row.content})
    const signature='sha256='+createHmac('sha256',this.outboundSecret).update(row.id+'.'+payload).digest('hex')
    const response=await fetch(this.outboundUrl,{method:'POST',redirect:'error',headers:{'content-type':'application/json','x-dsh-message-id':row.id,'x-dsh-signature':signature},body:payload,signal})
    await response.body?.cancel()
    if (!response.ok) throw Error(`receiver returned ${response.status}`)
  }
}
