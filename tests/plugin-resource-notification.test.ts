import {test,expect} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
test('publishing a new resource CLI delegates to the joint coordinator without sending an incomplete plugin event',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'moe-plugin-joint-'));
 try{
 const sha='a'.repeat(40),integrity='sha512-fixture';
 fs.writeFileSync(path.join(dir,'receipt.json'),JSON.stringify({schemaVersion:1,repository:'moewolf-dev/moe-icons-cli',runId:'8',provenance:true,conclusion:'success',version:'0.0.12',releaseCommit:sha,npmIntegrity:integrity}));
 const routes={
  'repos/moewolf-dev/moe-icons-cli/actions/runs/8':{path:'.github/workflows/publish.yml@refs/heads/main',head_branch:'main',conclusion:'success',head_sha:sha},
  [`repos/moewolf-dev/moe-icons-cli/contents/src/catalog/resource-release.json?ref=${sha}`]:{content:Buffer.from(JSON.stringify({resourceVersion:'0.0.20',privateDescriptorSha256:'b'.repeat(64),sourceCommit:'c'.repeat(40)})).toString('base64')},
  'repos/moewolf-dev/moe-icons-plugins/contents/data/release-state.json?ref=main':{content:Buffer.from(JSON.stringify({schemaVersion:1,events:[]})).toString('base64')}
 };
 fs.writeFileSync(path.join(dir,'routes.json'),JSON.stringify(routes));
 fs.writeFileSync(path.join(dir,'gh'),`#!${process.execPath}\nconst fs=require('node:fs');const route=process.argv[3];const data=JSON.parse(fs.readFileSync(process.env.FIXTURE+'/routes.json'));if(!data[route]){fs.writeFileSync(process.env.FIXTURE+'/unexpected','unexpected external action');process.exit(90)}process.stdout.write(JSON.stringify(data[route]));`,{mode:0o700});
 fs.writeFileSync(path.join(dir,'fetch.mjs'),`globalThis.fetch=async url=>{if(url!=='https://registry.npmjs.org/@moewolf%2fmoe-icons-cli/0.0.12')throw Error('unexpected registry');return {json:async()=>({dist:{integrity:'${integrity}'}})}};`);
 const result=spawnSync(process.execPath,['--import',path.join(dir,'fetch.mjs'),'scripts/dispatch-plugin-release.mjs',path.join(dir,'receipt.json')],{encoding:'utf8',env:{...process.env,CLI_PUBLISH_RUN_ID:'8',FIXTURE:dir,PATH:dir+path.delimiter+process.env.PATH}});
 expect(result.status,result.stderr).toBe(0);expect(JSON.parse(result.stdout).status).toBe('resource-coordinator-owned');expect(fs.existsSync(path.join(dir,'unexpected'))).toBe(false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
