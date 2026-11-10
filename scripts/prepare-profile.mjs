import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, symlink, lstat, realpath } from 'node:fs/promises'
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root=await realpath(resolve(dirname(fileURLToPath(import.meta.url)),'..'))
const dshHome=resolve(process.env.DSH_HOME||join(root,'.dsh-home'))
const rel=relative(root,dshHome)
if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw Error('DSH_HOME must be a dedicated directory inside this project')
const profile=join(dshHome,'profiles','workbench')
const manifestPath=join(profile,'package.json')
const ownerPath=join(profile,'.workbench-owner.json')
const link=join(profile,'node_modules','dsh-workbench')
const ownership={createdBy:'dsh-workbench',version:1,projectRoot:root,profile:'workbench'}

async function exists(path) {
  try{await lstat(path);return true}catch(error){if(error.code==='ENOENT')return false;throw error}
}
async function rejectSymlinkAncestors(path) {
  let current=root
  for(const part of relative(root,path).split(sep)) {
    current=join(current,part)
    if(await exists(current) && (await lstat(current)).isSymbolicLink())throw Error('Dedicated profile paths must not traverse symlinks')
  }
}
async function readObject(path,label) {
  if((await lstat(path)).isSymbolicLink())throw Error(label+' must not be a symlink')
  try{const value=JSON.parse(await readFile(path,'utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value}
  catch{throw Error(label+' is invalid; existing configuration was not modified')}
}
async function verifyLink() {
  if(!await exists(link)||!(await lstat(link)).isSymbolicLink()||await realpath(link)!==root)throw Error('Existing profile has an unrelated Workbench dependency; configuration was not modified')
}

await rejectSymlinkAncestors(profile)
if(!await exists(profile)) {
  // Only a newly created dedicated profile receives our initial manifest.
  execFileSync(process.execPath,[join(root,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','workbench','--from-default-profile','web','--dump-config'],{cwd:root,env:{...process.env,DSH_HOME:dshHome,DSH_AGENTS_HOME:join(dshHome,'agents')},stdio:'ignore'})
  const manifest={name:'dsh-profile-workbench',private:true,dependencies:{'dsh-workbench':`file:${root}`},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@deepseek-ai/dsh-experimental-agent-team-profile','dsh-workbench']}}}
  await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n')
  await mkdir(dirname(link),{recursive:true})
  await symlink(root,link,'dir')
  await writeFile(ownerPath,JSON.stringify(ownership,null,2)+'\n',{flag:'wx',mode:0o600})
} else {
  await rejectSymlinkAncestors(dirname(link))
  if(await exists(ownerPath)) {
    const owner=await readObject(ownerPath,'Profile ownership marker')
    if(Object.keys(ownership).some(key=>owner[key]!==ownership[key]))throw Error('Existing profile belongs to another project; configuration was not modified')
    await verifyLink()
  } else {
    // Adopt only the verifiable profile shape written by the previous launcher.
    // Its manifest and override may contain operator settings: never rewrite them.
    if(!await exists(manifestPath))throw Error('Refusing to replace an unrelated existing profile')
    const manifest=await readObject(manifestPath,'Existing profile manifest')
    if(manifest.name!=='dsh-profile-workbench'||manifest.dependencies?.['dsh-workbench']!==`file:${root}`||!manifest.dsh?.profile?.bundles?.includes('dsh-workbench'))throw Error('Refusing to replace an unrelated existing profile')
    await verifyLink()
    await writeFile(ownerPath,JSON.stringify(ownership,null,2)+'\n',{flag:'wx',mode:0o600})
  }
}
// In particular, do not parse, evaluate or write cordis.patch.yml on restart.
console.log('Prepared native DSH profile: '+profile)
