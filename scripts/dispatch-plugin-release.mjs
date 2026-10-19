import { workflowRunPathMatches } from './workflow-run-path.cjs';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {buildCliPackageSetDelivery} from './cli-package-set-delivery.mjs';
const api=(path)=>JSON.parse(execFileSync('gh',['api',path],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024}));
const assert=(v,m)=>{if(!v)throw new Error(m);};
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const canonicalBytes=value=>Buffer.from(`${JSON.stringify(canonical(value))}\n`);
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const id=process.env.CLI_PUBLISH_RUN_ID;
assert(/^[1-9]\d*$/.test(id || ''),'publish run id required');
const run=api(`repos/moewolf-dev/moe-icons-cli/actions/runs/${id}`);
assert(workflowRunPathMatches(run, '.github/workflows/publish.yml') && run.conclusion==='success','only successful canonical publish runs may notify plugins');
const receipt=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
assert(receipt.schemaVersion===1 && receipt.repository==='moewolf-dev/moe-icons-cli' && String(receipt.runId)===id && receipt.provenance===true && receipt.conclusion==='success','receipt producer mismatch');
assert(/^\d+\.\d+\.\d+$/.test(receipt.version) && /^[a-f0-9]{40}$/.test(receipt.releaseCommit) && /^sha512-/.test(receipt.npmIntegrity),'receipt identity invalid');
const registry=await (await fetch(`https://registry.npmjs.org/@moewolf%2fmoe-icons-cli/${receipt.version}`,{signal:AbortSignal.timeout(30000)})).json();
assert(registry.dist?.integrity===receipt.npmIntegrity,'published integrity mismatch');
const pin=api(`repos/moewolf-dev/moe-icons-cli/contents/src/catalog/resource-release.json?ref=${receipt.releaseCommit}`);
const resource=JSON.parse(Buffer.from(pin.content,'base64').toString());
const eventId=`resource:${resource.resourceVersion}:cli:${receipt.version}`;
let delivery,eventType='moe-icons-cli-release',packageSet=false;
if(resource.schemaVersion===2 && resource.packageSets){
 const joint=buildCliPackageSetDelivery({resource,receipt,run,publishRunId:id});
 assert(joint.eventId===eventId,'CLI package-set event identity mismatch');
 delivery=joint.delivery;
 packageSet=true;
}else{
 delivery={eventId,cliVersion:receipt.version,cliPublishRunId:id,cliPublishHead:run.head_sha,cliNpmIntegrity:receipt.npmIntegrity,resourceVersion:resource.resourceVersion,descriptorSha256:resource.privateDescriptorSha256,cliReleaseCommit:receipt.releaseCommit};
 // A legacy CLI-only event is accepted only as an exact repair of an already
 // verified resource baseline. A new package-set release is delivered above.
 const pluginStateEntry=api('repos/moewolf-dev/moe-icons-plugins/contents/data/release-state.json?ref=main');
 const pluginState=JSON.parse(Buffer.from(pluginStateEntry.content,'base64').toString());
 const baseline=(pluginState.events || []).filter(item=>item.phase==='verified' && item.event?.resourceVersion===resource.resourceVersion).at(-1);
 if(!baseline || baseline.event.descriptorSha256!==resource.privateDescriptorSha256 || baseline.event.sourceCommit!==resource.sourceCommit){
  console.log(JSON.stringify({eventId,status:'resource-coordinator-owned',reason:'new resource requires exact joint artifact delivery'}));
  process.exit(0);
 }
}
assert(process.env.PLUGIN_DISPATCH_TOKEN,'Configure PLUGIN_DISPATCH_TOKEN: plugin repository Contents write only; never reuse a broad user token');
const start=Date.now();
execFileSync('gh',['api','--method','POST','repos/moewolf-dev/moe-icons-plugins/dispatches','--input','-'],{input:JSON.stringify({event_type:eventType,client_payload:{eventId,delivery}}),env:{...process.env,GH_TOKEN:process.env.PLUGIN_DISPATCH_TOKEN},stdio:['pipe','inherit','inherit'],timeout:30000});
console.log(JSON.stringify({eventId,publishRunId:id,status:'dispatched'}));

