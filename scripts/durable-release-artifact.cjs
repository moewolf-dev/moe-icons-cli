'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const {pipeline}=require('node:stream/promises');
const {Transform}=require('node:stream');
const {workflowRunPathMatches}=require('./workflow-run-path.cjs');
const REPO='moewolf-dev/moe-icons-code-library';
const CLI_REPO='moewolf-dev/moe-icons-cli';
const MAX_ZIP_BYTES=2*1024**3;
function transient(error){return /HTTP\s*(?:429|5\d\d)\b|ETIMEDOUT|ECONNRESET|(?:connection|operation|request) (?:timed out|timeout)/i.test(String(error.stderr || error.message));}
function retryRead(read){for(let attempt=0;;attempt++){try{return read();}catch(error){if(attempt>=3 || !transient(error))throw error;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,[1000,3000,7000][attempt]);}}}
const json=route=>retryRead(()=>JSON.parse(execFileSync('gh',['api',route],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024})));
function upload(tag,file){
 for(let attempt=0;;attempt++){
  try{execFileSync('gh',['release','upload',tag,file,'--repo',REPO],{stdio:'pipe',timeout:10*60*1000});return;}
  catch(error){
   // A response may be lost after GitHub accepted the immutable bytes. The
   // caller always reads back and verifies an existing asset before use.
   if(json(`repos/${REPO}/releases/tags/${tag}`).assets.some(a=>a.name===path.basename(file)))return;
   if(attempt>=2 || !transient(error))throw error;
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,[1000,3000][attempt]);
  }
 }
}
function unavailable(error){return /(?:HTTP\s*)?(?:404|410)\b/.test(String(error.stderr || error.message));}
function artifactRecord(record,expected,run,jobs){
 assert.equal(record.schemaVersion,1,'durable record schema');assert.equal(record.repository,REPO,'durable repository');
 assert.equal(record.resourceVersion,expected.version,'durable version');
 assert.equal(String(record.runId),String(expected.libraryRunId || expected.runId),'durable producer');assert.equal(record.headSha,expected.libraryHeadSha || expected.headSha,'durable head');
 if(expected.libraryAttempt || (expected.repository!==CLI_REPO && expected.attempt))assert.equal(String(record.runAttempt),String(expected.libraryAttempt || expected.attempt),'durable attempt');
 assert.ok(workflowRunPathMatches(run,'.github/workflows/production-pack.yml'),'durable workflow');
 assert.equal(run.head_branch,'main','durable branch');assert.equal(run.head_repository?.full_name || REPO,REPO,'durable producer fork');assert.equal(String(run.id),String(record.runId),'durable run ID');
 assert.equal(run.head_sha,record.headSha,'durable producer head');assert.equal(run.repository?.full_name,REPO,'durable run repository');assert.equal(String(run.run_attempt),String(record.runAttempt),'durable producer attempt');
 assert.ok(jobs.some(job=>job.name==='pack' && job.conclusion==='success'),'durable immutable pack');
 const artifact=(record.artifacts || []).find(item=>String(item.id)===String(expected.id) && (item.repository || REPO)===(expected.repository || REPO));
 assert.ok(artifact,'durable artifact ID');assert.equal(artifact.workflow_run?.head_sha,expected.headSha,'durable artifact producer head');
 assert.equal(String(artifact.workflow_run?.id),String(expected.runId),'durable artifact run');
 assert.match(artifact.digest || '',/^sha256:[a-f0-9]{64}$/,'durable ZIP digest');
 assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes>0 && artifact.size_in_bytes<=MAX_ZIP_BYTES,'durable ZIP budget');
 if(expected.digest)assert.equal(artifact.digest,`sha256:${expected.digest.replace(/^sha256:/,'')}`,'frozen original ZIP digest');
 assert.ok(expected.repository===CLI_REPO ? artifact.name===`moeicons-cli-${expected.headSha}` : [`moe-icons-production-${expected.version}`,`moe-icons-free-candidate-${expected.version}`].includes(artifact.name),'durable artifact name');
 return {...artifact,expired:false,expires_at:'9999-12-31T23:59:59Z',storage:'private-release',originalActionsExpiresAt:artifact.expires_at,durableRunAttempt:record.runAttempt};
}
async function downloadOnce(route,file,metadata){
 assert.match(route,new RegExp(`^repos/moewolf-dev/moe-icons-(?:code-library|cli)/(?:actions/artifacts/[1-9][0-9]*/zip|releases/assets/[1-9][0-9]*)$`),'trusted artifact download route');
 fs.mkdirSync(path.dirname(file),{recursive:true});
 const child=spawn('gh',['api',route,'-H','Accept: application/octet-stream'],{stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',chunk=>{if(stderr.length<16384)stderr+=chunk.toString();});let size=0;const hash=crypto.createHash('sha256');let timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},10*60*1000);
 const completed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('artifact download failed',{cause:{transient:timedOut || transient({message:stderr})}})));});
 try{
  await Promise.all([completed,pipeline(child.stdout,new Transform({transform(chunk,_,callback){size+=chunk.length;if(size>metadata.size_in_bytes || size>MAX_ZIP_BYTES)return callback(Error('artifact download exceeds budget'));hash.update(chunk);callback(null,chunk);}}),fs.createWriteStream(file,{flags:'wx',mode:0o600}))]);
  assert.equal(size,metadata.size_in_bytes,'downloaded ZIP size');assert.equal(hash.digest('hex'),metadata.digest.slice(7),'downloaded ZIP digest');
 }catch(error){fs.rmSync(file,{force:true});throw error;}finally{clearTimeout(timer);child.kill();}
}
async function download(route,file,metadata){
 for(let attempt=0;;attempt++){
  try{return await downloadOnce(route,file,metadata);}catch(error){
   if(attempt>=2 || !error.cause?.transient)throw error;
   await new Promise(resolve=>setTimeout(resolve,[1000,3000][attempt]));
  }
 }
}
function validateInput(expected){
 assert.match(String(expected.id),/^[1-9][0-9]*$/);assert.match(String(expected.runId),/^[1-9][0-9]*$/);
 assert.match(expected.version || '',/^\d+\.\d+\.\d+$/);assert.match(expected.headSha || '',/^[a-f0-9]{40}$/);
 for(const key of ['attempt','libraryRunId','libraryAttempt'])if(expected[key]!==undefined)assert.match(String(expected[key]),/^[1-9][0-9]*$/,key);
 if(expected.libraryHeadSha!==undefined)assert.match(expected.libraryHeadSha,/^[a-f0-9]{40}$/);
}
function readRecord(expected) {
 const libraryId=expected.libraryRunId || expected.runId;
 assert.match(String(libraryId),/^[1-9][0-9]*$/);assert.match(expected.version || '',/^\d+\.\d+\.\d+$/);assert.match(expected.libraryHeadSha || expected.headSha || '',/^[a-f0-9]{40}$/);
 const current=json(`repos/${REPO}/actions/runs/${libraryId}`);
 const fixed=expected.libraryAttempt || (expected.repository!==CLI_REPO ? expected.attempt : null);
 const attempts=fixed ? [Number(fixed)] : Array.from({length:Math.min(Number(current.run_attempt),20)},(_,i)=>i+1);
 for(const attempt of attempts){
  let release;
  try{release=json(`repos/${REPO}/releases/tags/candidate-v${expected.version}-r${libraryId}-a${attempt}`);}catch(error){if(unavailable(error))continue;throw error;}
  assert.equal(release.draft,false,'durable release draft');
  const recordAsset=release.assets.find(asset=>asset.name==='artifact-record.v1.json');
  if(!recordAsset)throw Error('durable record missing');assert.ok(recordAsset.size<=1024*1024,'durable record budget');
  const record=JSON.parse(execFileSync('gh',['api',`repos/${REPO}/releases/assets/${recordAsset.id}`,'-H','Accept: application/octet-stream'],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024}));
  if(expected.id && !record.artifacts?.some(item=>String(item.id)===String(expected.id)))continue;
  const run=json(`repos/${REPO}/actions/runs/${libraryId}/attempts/${attempt}`);
  const jobs=json(`repos/${REPO}/actions/runs/${libraryId}/attempts/${attempt}/jobs?per_page=100`).jobs || [];
  assert.equal(record.repository,REPO);assert.equal(record.resourceVersion,expected.version);
  assert.equal(String(record.runId),String(libraryId));assert.equal(record.headSha,expected.libraryHeadSha || expected.headSha);
  assert.equal(Number(record.runAttempt),attempt);assert.equal(run.head_sha,record.headSha);assert.equal(run.head_branch,'main');assert.equal(run.repository?.full_name,REPO);
  assert.ok(workflowRunPathMatches(run,'.github/workflows/production-pack.yml') && jobs.some(job=>job.name==='pack' && job.conclusion==='success'),'durable source authority');
  return {record,release,run,jobs};
 }
 throw Error('No exact immutable private candidate record exists');
}
async function retrieve(expected,file){
 validateInput(expected);const repository=expected.repository || REPO;
 assert.ok([REPO,CLI_REPO].includes(repository),'trusted artifact repository');
 let metadata;
 try{metadata=json(`repos/${repository}/actions/artifacts/${expected.id}`);}catch(error){if(!unavailable(error))throw error;}
 if(metadata && !metadata.expired){
  const current=json(`repos/${repository}/actions/runs/${expected.runId}`);
  const attempt=expected.attempt || current.run_attempt;
  const run=json(`repos/${repository}/actions/runs/${expected.runId}/attempts/${attempt}`);
  if(repository===CLI_REPO){
   assert.equal(String(metadata.id),String(expected.id),'CLI artifact ID');assert.equal(metadata.name,`moeicons-cli-${expected.headSha}`,'CLI artifact name');
   assert.match(metadata.digest || '',/^sha256:[a-f0-9]{64}$/,'CLI artifact digest');assert.ok(Number.isSafeInteger(metadata.size_in_bytes) && metadata.size_in_bytes>0 && metadata.size_in_bytes<=MAX_ZIP_BYTES,'CLI artifact size');
   assert.equal(run.repository?.full_name,CLI_REPO,'CLI producer repository');assert.equal(run.head_repository?.full_name || CLI_REPO,CLI_REPO,'CLI producer fork');assert.equal(String(run.id),String(expected.runId),'CLI producer ID');assert.equal(Number(run.run_attempt),Number(attempt),'CLI producer attempt');
   assert.ok(workflowRunPathMatches(run,'.github/workflows/package-candidate.yml'),'CLI producer workflow');
   assert.equal(run.conclusion,'success','CLI producer success');assert.equal(run.head_sha,expected.headSha,'CLI producer head');
   assert.equal(String(metadata.workflow_run?.id),String(expected.runId),'CLI artifact run');assert.equal(metadata.workflow_run.head_sha,expected.headSha,'CLI artifact head');
   if(expected.digest)assert.equal(metadata.digest,`sha256:${expected.digest.replace(/^sha256:/,'')}`);
  }else{
   const jobs=json(`repos/${REPO}/actions/runs/${expected.runId}/attempts/${attempt}/jobs?per_page=100`).jobs || [];
   metadata=artifactRecord({schemaVersion:1,repository:REPO,resourceVersion:expected.version,runId:expected.runId,runAttempt:attempt,headSha:expected.headSha,artifacts:[metadata]},expected,run,jobs);
   metadata.expires_at=metadata.originalActionsExpiresAt;
  }
  metadata.storage='actions';
  if(file)await download(`repos/${repository}/actions/artifacts/${expected.id}/zip`,file,metadata);
  return metadata;
 }
 const {record,release,run,jobs}=readRecord(expected);
 metadata=artifactRecord(record,expected,run,jobs);
 if(repository===CLI_REPO){
  assert.equal(String(record.cliCandidate.artifactId),String(expected.id),'frozen CLI artifact');assert.equal(String(record.cliCandidate.runId),String(expected.runId),'frozen CLI run');assert.equal(record.cliCandidate.commit,expected.headSha,'frozen CLI commit');
  if(expected.attempt)assert.equal(Number(record.cliCandidate.runAttempt),Number(expected.attempt),'frozen CLI attempt');
  const cliRun=json(`repos/${CLI_REPO}/actions/runs/${expected.runId}/attempts/${record.cliCandidate.runAttempt}`);
  assert.ok(workflowRunPathMatches(cliRun,'.github/workflows/package-candidate.yml'),'durable CLI workflow');assert.equal(cliRun.conclusion,'success','durable CLI producer success');assert.equal(cliRun.head_sha,expected.headSha,'durable CLI head');
 }
 const asset=release.assets.find(asset=>asset.name===`artifact-${expected.id}.zip`);
 assert.ok(asset && asset.size===metadata.size_in_bytes,'durable archive size');
 if(file)await download(`repos/${REPO}/releases/assets/${asset.id}`,file,metadata);
 return metadata;
}
async function persist({version,runId,attempt,headSha,ids,directory,cliCandidate,clitest}){
 assert.equal(json(`repos/${REPO}`).private,true,'Pro durable storage must remain private');
 const artifacts=[];
 for(const id of ids){const expected={version,runId,attempt,headSha,id};const metadata=await retrieve(expected,path.join(directory,`artifact-${id}.zip`));delete metadata.storage;delete metadata.originalActionsExpiresAt;delete metadata.durableRunAttempt;artifacts.push(metadata);}
  if(cliCandidate){
  let metadata;const storageToken=process.env.GH_TOKEN;
  try{
   if(process.env.CLI_ARTIFACT_READ_TOKEN)process.env.GH_TOKEN=process.env.CLI_ARTIFACT_READ_TOKEN;
   metadata=await retrieve({version,id:cliCandidate.artifactId,runId:cliCandidate.runId,attempt:cliCandidate.runAttempt,headSha:cliCandidate.commit,repository:CLI_REPO},path.join(directory,`artifact-${cliCandidate.artifactId}.zip`));
  }finally{if(storageToken===undefined)delete process.env.GH_TOKEN;else process.env.GH_TOKEN=storageToken;}
  delete metadata.storage;artifacts.push({...metadata,repository:CLI_REPO});ids=[...ids,cliCandidate.artifactId];
 }
 const record={schemaVersion:1,repository:REPO,resourceVersion:version,runId:String(runId),runAttempt:Number(attempt),headSha,artifacts,...(cliCandidate?{cliCandidate}:{}),...(clitest?{clitest}:{})};
 const recordFile=path.join(directory,'artifact-record.v1.json');fs.writeFileSync(recordFile,JSON.stringify(record,null,2)+'\n',{mode:0o600});
 const tag=`candidate-v${version}-r${runId}-a${attempt}`;
 let existing;
 try{existing=json(`repos/${REPO}/releases/tags/${tag}`);}catch(error){if(!unavailable(error))throw error;}
 if(!existing)execFileSync('gh',['release','create',tag,'--repo',REPO,'--target',headSha,'--title',`Private candidate ${version} (${runId}/${attempt})`,'--notes','Exact original Actions ZIP bytes for bounded and long-term recovery. Pro bytes remain private.'],{stdio:'pipe',timeout:60000});
 for(const file of [recordFile,...ids.map(id=>path.join(directory,`artifact-${id}.zip`))]){
  const release=json(`repos/${REPO}/releases/tags/${tag}`);const name=path.basename(file);const asset=release.assets.find(asset=>asset.name===name);
  if(!asset)upload(tag,file);
  else{
   if(name==='artifact-record.v1.json')assert.deepEqual(JSON.parse(execFileSync('gh',['api',`repos/${REPO}/releases/assets/${asset.id}`,'-H','Accept: application/octet-stream'],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024})),record,'immutable durable record');
   else {const meta=artifacts.find(item=>name===`artifact-${item.id}.zip`);await download(`repos/${REPO}/releases/assets/${asset.id}`,file+'.readback',meta);fs.rmSync(file+'.readback');}
  }
 }
 // Read back all saved bytes, including the original CLI envelope.
 const saved=json(`repos/${REPO}/releases/tags/${tag}`);
 const savedRecord=saved.assets.find(a=>a.name==='artifact-record.v1.json');assert.ok(savedRecord && savedRecord.size<=1024*1024);
 assert.deepEqual(JSON.parse(execFileSync('gh',['api',`repos/${REPO}/releases/assets/${savedRecord.id}`,'-H','Accept: application/octet-stream'],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024})),record,'saved immutable record');
 for(const artifact of artifacts){
  const file=path.join(directory,`artifact-${artifact.id}.zip.readback`);
  const asset=saved.assets.find(asset=>asset.name===`artifact-${artifact.id}.zip`);
  assert.ok(asset && asset.size===artifact.size_in_bytes,'saved artifact size');
  await download(`repos/${REPO}/releases/assets/${asset.id}`,file,artifact);fs.rmSync(file);
 }
 return record;
}
function saveProgress({version,runId,attempt,headSha,ownerId,ownerAttempt,files}) {
 const expected={version,runId,attempt,headSha};
 const {record,release,run,jobs}=readRecord(expected);
 const first=record.artifacts.find(item=>(item.repository || REPO)===REPO);
 artifactRecord(record,{...expected,id:first.id},run,jobs);
 const owner=json(`repos/${REPO}/actions/runs/${ownerId}/attempts/${ownerAttempt}`);
 assert.equal(owner.head_branch,'main');assert.equal(owner.repository?.full_name,REPO);
 assert.ok(['.github/workflows/production-pack.yml','.github/workflows/production-acceptance-resume.yml'].some(file=>workflowRunPathMatches(owner,file)),'checkpoint owner workflow');
 const allowed=new Set(['acceptance-plan.json','acceptance-checkpoint.json','acceptance-source.json','acceptance-recovery-manifest.json','acceptance-report.json','plugin-delivery-receipt.json']);
 const payload={schemaVersion:1,resourceVersion:version,runId:String(runId),runAttempt:Number(attempt),headSha,ownerId:String(ownerId),ownerAttempt:Number(ownerAttempt),ownerHeadSha:owner.head_sha,files:{}};
 for(const [name,file] of Object.entries(files)){
  assert.ok(allowed.has(name),'durable checkpoint filename');
  if(!fs.existsSync(file))continue;
  const bytes=fs.readFileSync(file);assert.ok(bytes.length<=8*1024*1024,'durable checkpoint file budget');
  payload.files[name]=JSON.parse(bytes.toString('utf8'));
 }
 if(!payload.files['acceptance-checkpoint.json'] || !payload.files['acceptance-plan.json'] || !payload.files['acceptance-source.json'])return false;
 const name=`progress-${ownerId}-${ownerAttempt}.json`;
 const destination=path.join(process.env.RUNNER_TEMP || path.dirname(files['acceptance-checkpoint.json']),name);
 fs.writeFileSync(destination,JSON.stringify(payload,null,2)+'\n',{mode:0o600});
 const existing=release.assets.find(asset=>asset.name===name);
 if(!existing)upload(release.tag_name,destination);
 const after=json(`repos/${REPO}/releases/tags/${release.tag_name}`).assets.find(asset=>asset.name===name);
 assert.ok(after && after.size<=32*1024*1024,'saved checkpoint envelope');
 const saved=JSON.parse(execFileSync('gh',['api',`repos/${REPO}/releases/assets/${after.id}`,'-H','Accept: application/octet-stream'],{encoding:'utf8',timeout:30000,maxBuffer:32*1024*1024}));
 assert.deepEqual(saved,payload,'immutable checkpoint bytes');return true;
}
function restoreProgress({version,runId,attempt,headSha,ownerId,ownerAttempt,directory}) {
 const expected={version,runId,attempt,headSha};const {record,release,run,jobs}=readRecord(expected);
 const first=record.artifacts.find(item=>(item.repository || REPO)===REPO);artifactRecord(record,{...expected,id:first.id},run,jobs);
 const asset=release.assets.find(asset=>asset.name===`progress-${ownerId}-${ownerAttempt}.json`);
 assert.ok(asset && asset.size<=32*1024*1024,'exact durable checkpoint not found');
 const saved=JSON.parse(execFileSync('gh',['api',`repos/${REPO}/releases/assets/${asset.id}`,'-H','Accept: application/octet-stream'],{encoding:'utf8',timeout:30000,maxBuffer:32*1024*1024}));
 for(const [key,value] of Object.entries({schemaVersion:1,resourceVersion:version,runId:String(runId),runAttempt:Number(attempt),headSha,ownerId:String(ownerId),ownerAttempt:Number(ownerAttempt)}))assert.equal(saved[key],value,'durable checkpoint '+key);
 const owner=json(`repos/${REPO}/actions/runs/${ownerId}/attempts/${ownerAttempt}`);
 assert.equal(owner.head_sha,saved.ownerHeadSha);assert.equal(owner.head_branch,'main');assert.equal(owner.repository?.full_name,REPO);assert.equal(String(owner.id),String(ownerId));assert.equal(Number(owner.run_attempt),Number(ownerAttempt));
 assert.ok(['.github/workflows/production-pack.yml','.github/workflows/production-acceptance-resume.yml'].some(file=>workflowRunPathMatches(owner,file)));
 fs.mkdirSync(directory,{recursive:true});
 for(const [name,value] of Object.entries(saved.files)){
  assert.ok(['acceptance-plan.json','acceptance-checkpoint.json','acceptance-source.json','acceptance-recovery-manifest.json','acceptance-report.json','plugin-delivery-receipt.json'].includes(name),'checkpoint path allowlist');
  fs.writeFileSync(path.join(directory,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
 }
 return record;
}
module.exports={artifactRecord,retrieve,persist,download,readRecord,saveProgress,restoreProgress};
if(require.main===module){
 const args=process.argv.slice(2),arg=name=>args[args.indexOf(name)+1];
 const task=args[0];
 const expected={id:arg('--id'),version:arg('--version'),runId:arg('--run'),attempt:args.includes('--attempt')?arg('--attempt'):undefined,headSha:arg('--head'),digest:args.includes('--digest')?arg('--digest'):undefined,repository:args.includes('--repository')?arg('--repository'):REPO,libraryRunId:args.includes('--library-run')?arg('--library-run'):undefined,libraryAttempt:args.includes('--library-attempt')?arg('--library-attempt'):undefined,libraryHeadSha:args.includes('--library-head')?arg('--library-head'):undefined};
 const run=task==='persist'?persist({...expected,ids:arg('--ids').split(','),directory:arg('--directory'),cliCandidate:args.includes('--cli-candidate')?JSON.parse(fs.readFileSync(arg('--cli-candidate'),'utf8')):undefined,clitest:args.includes('--clitest')?JSON.parse(arg('--clitest')):undefined}):retrieve(expected,args.includes('--zip')?arg('--zip'):null).then(metadata=>{if(args.includes('--metadata'))fs.writeFileSync(arg('--metadata'),JSON.stringify(metadata,null,2)+'\n',{mode:0o600});return metadata;});
 run.then(()=>console.log('Exact resource artifact provenance and bytes verified')).catch(error=>{console.error(error.message);process.exitCode=1;});
}
