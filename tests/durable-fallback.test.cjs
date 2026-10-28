'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {spawnSync}=require('node:child_process');const crypto=require('node:crypto');
const {artifactRecord}=require('../scripts/durable-release-artifact.cjs');
const repo='moewolf-dev/moe-icons-code-library',sha='a'.repeat(40),bytes=Buffer.from('exact original zip bytes'),digest='sha256:'+crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(){const artifact={id:7,name:'moe-icons-production-1.2.3',digest,size_in_bytes:bytes.length,expired:true,expires_at:'2020-01-01T00:00:00Z',workflow_run:{id:8,head_sha:sha}};return{expected:{id:7,version:'1.2.3',runId:8,attempt:1,headSha:sha,digest},record:{schemaVersion:1,repository:repo,resourceVersion:'1.2.3',runId:'8',runAttempt:1,headSha:sha,artifacts:[artifact]},run:{id:8,path:'.github/workflows/production-pack.yml@refs/heads/main',head_branch:'main',head_sha:sha,run_attempt:1,repository:{full_name:repo}},jobs:[{name:'pack',conclusion:'success'}]};}
test('durable metadata preserves exact original identity and labels storage availability',()=>{const f=fixture(),m=artifactRecord(f.record,f.expected,f.run,f.jobs);assert.equal(m.id,7);assert.equal(m.digest,digest);assert.equal(m.storage,'private-release');assert.equal(m.originalActionsExpiresAt,'2020-01-01T00:00:00Z');assert.equal(m.expired,false);});
for(const [name,change] of Object.entries({version:f=>f.record.resourceVersion='1.2.4',head:f=>f.run.head_sha='b'.repeat(40),attempt:f=>f.run.run_attempt=2,repository:f=>f.run.repository.full_name='attacker/repo',workflow:f=>f.run.path='.github/workflows/other.yml',pack:f=>f.jobs[0].conclusion='failure',digest:f=>f.record.artifacts[0].digest='sha256:'+'b'.repeat(64),id:f=>f.record.artifacts[0].id=9}))test('durable provenance rejects changed '+name,()=>{const f=fixture();change(f);assert.throws(()=>artifactRecord(f.record,f.expected,f.run,f.jobs));});
test('expired Actions artifact restores the original ZIP from private release; tampering leaves no file',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'durable-artifact-'));try{
 const f=fixture();const routes={};routes[`repos/${repo}/actions/artifacts/7`]=f.record.artifacts[0];routes[`repos/${repo}/actions/runs/8`]=f.run;routes[`repos/${repo}/actions/runs/8/attempts/1`]=f.run;routes[`repos/${repo}/actions/runs/8/attempts/1/jobs?per_page=100&page=1`]={total_count:101,jobs:Array.from({length:100},(_,index)=>({name:`build-unit-${index}`,conclusion:'success'}))};routes[`repos/${repo}/actions/runs/8/attempts/1/jobs?per_page=100&page=2`]={total_count:101,jobs:f.jobs};routes[`repos/${repo}/releases/tags/candidate-v1.2.3-r8-a1`]={draft:false,assets:[{id:10,name:'artifact-record.v1.json',size:999},{id:11,name:'artifact-7.zip',size:bytes.length}]};routes[`repos/${repo}/releases/assets/10`]=f.record;
 fs.writeFileSync(path.join(dir,'routes.json'),JSON.stringify(routes));fs.writeFileSync(path.join(dir,'bytes'),bytes);
 fs.writeFileSync(path.join(dir,'gh'),`#!${process.execPath}\nconst fs=require('node:fs');const route=process.argv[3];fs.appendFileSync(process.env.FIXTURE+'/requests',route+'\\n');if(route.endsWith('/artifacts/7/zip') && fs.existsSync(process.env.FIXTURE+'/actions-failure')){process.stderr.write(fs.readFileSync(process.env.FIXTURE+'/actions-failure'));process.exit(1)}const accept=process.argv[process.argv.indexOf('-H')+1];if((route.endsWith('/zip') && accept!=='Accept: application/json') || (route.includes('/releases/assets/') && accept!=='Accept: application/octet-stream')){process.stderr.write('HTTP 415');process.exit(1)}if(route.endsWith('/assets/11') || route.endsWith('/artifacts/7/zip')){if(fs.existsSync(process.env.FIXTURE+'/fail-once')){fs.unlinkSync(process.env.FIXTURE+'/fail-once');process.stderr.write('HTTP 503');process.exit(1)}process.stdout.write(fs.readFileSync(process.env.FIXTURE+'/bytes'));}else{const value=JSON.parse(fs.readFileSync(process.env.FIXTURE+'/routes.json'))[route];if(!value){process.stderr.write('HTTP 404');process.exit(1)}process.stdout.write(JSON.stringify(value));}\n`,{mode:0o700});
 const destination=path.join(dir,'restored.zip'),script=path.resolve('scripts/durable-release-artifact.cjs'),transport=path.join(dir,'transport.json');const args=[script,'retrieve','--id','7','--version','1.2.3','--run','8','--attempt','1','--head',sha,'--digest',digest,'--zip',destination,'--metadata',path.join(dir,'metadata.json'),'--transport-report',transport];const env={...process.env,FIXTURE:dir,MOEICONS_TEST_FIXTURE_LEGACY_ARCHIVE:'1',PATH:dir+path.delimiter+process.env.PATH};
 fs.writeFileSync(path.join(dir,'fail-once'),'transient HTTP failure');
 let result=spawnSync(process.execPath,args,{env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.deepEqual(fs.readFileSync(destination),bytes);
 assert.match(result.stdout,/\[small-pack-consumer-transport\]/);
 let transportReport=JSON.parse(fs.readFileSync(transport,'utf8'));
 assert.equal(transportReport.kind,'small-pack-consumer-transport');assert.equal(transportReport.scope,'cli-durable-retrieve');
 assert.equal(transportReport.totals.attempts,2,'one transient ZIP failure is one measured attempt');assert.equal(transportReport.totals.retries,1);
 assert.equal(transportReport.totals.responseBytes,bytes.length);assert.equal(transportReport.totals.deliveredBytesOnFailure,0);
 assert.equal(transportReport.complete,false);assert.ok(transportReport.bypassRisk.includes('unknown-response-bytes'));
 fs.rmSync(destination);fs.writeFileSync(path.join(dir,'bytes'),Buffer.alloc(bytes.length));result=spawnSync(process.execPath,args,{env,encoding:'utf8'});assert.notEqual(result.status,0);assert.equal(fs.existsSync(destination),false);
 transportReport=JSON.parse(fs.readFileSync(transport,'utf8'));
 assert.equal(transportReport.totals.failedCalls,1);assert.equal(transportReport.totals.responseBytes,0);
 assert.ok(transportReport.totals.deliveredBytesOnFailure>0);assert.equal(transportReport.complete,false);
 routes[`repos/${repo}/actions/artifacts/7`]={...f.record.artifacts[0],expired:false,expires_at:'2099-01-01T00:00:00Z'};routes[`repos/${repo}/actions/runs/8`]={...f.run,run_attempt:2};fs.writeFileSync(path.join(dir,'routes.json'),JSON.stringify(routes));fs.writeFileSync(path.join(dir,'bytes'),bytes);
 const implicitAttempt=args.filter((value,index)=>value!=='--attempt' && args[index-1]!=='--attempt');result=spawnSync(process.execPath,implicitAttempt,{env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.deepEqual(fs.readFileSync(destination),bytes,'active original bytes use frozen pack attempt rather than a later rerun');
 transportReport=JSON.parse(fs.readFileSync(transport,'utf8'));
 assert.equal(transportReport.complete,true);assert.equal(transportReport.totals.retries,0);assert.equal(transportReport.totals.responseBytes,bytes.length);
 fs.rmSync(destination);fs.writeFileSync(path.join(dir,'actions-failure'),'HTTP 503');fs.writeFileSync(path.join(dir,'requests'),'');
 result=spawnSync(process.execPath,args,{env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.deepEqual(fs.readFileSync(destination),bytes);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'metadata.json'))).storage,'private-release');
 const requests=fs.readFileSync(path.join(dir,'requests'),'utf8').split('\n');assert.equal(requests.filter(route=>route.endsWith('/artifacts/7/zip')).length,3,'Actions retries are bounded before exact private fallback');assert.ok(requests.some(route=>route.endsWith('/assets/11')));
 fs.rmSync(destination);fs.writeFileSync(path.join(dir,'actions-failure'),'HTTP 403');fs.writeFileSync(path.join(dir,'requests'),'');
 result=spawnSync(process.execPath,args,{env,encoding:'utf8'});assert.notEqual(result.status,0);assert.equal(fs.existsSync(destination),false);assert.ok(!fs.readFileSync(path.join(dir,'requests'),'utf8').includes('/assets/11'),'authorization failures do not fall back');
 result=spawnSync(process.execPath,[...args,'--prefer-private'],{env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.deepEqual(fs.readFileSync(destination),bytes);fs.rmSync(destination);
 fs.writeFileSync(path.join(dir,'actions-failure'),'HTTP 503');fs.writeFileSync(path.join(dir,'bytes'),Buffer.alloc(bytes.length));
 result=spawnSync(process.execPath,args,{env,encoding:'utf8'});assert.notEqual(result.status,0);assert.equal(fs.existsSync(destination),false);assert.match(result.stderr,/exact private backup recovery failed/);

 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('production full-library ZIP retrieval is disabled without the isolated temp fixture switch',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'durable-archive-policy-'));
 try{
  const f=fixture(),destination=path.join(dir,'candidate.zip'),script=path.resolve('scripts/durable-release-artifact.cjs');
  const result=spawnSync(process.execPath,[script,'retrieve','--id','7','--version','1.2.3','--run','8','--attempt','1','--head',sha,'--digest',digest,'--zip',destination],{env:{...process.env,MOEICONS_TEST_FIXTURE_LEGACY_ARCHIVE:'',PATH:process.env.PATH},encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/legacy full-library ZIP retrieval is retired/);
  assert.equal(fs.existsSync(destination),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
