import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
async function until(fn,ms=10000){const start=Date.now();while(Date.now()-start<ms){try{const value=await fn();if(value)return value}catch(e){if(e.fatal)throw e}await delay(70)}throw Error('browser operation timed out')}
export async function superagentBrowserEvidence(nativeUrl,token,dir,env) {
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
    const evidence=join(process.cwd(),'evidence/superagent-v0.3');await mkdir(evidence,{recursive:true})
    const pointerClick=async selector=>{const p=await until(()=>evaluate('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');if(!e||e.disabled||e.closest("[inert]"))return null;e.scrollIntoView({block:"center",inline:"center"});const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width&&r.height&&s.visibility!=="hidden"&&s.display!=="none"?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()'));assert.ok(p,'visible browser target: '+selector);await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x,y:p.y});await call('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1})}
    const fill=async(selector,text)=>{await pointerClick(selector);await call('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:2});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2});await call('Input.insertText',{text})}
    const textPoint=text=>evaluate('(()=>{const e=[...document.querySelectorAll("button,a")].find(e=>e.textContent.trim()==='+JSON.stringify(text)+');if(!e)return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()')
    const clickText=async text=>{const p=await textPoint(text);assert.ok(p,'visible button/link text: '+text);await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x,y:p.y});await call('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1})}
    const dismissBlockingModal=async()=>{const p=await evaluate('(()=>{const d=document.querySelector("[role=dialog],dialog");if(!d)return false;const e=[...d.querySelectorAll("button")].find(b=>/^(close|关闭|×|✕|x)$/i.test((b.getAttribute("aria-label")||b.getAttribute("title")||b.textContent).trim()));if(!e)return {unhandled:true};const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');if(p&&p.unhandled)throw Error('blocking DSH modal has no accessible dismiss control');if(p){await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x,y:p.y});await call('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1});await until(()=>evaluate('!document.querySelector("[role=dialog],dialog")'));await delay(300)}}
    const shot=async name=>{const v=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(join(evidence,name),Buffer.from(v.data,'base64'))}
    const openNative=async()=>{const s='button[aria-label*="Superagent"]';await until(()=>evaluate('!!document.querySelector('+JSON.stringify(s)+')'));await pointerClick(s);await until(()=>evaluate('!!document.querySelector(".wb-native")'))}
    let settingsOpen=false
    const setNativeLanguage=async language=>{if(!settingsOpen){await pointerClick('[aria-label="Account menu"]');await clickText('Settings');settingsOpen=true}const current=language==='zh-CN'?'English':'中文',target=language==='zh-CN'?'中文':'English';await until(()=>textPoint(current));await clickText(current);await until(()=>textPoint(target));await clickText(target);await until(()=>evaluate(language==='zh-CN'?'document.querySelector(".wb-native h1")?.textContent.includes("工作台")':'document.querySelector(".wb-native h1")?.textContent==="Superagent / Workbench"'));if(language==='en'){await clickText('Close');settingsOpen=false}}
    await call('Page.enable');await call('Runtime.enable');await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await call('Page.navigate',{url:nativeUrl})
    await until(()=>evaluate('!!document.querySelector("button[aria-label*=Superagent]")'))
    // DSH mounts its native first-run/preview dialog asynchronously after the panel; let it finish before touching controls behind it.
    await delay(1700)
    await dismissBlockingModal()
    await until(()=>evaluate('!document.querySelector("[role=dialog],dialog")'));await delay(250)
    await openNative();await delay(1700);await dismissBlockingModal();await until(()=>evaluate('!document.querySelector("[role=dialog],dialog")'))
    assert.equal(await evaluate('document.querySelectorAll("iframe").length'),0)
    assert.ok(await evaluate('!!document.querySelector(".wb-native [data-testid=operator-token]")'),'native operator authentication gate is visible')
    await fill('.wb-native [data-testid=operator-token]',token);await pointerClick('.wb-native [data-testid=auth-submit]')
    await until(()=>evaluate('!!document.querySelector(".wb-native [data-testid=coordinator-open]:not([disabled])")'))
    assert.ok((await evaluate('document.querySelector(".wb-native").textContent')).includes('Model unavailable'))
    await fill('.wb-native [data-testid=coordinator-input]','Browser synthetic discussion B; do not dispatch')
    await setNativeLanguage('zh-CN')
    assert.equal(await evaluate('document.querySelector(".wb-native [data-testid=coordinator-input]").value'),'Browser synthetic discussion B; do not dispatch','native draft survives real DSH locale change')
    await setNativeLanguage('en')
    await pointerClick('.wb-native [data-testid=coordinator-send]')
    await until(()=>evaluate('!document.querySelector(".wb-native") && !!document.querySelector("textarea,[contenteditable=true]")'))
    await openNative();await shot('native-panel-1440.png')
    const themeBefore=await evaluate('document.body.hasAttribute("data-ds-dark-theme")'),colors=[]
    for(const theme of ['light','dark']){await evaluate('document.body.toggleAttribute("data-ds-dark-theme",'+JSON.stringify(theme==='dark')+')');await delay(100);colors.push(await evaluate('getComputedStyle(document.querySelector(".wb-native")).getPropertyValue("--dsw-alias-bg-base").trim()'));await shot('native-panel-'+theme+'.png')}
    assert.ok(colors.every(Boolean),'native theme tokens must resolve');assert.notEqual(colors[0],colors[1],'native light/dark palettes must differ');await evaluate('document.body.toggleAttribute("data-ds-dark-theme",'+JSON.stringify(themeBefore)+')')
    await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await delay(200);assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));await shot('native-panel-390.png');await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false})
    await until(()=>evaluate('!!document.querySelector(".wb-native [data-testid=task-row]")'));await pointerClick('.wb-native [data-testid=task-row]');await until(()=>evaluate('!!document.querySelector(".wb-native [data-testid=task-detail] button")'))
    await pointerClick('.wb-native [data-testid=task-detail] button:first-of-type');await until(()=>evaluate('!document.querySelector(".wb-native") && !!document.querySelector("textarea,[contenteditable=true]")'));await shot('executor-native-chat.png')
    await openNative();await pointerClick('.wb-native [data-testid=coordinator-open]');await until(()=>evaluate('!document.querySelector(".wb-native") && !!document.querySelector("textarea,[contenteditable=true]")'));await shot('coordinator-native-chat.png')
    await openNative();await pointerClick('.wb-native [data-testid=task-row]');await until(()=>evaluate('!!document.querySelector(".wb-native [data-testid=task-detail] button:nth-of-type(2)")'))
    await evaluate('window.__nativeConfirm=window.confirm;window.confirm=(message)=>{window.__nativeConfirmShown=true;window.__nativeConfirmMessage=message;return false}')
    await pointerClick('.wb-native [data-testid=task-detail] button:nth-of-type(2)');await until(()=>evaluate('window.__nativeConfirmShown===true'));assert.ok(await evaluate('!/[\\u3400-\\u9fff]/.test(window.__nativeConfirmMessage)'),'stop confirmation uses the active English locale');await evaluate('window.confirm=window.__nativeConfirm')
    await setNativeLanguage('zh-CN');await shot('native-settings-zh.png');await setNativeLanguage('en')
    await pointerClick('.wb-native [data-testid=task-row]');await until(()=>evaluate('!!document.querySelector(".wb-native [data-testid=task-detail]")'))
    assert.ok((await evaluate('document.querySelector(".wb-native [data-testid=task-detail]").textContent')).includes('原生 Host 合成任务'),'user task content remains unchanged through locale switches')
    assert.deepEqual(errors,[])
    const result={passed:true,synthetic:true,actions:['actual root sidebar/main mount','operator authentication gate and submit','coordinator draft survives actual English/Chinese DSH Settings locale changes','coordinator send opens coordinator chat','native token inheritance light/dark','390px no overflow','native executor and coordinator session navigation','return to native panel','stop confirmation cancellation','user task content remains unchanged across locale switches'],themeTokens:colors}
    await writeFile(join(evidence,'native-browser-result.json'),JSON.stringify(result,null,2));return result
  } finally {
    ws?.close();chrome.kill('SIGTERM');await until(()=>chrome.exitCode!==null||chrome.signalCode!==null,5000).catch(()=>chrome.kill('SIGKILL'))
    await writeFile(join(process.cwd(),'evidence/superagent-v0.3/browser-process.log'),logs)
  }
}
