const catalogs=window.WB_LOCALE||{};
let language='en';
const renderedText=new WeakMap(),renderedAttributes=new WeakMap();
function outputFor(source,target){return target==='zh-CN'?(catalogs['zh-CN']?.[source]||source):(catalogs.en?.[source]||source)}
function applyLanguage(value){language=value==='zh-CN'?'zh-CN':'en';localStorage.setItem('workbench-language',language);document.documentElement.lang=language;for(const e of document.querySelectorAll('body *')){if(e.closest('[data-user-content]'))continue;for(const a of ['placeholder','aria-label','title'])if(e.hasAttribute(a)){let attrs=renderedAttributes.get(e);if(!attrs)renderedAttributes.set(e,attrs=new Map());const now=e.getAttribute(a),old=attrs.get(a),source=old&&now===old.output?old.source:now,output=outputFor(source,language);attrs.set(a,{source,output});if(now!==output)e.setAttribute(a,output)}for(const n of e.childNodes)if(n.nodeType===Node.TEXT_NODE&&n.nodeValue.trim()){const now=n.nodeValue,old=renderedText.get(n),source=old&&now===old.output?old.source:now,output=outputFor(source,language);renderedText.set(n,{source,output});if(now!==output)n.nodeValue=output}}const picker=document.querySelector('#language');if(picker)picker.value=language}
const requested=localStorage.getItem('workbench-language');language=requested||(/^zh(?:-|$)/i.test(navigator.language||'')?'zh-CN':'en');
const tr=text=>language==='en'?(catalogs.en?.[text]||text):(catalogs['zh-CN']?.[text]||text);
'use strict';
const $=s=>document.querySelector(s)
const labels={question:'待回答',review:'待审核',running:'运行中',blocked:'受阻',failed:'失败',waiting:'等待中','missing-model':'未配置模型',stopped:'已停止',ready:'待审核'}
const names={operate:['OPERATE / 任务工作台','任务与工作记录'],monitor:['MONITOR / 关注与状态','关注收件箱'],projects:['PROJECTS / 本地项目','项目上下文'],settings:['SETTINGS / 连接与设置','本地连接与设置']}
function readHash(){try{return decodeURIComponent(location.hash.slice(1))}catch{return ''}}
let selected=readHash(),view='operate',data=null,current=null,detailValue=null,busy=false,generation=0,controller=null,timer=null,stoppingId=null,signature='',listSignature='',otherSignature=''
const storage={get:k=>{try{return localStorage.getItem('operate:'+k)||''}catch{return ''}},set:(k,v)=>{try{localStorage.setItem('operate:'+k,v)}catch{notice('浏览器存储不可用，草稿仅在当前页面保留。')}}}
const token=()=>sessionStorage.getItem('wb-token')||''
document.addEventListener('DOMContentLoaded',()=>{applyLanguage(language);$('#language')?.addEventListener('change',e=>{applyLanguage(e.target.value);listSignature=signature=otherSignature='';if(data){renderList();renderOther()}if(detailValue)renderDetail(detailValue)})})
function node(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e}
function userNode(tag,text,cls){const e=node(tag,text,cls);e.dataset.userContent='true';return e}
function button(text,fn,cls='secondary'){const e=node('button',text,cls);e.type='button';e.onclick=fn;return e}
function section(title){const e=node('section',undefined,'section');e.append(node('h2',title));return e}
function countedSection(label,count){const e=node('section',undefined,'section'),h=node('h2');h.append(document.createTextNode(tr(label)),node('span',' '+count));e.append(h);return e}
function uiError(status,raw){if(raw==='missing-model')return tr('Model unavailable');if(raw==='unknown task'||raw==='task not found')return tr('Task not found');if(raw==='artifact changed'||raw==='artifact changed since registration')return tr('Artifact changed since registration');if(raw==='native operation failed; inspect local host log')return tr('The Workbench server request failed. Check the local Host log.');return tr(({401:'Access token is invalid or expired. Connect again.',403:'This action is not allowed.',404:'The requested item was not found.',409:'The task or artifact changed. Refresh and try again.',413:'The request is too large.',415:'Preview supports selected plain-text files up to 64 KiB. Download this file instead.',503:'The Workbench is starting or shutting down. Try again shortly.'})[status]||'The Workbench server request failed. Check the local Host log.')}
function notice(message){$('#message').hidden=!message;$('#message').textContent=message}
function fail(e){if(e.name!=='AbortError')notice(e.message)}
function status(s){return node('span',tr(labels[s]||s),'status '+s)}
function date(at){return at?new Date(at).toLocaleString(language,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'原生记录'}
function openAuth(){if(!$('#auth').open)$('#auth').showModal()}
async function api(path,opts={}){
 const r=await fetch('/workbench/api'+path,{...opts,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token()}})
 let value;try{value=await r.json()}catch{throw Error(tr('Host returned an invalid response. Retry the request.'))}
 if(r.status===401){sessionStorage.removeItem('wb-token');openAuth();throw Error(tr('Access token is invalid or expired. Connect again.'))}
 if(!r.ok)throw Error(uiError(r.status,value.error))
 return value
}
function filters(){return new URLSearchParams({search:$('#search').value,project:$('#project-filter').value,state:$('#state-filter').value}).toString()}
function options(select,projects,general,includeAll=false){const previous=select.value;select.replaceChildren();if(includeAll){const o=node('option','全部项目');o.value='';select.append(o)}for(const p of projects){const o=node('option',p.id==='general'?general:p.name);if(p.id!=='general')o.dataset.userContent='true';o.value=p.id==='general'?(includeAll?'general':''):p.id;select.append(o)}select.value=previous}
function renderList(){
 const sig=JSON.stringify({language,tasks:data.tasks.map(t=>[t.id,t.title,t.text,t.displayState,t.report?.summary]),counts:data.counts,selected,view})
 if(sig===listSignature)return;listSignature=sig
 $('#task-count').textContent=data.total+(language==='en'?(data.total===1?' item':' items'):' 项')
 $('#list-title').textContent=view==='monitor'?(language==='en'?'Status queue · attention first':'状态队列 · 关注优先'):tr('任务队列')
 const counts=data.counts
 $('#attention').replaceChildren(node('b',(counts.question+counts.review+counts.blocked+counts.failed)+(language==='en'?' need attention':' 项需关注')),node('span',(language==='en'?' · ':' · ')+counts.running+(language==='en'?' running · ':' 运行 · ')+(counts.waiting+counts['missing-model'])+(language==='en'?' waiting':' 等待')))
 if(view==='monitor'){const chips=node('div',undefined,'state-counts');for(const key of Object.keys(labels).filter(k=>k!=='ready')){const chip=button('',()=>{$('#state-filter').value=$('#state-filter').value===key?'':key;load()},'quiet');chip.append(document.createTextNode(tr(labels[key])+' '),document.createTextNode(String(counts[key])));chips.append(chip)}$('#attention').append(chips)}
 const list=$('#tasks'),scroll=list.scrollTop,focused=document.activeElement?.dataset.taskId;list.replaceChildren()
 const rows=view==='monitor'?[...data.tasks].sort((a,b)=>Number(data.attention.includes(b.id))-Number(data.attention.includes(a.id))):data.tasks
 if(!rows.length)list.append(node('div',data.total?'当前没有需要关注的任务。可切换 OPERATE 查看全部。':'没有匹配任务。调整筛选，或新建一项工作。','empty'))
 for(const t of rows){const e=button('',()=>selectTask(t.id),'task'+(selected===t.id?' active':''));e.dataset.taskId=t.id;e.setAttribute('aria-pressed',String(selected===t.id));e.append(userNode('span',t.title||t.text.split('\n')[0],'task-title'));const project=data.projects.find(p=>p.id===t.projectId),meta=node('div',undefined,'task-meta');meta.append(status(t.displayState),project?userNode('span',project.name):node('span',tr('通用任务')));e.append(meta,userNode('div',t.report?.summary||t.text,'task-excerpt'));list.append(e)}if(focused)[...list.children].find(e=>e.dataset.taskId===focused)?.focus({preventScroll:true});list.scrollTop=scroll;applyLanguage(language)
}
function renderProjectsNav(){const sig=JSON.stringify(data.projects);if($('#project-nav').dataset.sig===sig)return;$('#project-nav').dataset.sig=sig;options($('#project'),data.projects,'通用任务（独立目录）');options($('#project-filter'),data.projects,'通用任务',true);$('#project-nav').replaceChildren();for(const p of data.projects){const e=button('',()=>{$('#project-filter').value=p.id;switchView('operate');load()},'project-nav');e.append(userNode('span',p.name),node('span',String(p.count)));$('#project-nav').append(e)}}
function appendRecord(section,r){const e=node('article',undefined,'record'),head=node('div',undefined,'record-head');head.append(node('span',tr(({human:'操作员输入',report:'结构化报告',assistant:'Assistant · 公开文本',tool:'原生工具',team:'团队消息',stopped:'停止记录'}[r.kind]||r.kind))),node('time',date(r.at)),node('span',tr(labels[r.state]||r.status||'')));e.append(head,userNode('pre',r.text));if(r.question){const q=node('div',undefined,'notice');q.append(document.createTextNode(tr('问题记录：')),userNode('span',r.question));e.append(q)}section.append(e)}
function renderDetail(value){
 detailValue=value
 const t=value.task,n=value.native;current=t
 $('#no-selection').hidden=true;$('#selected-work').hidden=false
 $('#send-followup').disabled=$('#stop-task').disabled=t.state==='stopped'||busy;$('#followup').disabled=t.state==='stopped'
 $('#input-status').textContent=t.state==='stopped'?tr('任务已永久停止'):(t.inputs?.length||0)+(language==='en'?' saved inputs · same Session':' 条已保存输入 · 同一 Session')
 const sig=JSON.stringify(value);if(sig===signature)return;if($('#detail').contains(document.activeElement))return;signature=sig
 const target=$('#detail'),workspace=$('.workspace'),scroll=workspace.scrollTop,openDetails=[...target.querySelectorAll('details')].map(e=>e.open)
 target.replaceChildren();target.append(userNode('h2',t.title||t.text.split('\n')[0],'detail-title'))
 const meta=node('div',undefined,'detail-meta'),created=node('span'),project=data?.projects.find(p=>p.id===t.projectId);created.append(document.createTextNode(tr('创建于')+' '),document.createTextNode(date(t.createdAt)));meta.append(status(t.displayState),project?userNode('span',project.name):node('span',tr('通用任务')),created);target.append(meta)
 const grid=node('div',undefined,'detail-grid'),main=node('div'),inspector=node('aside',undefined,'native-panel');grid.append(main,inspector);target.append(grid)
 if(t.displayState==='question'){const msg=node('div',undefined,'notice');msg.append(document.createTextNode(tr('等待你的回答：')),userNode('span',t.report.question));main.append(msg)}
 if(t.displayState==='review')main.append(node('div','结果已就绪，等待人工审核。可阅读报告和产物后补充下一步要求。','notice'))
 const timeline=countedSection('工作记录 / ',value.records.length);if(!value.records.length)timeline.append(node('div','暂无公开工作记录。','empty'));for(const r of value.records)appendRecord(timeline,r);main.append(timeline)
 const artifacts=countedSection('产物 / ',t.artifacts.length)
 if(!t.artifacts.length)artifacts.append(node('p','尚未登记文件。Lead 可用 workbench_artifact 登记真实产物。','empty'))
 for(const a of t.artifacts){const row=node('div',undefined,'artifact');const ext=a.path.split('.').pop();row.append(userNode('strong',a.label),node('small',ext.toUpperCase()+' · '+a.size+' B · SHA-256 已登记'));row.append(button('纯文本预览',()=>preview(t.id,a)),button('下载',()=>download(t.id,a),'quiet'));artifacts.append(row)}main.append(artifacts)
 inspector.append(node('h3','NATIVE / 原生运行态'))
 inspector.append(node('div',n.status==='stopped'?'已停止 · 保留停止前团队快照':n.status==='running'?'DSH 正在运行':'DSH 空闲 / 等待输入','muted'))
 if(n.model?.status==='missing-model')inspector.append(node('div','未配置可用的 DSH 模型；输入已保存。请在原生设置中配置。','notice'))
 else if(n.model?.selection)inspector.append(node('p','模型路由：'+n.model.selection.provider+' / '+n.model.selection.model+'；认证与推理未验证。','muted'))
 else inspector.append(node('p','模型路由未知；真实推理未验证。','muted'))
 const team=countedSection('Lead + teammates / ',n.members?.length||0)
 if(!n.members?.length)team.append(node('p','暂无原生成员视图。可到 DSH 查看原始 Session。','empty'))
 for(const member of n.members||[]){const row=node('div',undefined,'member');row.append(node('strong',member.name+' · '+member.role),node('small',member.status+' · '+(member.model||'未提供模型')+(member.provider?' / '+member.provider:'')));team.append(row)}
 if(n.members?.length===1)team.append(node('small','当前仅有 Lead，尚无队友。'));inspector.append(team)
 const board=countedSection('原生任务 DAG / ',n.tasks?.length||0);if(!n.tasks?.length)board.append(node('p','暂无原生 DAG 任务。','empty'))
 for(const item of n.tasks||[]){const row=node('div',undefined,'dag'),state=node('p'),deps=node('p'),scopeLabel=node('p');row.append(userNode('strong',item.subject));state.append(document.createTextNode(tr(item.status)+' · '),userNode('span',item.ownerName||tr('未认领')));deps.append(document.createTextNode(tr('依赖：')),userNode('span',item.blockedBy?.map(id=>(n.tasks||[]).find(t=>t.id===id)?.subject||id.slice(0,8)).join(', ')||tr('无')));scopeLabel.append(document.createTextNode(tr('写入范围：')),document.createTextNode(String(item.writeScopes?.length||0)+' '+tr('项提示（非安全边界）')));row.append(state,deps,scopeLabel);const scope=node('details');scope.append(node('summary',tr('查看范围与任务标识')),node('code',item.id),node('code',item.writeScopes?.join('\n')||tr('未指定')));row.append(scope);board.append(row)}inspector.append(board)
 const link=node('a','打开 DSH 原生界面 ↗','native-link');link.href='/';link.target='_blank';link.rel='noopener';inspector.append(link,node('small','原生认证独立；进入后选择对应 Session。'))
 inspector.append(button('复制 Session ID',async()=>{try{await navigator.clipboard.writeText(t.sessionId);notice('已复制 Session ID。')}catch{notice('复制不可用，请展开绑定信息手动复制。')}},'quiet'))
 const binding=node('details');binding.append(node('summary','Session 与目录绑定'));for(const [label,v]of [['Session',t.sessionId],['任务 ID',t.id],['工作目录',t.workspace],['输出目录',t.outputRoot],['原始项目根',t.projectRoot||'无（通用任务）']])binding.append(node('small',label),node('code',v));inspector.append(binding)
 target.querySelectorAll('details').forEach((e,i)=>e.open=openDetails[i]||false);workspace.scrollTop=scroll;applyLanguage(language)
}
async function preview(id,a){$('#preview-title').textContent=a.label+(language==='en'?' · text':' · 纯文本');$('#preview-text').dataset.userContent='';$('#preview-text').textContent='正在校验文件…';$('#preview').showModal();try{const v=await api('/tasks/'+id+'/artifacts/'+a.id+'?preview=1');$('#preview-text').dataset.userContent='true';$('#preview-text').textContent=v.text}catch(e){$('#preview-text').textContent=e.message}}
async function download(id,a){try{const r=await fetch('/workbench/api/tasks/'+id+'/artifacts/'+a.id,{headers:{Authorization:'Bearer '+token()}});if(!r.ok){let value={};try{value=await r.json()}catch{}throw Error(uiError(r.status,value.error))}const url=URL.createObjectURL(await r.blob()),link=node('a');link.href=url;link.download=a.label;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}catch(e){fail(e)}}
function renderOther(){
 if(!data)return;const sig=JSON.stringify({language,view,projects:data.projects,counts:data.counts});if(sig===otherSignature)return;otherSignature=sig
 const out=$('#other-view');out.replaceChildren()
 if(view==='projects'){out.append(node('h2','已登记的工作上下文'),node('p','任务创建时固定目录绑定。现有任务不会因项目配置变更而转向其他目录。'))
 for(const p of data.projects){const row=node('div',undefined,'project-row'),info=node('div'),heading=node('h3');heading.append(userNode('span',p.name),document.createTextNode(' · '+p.count+' '+tr('项任务')));info.append(heading,p.root?userNode('code',p.root):node('code',tr('每项通用任务拥有独立目录')));row.append(info,button(tr('查看任务'),()=>{$('#project-filter').value=p.id;switchView('operate');load()}));out.append(row)}
 const instructions=section('登记与维护项目');instructions.append(node('p','本版项目页只读。请在 config/projects.json 显式登记已有目录和唯一项目 ID，再重启此专用 Host。避免更改已有项目 ID 的含义；旧任务仍保留原始根目录。界面不会自动扫描磁盘。'));out.append(instructions)
 }else if(view==='settings'){
 out.append(node('h2','本地连接已认证'),node('p','Workbench '+data.connection.appVersion+' · DSH '+data.connection.dshVersion+' · Loopback Host'))
 for(const [title,text]of [['访问与认证','操作令牌仅保存在当前标签页 sessionStorage；不会放入 URL。退出后需重新输入。DSH 原生认证独立完成。'],['模型配置','任务检查器展示已知模型路由；已配置路由不代表凭据有效或真实推理通过。请在原生 DSH 中配置提供方、选择模型，再发送补充输入。'],['隐私与权限','仅显示绑定任务的公开文本、工具名称、结构化报告和人工输入，不显示推理、系统上下文或原始工具参数。原生工具权限由 Profile 管理；目录绑定与写入范围提示不是 OS 沙箱。'],['任务记录','输入、报告与产物登记持久保存在本地；草稿保存在此浏览器 localStorage。仅预览不超过 64 KiB 的受支持纯文本文件。IM 集成暂停。']]){const s=section(title);s.append(node('p',text));out.append(s)}const link=node('a','打开原生 DSH：配置提供方与模型 ↗');link.href='/';link.target='_blank';link.rel='noopener';out.append(link)
 }
applyLanguage(language)
}
function switchView(next){view=next;document.querySelectorAll('[data-view]').forEach(e=>e.classList.toggle('active',e.dataset.view===view));$('#view-label').textContent=names[view][0];$('#page-title').textContent=names[view][1];const work=['operate','monitor'].includes(view);$('#work-view').hidden=!work;$('#other-view').hidden=work;if(data){renderList();renderOther()}applyLanguage(language)}
async function load(){
 clearTimeout(timer);controller?.abort();const c=new AbortController();controller=c;const gen=++generation
 if(!token()){openAuth();return}
 try{
 const result=await api('/overview?'+filters(),{signal:c.signal});if(gen!==generation)return;data=result;renderProjectsNav();renderList();renderOther()
 if(selected&&['operate','monitor'].includes(view)){const value=await api('/tasks/'+encodeURIComponent(selected),{signal:c.signal});if(gen!==generation||selected!==value.task.id)return;renderDetail(value)}
 $('#sync').textContent='已同步 '+new Date().toLocaleTimeString(language,{hour:'2-digit',minute:'2-digit',second:'2-digit'});
 }catch(e){if(e.name!=='AbortError'){fail(e);$('#sync').textContent='读取失败 · 可重试'}}finally{if(gen===generation&&!document.hidden)timer=setTimeout(load,4000)}
}
function selectTask(id){$('#work-view').classList.add('selected');if(selected!==id){selected=id;current=null;$('#send-followup').disabled=$('#stop-task').disabled=true;signature='';$('#followup').value=storage.get('draft:'+id);$('#detail').replaceChildren(node('p','正在读取任务…','empty'));$('.workspace').scrollTop=0}location.hash=encodeURIComponent(id);load()}
function saveComposer(){storage.set('composer',JSON.stringify({title:$('#title').value,text:$('#prompt').value,project:$('#project').value}))}
function openComposer(){try{const saved=JSON.parse(storage.get('composer')||'{}');$('#title').value=saved.title||'';$('#prompt').value=saved.text||'';$('#project').value=saved.project||''}catch{}$('#composer').showModal();$('#title').focus()}
async function mutate(fn){if(busy)return;busy=true;document.body.setAttribute('aria-busy','true');$('#sync').textContent='正在提交…';$('#create').textContent='正在提交…';$('#create').disabled=$('#send-followup').disabled=$('#stop-task').disabled=$('#confirm-stop').disabled=true;controller?.abort();++generation;clearTimeout(timer);try{await fn();notice('')}catch(e){fail(e)}finally{busy=false;document.body.removeAttribute('aria-busy');$('#create').textContent='创建并提交';$('#create').disabled=$('#confirm-stop').disabled=false;$('#send-followup').disabled=$('#stop-task').disabled=current?.state==='stopped';await load()}}
$('#auth-form').onsubmit=async e=>{e.preventDefault();const b=$('#save');b.disabled=true;sessionStorage.setItem('wb-token',$('#token').value);try{await api('/overview');$('#token').value='';$('#auth-error').textContent='';$('#auth').close();notice('');await load()}catch(e){$('#auth-error').textContent=e.message}finally{b.disabled=false}}
$('#auth').addEventListener('cancel',e=>e.preventDefault())
$('#logout').onclick=()=>{controller?.abort();++generation;clearTimeout(timer);sessionStorage.removeItem('wb-token');data=current=null;$('#followup').value='';$('#work-view').classList.remove('selected');$('#tasks').replaceChildren();$('#detail').replaceChildren();$('#other-view').replaceChildren();$('#project-nav').replaceChildren();$('#selected-work').hidden=true;$('#no-selection').hidden=false;signature=listSignature=otherSignature='';openAuth()}
$('#refresh').onclick=()=>{notice('');load()}
$('#search').oninput=()=>{clearTimeout(timer);controller?.abort();++generation;timer=setTimeout(load,200)}
$('#project-filter').onchange=$('#state-filter').onchange=load
$('#new-task').onclick=$('#empty-create').onclick=openComposer
$('#close-composer').onclick=()=>$('#composer').close()
for(const id of ['title','prompt','project'])$('#'+id).addEventListener('input',saveComposer)
$('#followup').oninput=()=>{if(selected)storage.set('draft:'+selected,$('#followup').value)}
$('#create-form').onsubmit=e=>{e.preventDefault();mutate(async()=>{const value=await api('/tasks',{method:'POST',body:JSON.stringify({title:$('#title').value,text:$('#prompt').value,projectId:$('#project').value||null})});storage.set('composer','');$('#composer').close();selectTask(value.task.id)})}
$('#send-followup').onclick=()=>{const id=selected,text=$('#followup').value;if(!text.trim()){notice('请先填写补充说明。');return}mutate(async()=>{await api('/tasks/'+id+'/followups',{method:'POST',body:JSON.stringify({text})});storage.set('draft:'+id,'');if(selected===id)$('#followup').value=''})}
$('#stop-task').onclick=()=>{stoppingId=selected;$('#stop-confirm h2').textContent=(language==='en'?'Permanently stop “':'确认永久停止「')+(current?.title||current?.text||(language==='en'?'this task':'此任务')).slice(0,60)+(language==='en'?'”?':'」？');$('#stop-confirm').showModal()}
$('#cancel-stop').onclick=()=>$('#stop-confirm').close()
$('#stop-form').onsubmit=e=>{e.preventDefault();const id=stoppingId;mutate(async()=>{await api('/tasks/'+id+'/stop',{method:'POST',body:'{}'});$('#stop-confirm').close()})}
$('#close-preview').onclick=()=>$('#preview').close()
$('#back-list').onclick=()=>$('#work-view').classList.remove('selected')
for(const e of document.querySelectorAll('[data-view]'))e.onclick=()=>{switchView(e.dataset.view);load()}
window.addEventListener('hashchange',()=>{const id=readHash();if(id!==selected){selected=id;current=null;$('#send-followup').disabled=$('#stop-task').disabled=true;signature='';if(id)$('#work-view').classList.add('selected');$('#followup').value=storage.get('draft:'+id);if(!id){$('#selected-work').hidden=true;$('#no-selection').hidden=false;$('#work-view').classList.remove('selected')}load()}})
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(timer);controller?.abort()}else load()})
$('#followup').value=storage.get('draft:'+selected);if(selected)$('#work-view').classList.add('selected');load()
