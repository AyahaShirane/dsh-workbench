import test from 'node:test'
import assert from 'node:assert/strict'
import {accountNativeSession} from '../src/native-workspace.js'

test('native Session accounting resolves one Workspace and attaches its canonical identity',async()=>{
 const calls=[]
 const entity={attachSession:async id=>calls.push(['attach',id])}
 const ctx={get(name){return name==='workspaceController'?{create:async request=>{calls.push(['create',request.path]);return{workspace:{workspaceId:'workspace-id'}}}}:name==='workspaceRegistry'?{get:id=>{calls.push(['get',id]);return entity}}:undefined}}
 assert.equal((await accountNativeSession(ctx,'/canonical/project','native-session')).workspaceId,'workspace-id')
 assert.deepEqual(calls,[['create','/canonical/project'],['get','workspace-id'],['attach','native-session']])
})

test('socketless harness without the native Workspace API remains supported',async()=>{
 assert.equal(await accountNativeSession({get:()=>undefined},'/synthetic','native-session'),false)
})
