import test from 'node:test'
import assert from 'node:assert/strict'
import {html} from '../src/ui.js'
import {messages,translate,resolveLanguage} from '../src/locale.js'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'

test('standalone catalogs have reciprocal English and Chinese coverage',()=>{
 const en=Object.keys(messages.en),zh=Object.keys(messages['zh-CN'])
 assert.deepEqual(new Set(en.map(key=>messages.en[key])),new Set(zh))
 for(const key of en){assert.ok(messages.en[key]);assert.ok(messages['zh-CN'][messages.en[key]])}
 assert.equal(translate('工作空间','en'),'Workspace')
 assert.equal(translate('Workspace','zh-CN'),'工作空间')
 assert.equal(translate('此操作不允许。','en'),'This action is not allowed.')
 assert.equal(translate('This action is not allowed.','zh-CN'),'此操作不允许。')
 assert.equal(translate('任务不存在','en'),'Task not found')
 assert.equal(translate('untranslated user content','en'),'untranslated user content')
 assert.equal(resolveLanguage('', 'zh-TW'),'zh-CN')
 assert.equal(resolveLanguage('', 'en-US'),'en')
 assert.equal(resolveLanguage('en','zh-CN'),'en')
})

test('production standalone render exposes the language control and English default',()=>{
 assert.match(html,/<html lang="en">/)
 assert.match(html,/<select id="language" aria-label="Language \/ 语言">/)
 assert.match(html,/window\.WB_LOCALE=/)
 assert.match(html,/<script>window\.WB_LOCALE=/)
 assert.match(html,/applyLanguage/)
})

test('production DOM translation is idempotent, reversible, and respects outside updates',async()=>{
 const source=await readFile(new URL('../src/dashboard-client.js',import.meta.url),'utf8')
 const code=source.slice(source.indexOf('const catalogs='),source.indexOf("const requested="))
 const text={nodeType:3,nodeValue:'任务与工作记录'}
 const attrs=new Map([['title','任务工作台']])
 const element={childNodes:[text],closest:()=>null,hasAttribute:key=>attrs.has(key),getAttribute:key=>attrs.get(key),setAttribute:(key,value)=>attrs.set(key,value)}
 const userText={nodeType:3,nodeValue:'任务与工作记录'},userElement={childNodes:[userText],closest:()=>userElement,hasAttribute:()=>false}
 const picker={value:''},document={documentElement:{lang:''},querySelectorAll:()=>[element,userElement],querySelector:()=>picker}
 const context={window:{WB_LOCALE:messages},document,localStorage:{setItem(){}},Node:{TEXT_NODE:3}}
 vm.runInNewContext(code,context)
 context.applyLanguage('en');context.applyLanguage('en')
 assert.equal(text.nodeValue,'Tasks and work records')
 assert.equal(attrs.get('title'),'Task Workbench')
 assert.equal(userText.nodeValue,'任务与工作记录')
 context.applyLanguage('zh-CN');context.applyLanguage('zh-CN')
 assert.equal(text.nodeValue,'任务与工作记录')
 assert.equal(attrs.get('title'),'任务工作台')
 text.nodeValue='outside update';context.applyLanguage('en')
 assert.equal(text.nodeValue,'outside update')
 assert.equal(document.documentElement.lang,'en')
})
