import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
// Build/module protocol smoke test; actual browser acceptance is a separate host suite.
test('shipped client uses real DSH module ID, keyed root panel and native session navigation',async()=>{
 const pkg=JSON.parse(await readFile('package.json','utf8')),source=await readFile('src/client.js','utf8')
 assert.equal(pkg.exports['./client'],'./src/client.js');assert.equal(pkg.dsh.client.platform,'web')
 let exported,id
 vm.runInNewContext(source,{window:{__ModuleLoader__:{load(row){id=row.id;exported=row.factory(name=>{
  if(name==='react')return {createElement:(component,props,...children)=>({component,props,children})}
  if(name==='@deepseek-ai/dsh-client-ui-primitives')return {}
  throw Error('unexpected external '+name)
 })}}}})
 assert.equal(id,pkg.name)
 const slots=[],opened=[]
 const dictionaries=[]
 exported.apply({effect:fn=>fn(),locale:{register:(ns,catalog)=>dictionaries.push({ns,catalog})},slots:{inject:(_name,fn)=>fn(),register:(options,component)=>{slots.push({options,component});return()=>{}}},uiWorkspace:{openSession:id=>opened.push(id)}})
 const main=slots.find(r=>r.options.name==='main'),sidebar=slots.find(r=>r.options.name==='sidebar.panellist')
 assert.equal(main.options.key,sidebar.options.id);assert.equal(sidebar.options.id,'superagent');assert.ok(sidebar.options.order>0)
 assert.equal(main.options.locale,'workbench');assert.equal(dictionaries[0].ns,'workbench');assert.deepEqual(Object.keys(dictionaries[0].catalog.zh).sort(),Object.keys(dictionaries[0].catalog.en).sort())
 main.options.inject().openSession('canonical-native-session');assert.deepEqual(opened,['canonical-native-session'])
 assert.ok(source.includes('--dsw-alias-bg-layer-1'));assert.ok(source.includes('--dsh-font-family-text'));assert.ok(!source.includes('<iframe'));assert.ok(!source.includes('document.body.style'))
})
