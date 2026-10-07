import {describe,it,expect} from 'vitest';
// @ts-expect-error Operational guard is an ESM script.
import {verifyRecoveryIdentity} from '../scripts/recover-candidate.mjs';
const valid=()=>({run:{id:1,repository:{full_name:'owner/cli'},head_branch:'main',path:'.github/workflows/publish.yml',status:'completed',conclusion:'failure'},jobs:{total_count:4,jobs:[...['validate','pack','acceptance'].map((name,id)=>({id,name,status:'completed',conclusion:'success'})),{id:4,name:'publish',conclusion:'failure'}]},pkg:{name:'@moewolf/moe-icons-cli',version:'0.0.2',payloadHash:'a'.repeat(64)},manifest:{schemaVersion:1,version:'0.0.2',sha256:'b'.repeat(64)},sha:'b'.repeat(64),repository:'owner/cli',runId:1});
describe('immutable publish recovery',()=>{
 it('accepts only a previously accepted frozen candidate',()=>expect(verifyRecoveryIdentity(valid()).version).toBe('0.0.2'));
 it.each(['repository','head_branch','path','status','conclusion'])('rejects wrong run %s',key=>{const x=valid();(x.run as Record<string,unknown>)[key]='wrong';expect(()=>verifyRecoveryIdentity(x)).toThrow();});
 it('rejects absent acceptance and a newer publication state',()=>{const x=valid();x.jobs.jobs[2]!.conclusion='failure';expect(()=>verifyRecoveryIdentity(x)).toThrow();});
 it('recovers an automatic push whose pack includes validation and rejects a missing pack',()=>{const x=valid();Object.assign(x.run,{event:'push'});x.jobs.jobs=x.jobs.jobs.filter(j=>j.name!=='validate');expect(verifyRecoveryIdentity(x).version).toBe('0.0.2');x.jobs.jobs=x.jobs.jobs.filter(j=>j.name!=='pack');expect(()=>verifyRecoveryIdentity(x)).toThrow();});
 it('still requires the explicit validation job for manual runs',()=>{const x=valid();Object.assign(x.run,{event:'workflow_dispatch'});x.jobs.jobs=x.jobs.jobs.filter(j=>j.name!=='validate');expect(()=>verifyRecoveryIdentity(x)).toThrow();});
 it('rejects changed candidate bytes and version',()=>{const x=valid();x.sha='c'.repeat(64);expect(()=>verifyRecoveryIdentity(x)).toThrow();x.sha='b'.repeat(64);x.pkg.version='0.0.3';expect(()=>verifyRecoveryIdentity(x)).toThrow();});
});

import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
it('finds the original release commit and rejects extra changed files',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'cli-release-recovery-')));
 const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
 try {
  mkdirSync(join(root,'scripts'));copyFileSync(join(__dirname,'../scripts/release-commit.mjs'),join(root,'scripts/release-commit.mjs'));
  git('init','-q');git('config','user.name','test');git('config','user.email','test@example.invalid');
  for(const file of ['package.json','package-lock.json'])writeFileSync(join(root,file),'{}');git('add','.');git('commit','-qm','source');const source=git('rev-parse','HEAD');
  for(const file of ['package.json','package-lock.json'])writeFileSync(join(root,file),JSON.stringify({version:'0.0.2',payloadHash:'a'.repeat(64)}));git('add','.');git('commit','-qm',`chore(release): cli v0.0.2 [source ${source.slice(0,7)}]`);git('update-ref','refs/remotes/origin/main','HEAD');
  const find=()=>JSON.parse(execFileSync(process.execPath,[join(root,'scripts/release-commit.mjs'),'find','--payload-hash','a'.repeat(64),'--source-commit',source],{encoding:'utf8'}));
  expect(find()?.sha).toBe(git('rev-parse','HEAD'));
  writeFileSync(join(root,'extra.txt'),'not a version-only release');git('add','.');git('commit','--amend','--no-edit','-q');git('update-ref','refs/remotes/origin/main','HEAD');expect(find()).toBeNull();
 } finally {rmSync(root,{recursive:true,force:true});}
});
