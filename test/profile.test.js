import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execute=promisify(execFile)
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

const root=process.cwd(),script=join(root,'scripts/prepare-profile.mjs')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
async function fixture(t) {
  await mkdir(join(root,'.acceptance'),{recursive:true})
  const dir=await mkdtemp(join(root,'.acceptance','profile-preserve-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const home=join(dir,'home'),profile=join(home,'profiles','workbench')
  const env={PATH:process.env.PATH,DSH_HOME:home,DSH_AGENTS_HOME:join(home,'agents'),TMPDIR:dir}
  const prepare=()=>execute(process.execPath,[script],{cwd:root,env,stdio:'pipe'})
  return {home,profile,env,prepare}
}

test('repeated profile preparation preserves every operator manifest and override byte',async t=>{
  const f=await fixture(t);await f.prepare()
  const manifestPath=join(f.profile,'package.json'),overridePath=join(f.profile,'cordis.patch.yml')
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'))
  manifest.operatorExtension={enabled:true,note:'synthetic operator setting'}
  manifest.dependencies['operator-synthetic-plugin']='file:./operator-plugin'
  manifest.dsh.profile.bundles.push('operator-synthetic-bundle')
  const editedManifest=Buffer.from(JSON.stringify(manifest,null,4).replaceAll('\n','\r\n')+'\r\n')
  const override=Buffer.from('\ufeff# Synthetic private sentinel: preserve bytes, never print them.\r\n- id: operator-config\r\n  config:\r\n    credential: synthetic-not-a-real-secret\r\n')
  await writeFile(manifestPath,editedManifest);await writeFile(overridePath,override)
  for(let i=0;i<3;i++)await f.prepare()
  assert.equal(hash(await readFile(manifestPath)),hash(editedManifest),'operator manifest bytes changed')
  assert.equal(hash(await readFile(overridePath)),hash(override),'operator override bytes changed')
})

test('an unrelated existing profile is refused without modifying its configuration',async t=>{
  const f=await fixture(t);await mkdir(f.profile,{recursive:true})
  const manifestPath=join(f.profile,'package.json'),overridePath=join(f.profile,'cordis.patch.yml')
  const manifest=Buffer.from('{"name":"unrelated-operator-profile","private":true}\n'),override=Buffer.from('# synthetic operator override\n[]\n')
  await writeFile(manifestPath,manifest);await writeFile(overridePath,override)
  await assert.rejects(execute(process.execPath,[script],{cwd:root,env:f.env,encoding:'utf8'}),'unrelated profile must be refused')
  assert.equal(hash(await readFile(manifestPath)),hash(manifest))
  assert.equal(hash(await readFile(overridePath)),hash(override))
})

test('legacy Workbench profile can be adopted without rewriting operator settings',async t=>{
  const f=await fixture(t);await f.prepare()
  await rm(join(f.profile,'.workbench-owner.json'),{force:true})
  const path=join(f.profile,'cordis.patch.yml'),sentinel=Buffer.from('# legacy operator configuration\r\n[]\r\n')
  await writeFile(path,sentinel)
  const manifest=await readFile(join(f.profile,'package.json'))
  await f.prepare()
  assert.equal(hash(await readFile(path)),hash(sentinel))
  assert.equal(hash(await readFile(join(f.profile,'package.json'))),hash(manifest))
})
