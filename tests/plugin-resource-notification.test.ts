import {test,expect} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
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

test('package-set plugin notification preserves the exact Marketplace receipt for the Generator ledger',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'moe-plugin-package-set-'));
 try{
 const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
 const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
 const canonicalBytes=(value:any)=>Buffer.from(`${JSON.stringify(canonical(value))}\n`);
 const sourceCommit='a'.repeat(40),generatorCommit='b'.repeat(40),resourceVersion='0.0.20',cliVersion='0.0.12';
 const packageSets={schemaVersion:1,resourceVersion,sourceCommit,generatorCommit,
  free:{packageSetSha256:'c'.repeat(64),candidateRootSha256:'d'.repeat(64),candidateRootBytes:512},
  pro:{packageSetSha256:'e'.repeat(64),candidateRootSha256:'f'.repeat(64),candidateRootBytes:512}};
 const resource={schemaVersion:2,resourceVersion,sourceCommit,generatorCommit,sourceDispatchId:'1'.repeat(64),
  producer:{repository:'moewolf-dev/moe-icons-code-library',workflowPath:'.github/workflows/small-pack-candidate.yml',runId:'321',runAttempt:2,headSha:generatorCommit},
  packageSets,packageSetResourceDigest:hash(`moe-icons-package-set-resource-v1\n${resourceVersion}\n${sourceCommit}\n${generatorCommit}\n${packageSets.free.packageSetSha256}\n${packageSets.pro.packageSetSha256}\n`),
  packageSetDescriptorSha256:hash(canonicalBytes(packageSets)),catalogSha256:'2'.repeat(64),appliedAt:'2026-10-18T00:00:00.000Z'};
 const publishReceipt={schemaVersion:1,repository:'moewolf-dev/moe-icons-cli',runId:'8',provenance:true,conclusion:'success',version:cliVersion,releaseCommit:'3'.repeat(40),npmIntegrity:'sha512-fixture'};
 const eventId=`resource:${resourceVersion}:cli:${cliVersion}`;
 const marketReceipt={schemaVersion:1,eventId,resourceVersion,cliVersion,descriptorSha256:resource.packageSetDescriptorSha256,
  packageSetDigests:{free:packageSets.free.packageSetSha256,pro:packageSets.pro.packageSetSha256},tag:`v${cliVersion}`,runId:'9',
  vsixSha256:'4'.repeat(64),marketplaceVerified:true};
 const marketBytes=Buffer.from(`${JSON.stringify(marketReceipt,null,2)}\n`);
 const pluginRun={id:10,run_attempt:1,head_sha:'5'.repeat(40),event:'repository_dispatch',display_title:`Plugin resource ${eventId}`,
  status:'completed',conclusion:'success',created_at:new Date().toISOString(),html_url:'https://github.com/moewolf-dev/moe-icons-plugins/actions/runs/10'};
 fs.writeFileSync(path.join(dir,'receipt.json'),JSON.stringify(publishReceipt));
 fs.writeFileSync(path.join(dir,'routes.json'),JSON.stringify({
  'repos/moewolf-dev/moe-icons-cli/actions/runs/8':{path:'.github/workflows/publish.yml@refs/heads/main',head_branch:'main',conclusion:'success',head_sha:'6'.repeat(40),id:8},
  [`repos/moewolf-dev/moe-icons-cli/contents/src/catalog/resource-release.json?ref=${publishReceipt.releaseCommit}`]:{content:Buffer.from(JSON.stringify(resource)).toString('base64')}
 }));
 fs.writeFileSync(path.join(dir,'gh'),`#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');const a=process.argv.slice(2);const route=a.find(x=>x.startsWith('repos/'));const root=process.env.FIXTURE;const routes=JSON.parse(fs.readFileSync(path.join(root,'routes.json')));
if(a[0]==='run'&&a[1]==='download'){const out=a[a.indexOf('--dir')+1];fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'plugin-publication-receipt.json'),fs.readFileSync(path.join(root,'market-receipt.json')));process.exit(0)}
if(a.includes('--method')&&a[a.indexOf('--method')+1]==='POST'&&route==='repos/moewolf-dev/moe-icons-plugins/dispatches'){fs.writeFileSync(path.join(root,'dispatch.json'),fs.readFileSync(0));process.exit(0)}
if(route==='repos/moewolf-dev/moe-icons-plugins/actions/workflows/resource-update.yml/runs?per_page=50'){process.stdout.write(JSON.stringify({workflow_runs:[${JSON.stringify(pluginRun)}]}));process.exit(0)}
if(!routes[route]){fs.writeFileSync(path.join(root,'unexpected'),String(route));process.exit(90)}process.stdout.write(JSON.stringify(routes[route]));`,{mode:0o700});
 fs.writeFileSync(path.join(dir,'market-receipt.json'),marketBytes);
 fs.writeFileSync(path.join(dir,'fetch.mjs'),`globalThis.fetch=async url=>{if(url!=='https://registry.npmjs.org/@moewolf%2fmoe-icons-cli/${cliVersion}')throw Error('unexpected registry');return {json:async()=>({dist:{integrity:'${publishReceipt.npmIntegrity}'}})}};`);
 const proofPath=path.join(dir,'verification.json'),outputPath=path.join(dir,'github-output');
 const result=spawnSync(process.execPath,['--import',path.join(dir,'fetch.mjs'),'scripts/dispatch-plugin-release.mjs',path.join(dir,'receipt.json')],{encoding:'utf8',timeout:60000,
  env:{...process.env,CLI_PUBLISH_RUN_ID:'8',FIXTURE:dir,PATH:dir+path.delimiter+process.env.PATH,GH_TOKEN:'fake-read-token',PLUGIN_DISPATCH_TOKEN:'fake-plugin-token',
   CLI_PLUGIN_VERIFICATION_RECEIPT:proofPath,GITHUB_OUTPUT:outputPath}});
 expect(result.status,result.error?.message || result.stderr).toBe(0);
 const completed= result.stdout.trim().split('\n').map(line=>{try{return JSON.parse(line)}catch{return null}}).find(item=>item?.status==='verified');
 expect(completed?.status).toBe('verified');
 const dispatch=JSON.parse(fs.readFileSync(path.join(dir,'dispatch.json'),'utf8'));
 expect(dispatch.event_type).toBe('moe-icons-cli-release');
 expect(dispatch.client_payload.delivery.packageSets).toEqual(packageSets);
 expect(fs.readFileSync(outputPath,'utf8')).toBe('package_set_receipt=true\n');
 const proof=JSON.parse(fs.readFileSync(proofPath,'utf8'));
 expect(proof.state).toBe('cli-plugin-package-set-marketplace-verified');
 expect(proof.plugin.receiptBytesBase64).toBe(marketBytes.toString('base64'));
 expect(proof.plugin.receiptSha256).toBe(hash(marketBytes));
 expect(proof.plugin.receipt).toEqual(marketReceipt);
 expect(proof.plugin.runId).toBe('10');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
