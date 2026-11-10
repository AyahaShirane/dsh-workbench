import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
async function until(fn,ms=10000){const start=Date.now();while(Date.now()-start<ms){try{const value=await fn();if(value)return value}catch(e){if(e.fatal)throw e}await delay(70)}throw Error('browser operation timed out')}
export async function browserEvidence(origin,token,dir,env) {
  const profile=join(process.cwd(),'.workbench','browser-'+randomUUID().slice(0,8)),temp=join(process.cwd(),'.ct',randomUUID().slice(0,4));await mkdir(profile,{recursive:true});await mkdir(temp,{recursive:true});await writeFile(join(profile,'fonts.conf'),'<fontconfig><include>/etc/fonts/fonts.conf</include><cachedir>'+join(profile,'font-cache')+'</cachedir></fontconfig>')
  const chrome=spawn(process.env.CHROME_BIN || 'chromium',['--headless','--disable-gpu','--disable-breakpad','--disable-crash-reporter','--disable-background-networking','--disable-component-update','--disable-sync','--disable-default-apps','--disable-extensions','--metrics-recording-only','--password-store=basic','--disable-features=MediaRouter,OptimizationHints','--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{env:{...env,TMPDIR:temp,FONTCONFIG_FILE:join(profile,'fonts.conf'),XDG_CACHE_HOME:join(dir,'browser-cache'),XDG_CONFIG_HOME:join(dir,'browser-config'),DBUS_SESSION_BUS_ADDRESS:'unix:path='+join(temp,'no-dbus')},stdio:['ignore','ignore','pipe']})
  let logs='';chrome.stderr.on('data',b=>logs+=b)
  let ws
  try {
    const port=await until(async()=>{if(chrome.exitCode!==null||chrome.signalCode!==null)throw Object.assign(Error('Chromium exited (code='+chrome.exitCode+', signal='+chrome.signalCode+'): '+logs),{fatal:true});try{return (await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]}catch{return false}})
    const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()
    ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl)
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true})})
    let seq=0;const pending=new Map(),errors=[]
    ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text)})
    const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))})
    const evaluate=async expression=>{const v=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(v.exceptionDetails)throw Error(JSON.stringify(v.exceptionDetails));return v.result.value}
    const evidence=join(process.cwd(),'evidence/dashboard-v0.2');await mkdir(evidence,{recursive:true})
    const click=selector=>evaluate('document.querySelector('+JSON.stringify(selector)+').click()')
    const fill=(selector,text)=>evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');e.value='+JSON.stringify(text)+';e.dispatchEvent(new Event("input",{bubbles:true}))})()')
    const shot=async name=>{const v=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(evidence,name),Buffer.from(v.data,'base64'))}
    await call('Page.enable');await call('Runtime.enable');await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await call('Page.navigate',{url:origin+'/workbench'})
    await until(()=>evaluate("document.readyState==='complete' && !!document.querySelector('#save')"))
    assert.ok(await evaluate("document.querySelector('#auth').open"))
    await fill('#token',token);await click('#save')
    await until(()=>evaluate("!document.querySelector('#auth').open && document.querySelector('#project').options.length===3"))
    await evaluate("document.querySelector('#language').value='en';document.querySelector('#language').dispatchEvent(new Event('change',{bubbles:true}))")
    assert.equal(await evaluate('document.documentElement.lang'),'en')
    assert.ok(await evaluate("document.querySelector('#page-title').textContent==='Tasks and work records'"))
    await shot('operate-en-1440.png')
    await evaluate("document.querySelector('#language').value='zh-CN';document.querySelector('#language').dispatchEvent(new Event('change',{bubbles:true}))")
    assert.equal(await evaluate('document.documentElement.lang'),'zh-CN')
    assert.ok(await evaluate("document.querySelector('#page-title').textContent==='任务与工作记录'"))
    await click('#new-task');await fill('#title','浏览器合成研究任务');await fill('#prompt','<img src=x onerror="window.XSS=1"> 合成材料，不执行 HTML')
    await click('#create');await click('#create')
    await until(()=>evaluate("document.querySelector('#detail').textContent.includes('浏览器合成研究任务') && !document.querySelector('#composer').open"))
    const first=await evaluate('location.hash');assert.ok(first.length>20)
    assert.ok(await evaluate("document.querySelector('#detail').textContent.includes('lead')"))
    assert.ok(await evaluate("document.querySelector('#detail').textContent.includes('未配置可用的 DSH 模型')"))
    assert.equal(await evaluate('window.XSS||0'),0)
    assert.equal(await evaluate("document.querySelectorAll('#detail img').length"),0)
    await fill('#followup','任务一独立草稿')
    await evaluate("document.querySelector('#followup').focus()")
    await delay(4400)
    assert.equal(await evaluate("document.querySelector('#followup').value"),'任务一独立草稿')
    assert.equal(await evaluate('document.activeElement.id'),'followup')
    await click('[data-view="projects"]');assert.ok(await evaluate("document.querySelector('#other-view').textContent.includes('非 Git 资料 A')"))
    await click('[data-view="operate"]')
    await click('#new-task');await fill('#title','浏览器项目任务二');await fill('#prompt','独立项目合成资料');await evaluate("document.querySelector('#project').value='a';document.querySelector('#project').dispatchEvent(new Event('input'))")
    await click('#close-composer');await click('#new-task');assert.equal(await evaluate("document.querySelector('#title').value"),'浏览器项目任务二')
    await click('#create');await until(()=>evaluate("document.querySelector('#detail').textContent.includes('浏览器项目任务二')"))
    const second=await evaluate('location.hash');assert.notEqual(first,second)
    assert.equal(await evaluate("document.querySelector('#followup').value"),'')
    await fill('#followup','任务二独立草稿')
    await evaluate('location.hash='+JSON.stringify(first));await until(()=>evaluate("document.querySelector('#followup').value==='任务一独立草稿'"))
    await call('Page.reload');await until(()=>evaluate("document.querySelector('#detail').textContent.includes('浏览器合成研究任务')"))
    assert.equal(await evaluate('location.hash'),first);assert.equal(await evaluate("document.querySelector('#followup').value"),'任务一独立草稿')
    await fill('#search','浏览器合成研究任务');await until(()=>evaluate("document.querySelectorAll('#tasks .task').length===1"));assert.equal(await evaluate("document.querySelector('#task-count').textContent"),'1 项')
    await fill('#search','');await delay(400)
    await fill('#followup','浏览器补充说明');await click('#send-followup')
    await until(()=>evaluate("document.querySelector('#input-status').textContent.includes('2 条')"))
    // Actual scoped native tools create a report and registered file in this synthetic task.
    const probe=async kind=>{const r=await fetch(origin+'/__acceptance/probe',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({taskId:first.slice(1),kind})});assert.equal(r.status,200)}
    await probe('report');await probe('artifact');await click('#refresh')
    await until(()=>evaluate("document.querySelector('#detail').textContent.includes('Which source') && document.querySelector('.artifact')"))
    await click('.artifact button');await until(()=>evaluate("document.querySelector('#preview-text').textContent.includes('synthetic verified file')"));await click('#close-preview')
    await shot('operate-1440.png')
    await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await delay(150)
    assert.ok(await evaluate('document.documentElement.scrollWidth<=window.innerWidth+1'));await shot('operate-390.png')
    await click('#back-list');await delay(4200);assert.equal(await evaluate("document.querySelector('#work-view').classList.contains('selected')"),false)
    await shot('queue-390.png');await click('[data-task-id="'+first.slice(1)+'"]');await until(()=>evaluate("document.querySelector('#work-view').classList.contains('selected')"))
    await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false})
    await click('#stop-task');assert.ok(await evaluate("document.querySelector('#stop-confirm').open"));await click('#cancel-stop');assert.equal(await evaluate("document.querySelector('#stop-task').disabled"),false)
    await click('#stop-task')
    // Changing the selection behind the modal must not change its captured target.
    await evaluate('location.hash='+JSON.stringify(second))
    await until(()=>evaluate("document.querySelector('#detail').textContent.includes('浏览器项目任务二')"))
    assert.ok(await evaluate("document.querySelector('#stop-confirm').open"))
    await click('#confirm-stop');await until(()=>evaluate("!document.querySelector('#stop-confirm').open && !document.body.hasAttribute('aria-busy')"))
    const taskState=async hash=>{const r=await fetch(origin+'/workbench/api/tasks/'+hash.slice(1),{headers:{authorization:'Bearer '+token}});assert.equal(r.status,200);return (await r.json()).task.state}
    assert.equal(await taskState(first),'stopped')
    assert.equal(await taskState(second),'waiting')
    assert.equal(await evaluate('location.hash'),second)
    assert.equal(await evaluate("document.querySelector('#stop-task').disabled"),false)
    await evaluate('location.hash='+JSON.stringify(first));await until(()=>evaluate("document.querySelector('#stop-task').disabled && document.querySelector('#detail').textContent.includes('已停止')"))
    await call('Page.reload');await until(()=>evaluate("document.querySelector('#stop-task').disabled && document.querySelector('#detail').textContent.includes('已停止')"))
    await click('[data-view="monitor"]');await shot('monitor-1440.png')
    await click('[data-view="settings"]');assert.ok(await evaluate("document.querySelector('#other-view').textContent.includes('认证独立')"));await shot('settings-1440.png')
    await click('#logout');assert.ok(await evaluate("document.querySelector('#auth').open && !sessionStorage.getItem('wb-token')"))
    assert.deepEqual(errors,[])
    await writeFile(join(evidence,'browser-readback.txt'),await evaluate('document.body.innerText'))
    const result={passed:true,synthetic:true,browser:'Chromium 1208 via actual CDP',actions:['authenticate','composer general + project','double submit guard','XSS inert','independent drafts + poll focus','deep-link reload','search and count','native report/artifact preview','1440 and 390 no overflow','stop cancel/confirm/reload','stop target stable across hash change','projects/settings','logout']}
    await writeFile(join(evidence,'browser-result.json'),JSON.stringify(result,null,2));return result
  } finally {
    ws?.close();chrome.kill('SIGTERM');await until(()=>chrome.exitCode!==null||chrome.signalCode!==null,5000).catch(()=>chrome.kill('SIGKILL'))
    await writeFile(join(process.cwd(),'evidence/dashboard-v0.2/browser-process.log'),logs)
  }
}