let receiver;
let firstReceiverFailure=null;
while(Date.now()-start<75*60*1000){
 const list=api('repos/moewolf-dev/moe-icons-plugins/actions/workflows/resource-update.yml/runs?per_page=50').workflow_runs || [];
 const matching=list.filter(r=>r.event==='repository_dispatch' && r.display_title===`Plugin resource ${eventId}` && Date.parse(r.created_at)>=start-5000);
 assert(matching.length<=1,'ambiguous plugin receiver runs');receiver=matching[0];
 if(receiver?.status==='completed'){
  if(receiver.conclusion!=='success' && Number(receiver.run_attempt)===1){
   firstReceiverFailure ??= Date.now();
   if(Date.now()-firstReceiverFailure<120000){await new Promise(resolve=>setTimeout(resolve,10000));continue;}
  }
  assert(receiver.conclusion==='success',`Plugin receiver failed: ${receiver.html_url}; replay notification without republishing CLI`);
  const dir=fs.mkdtempSync('/tmp/moe-plugin-receipt-');
  try{
   execFileSync('gh',['run','download',String(receiver.id),'--repo','moewolf-dev/moe-icons-plugins','--name',`plugin-publication-receipt-${receiver.run_attempt || 1}`,'--dir',dir],{timeout:60000});
   const report=JSON.parse(fs.readFileSync(`${dir}/plugin-publication-receipt.json`,'utf8'));
   assert(report.eventId===eventId && report.cliVersion===receipt.version && report.resourceVersion===resource.resourceVersion && report.marketplaceVerified===true && /^[a-f0-9]{64}$/.test(report.vsixSha256 || ''),'Plugin publication receipt mismatch');
   if(packageSet)assert(report.packageSetDigests?.free===resource.packageSets.free.packageSetSha256&&report.packageSetDigests?.pro===resource.packageSets.pro.packageSetSha256,'Plugin package-set receipt mismatch');
   else assert(report.descriptorSha256===resource.privateDescriptorSha256,'Plugin descriptor receipt mismatch');
   if(packageSet){
    const reportBytes=fs.readFileSync(`${dir}/plugin-publication-receipt.json`);
    const proof={schemaVersion:1,state:'cli-plugin-package-set-marketplace-verified',eventId,resourceVersion:resource.resourceVersion,
     cliVersion:receipt.version,sourceCommit:resource.sourceCommit,generatorCommit:resource.generatorCommit,sourceDispatchId:resource.sourceDispatchId,
     packageSets:resource.packageSets,producer:resource.producer,
     cliPublish:{repository:'moewolf-dev/moe-icons-cli',runId:String(id),headSha:run.head_sha,releaseCommit:receipt.releaseCommit,npmIntegrity:receipt.npmIntegrity,provenance:true},
     plugin:{repository:'moewolf-dev/moe-icons-plugins',workflow:'.github/workflows/resource-update.yml',runId:String(receiver.id),runAttempt:receiver.run_attempt,
      headSha:receiver.head_sha,receiptSha256:sha256(reportBytes),receiptBytesBase64:reportBytes.toString('base64'),receipt:report}};
    const proofPath=process.env.CLI_PLUGIN_VERIFICATION_RECEIPT;
    assert(proofPath,'CLI_PLUGIN_VERIFICATION_RECEIPT output path required for package-set delivery');
    fs.writeFileSync(proofPath,canonicalBytes(proof),{flag:'wx',mode:0o600});
    if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,'package_set_receipt=true\n');
   }
   console.log(JSON.stringify({status:'verified',receiverRunId:receiver.id,receipt:report}));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
  process.exit(0);
 }
 console.log(JSON.stringify({eventId,receiver:receiver?.html_url,status:receiver?.status || 'awaiting receiver'}));
 await new Promise(resolve=>setTimeout(resolve,10000));
}
throw new Error('Plugin notification timed out; replay notification from the same published CLI run');
