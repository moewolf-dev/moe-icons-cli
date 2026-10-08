import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const api=(path)=>JSON.parse(execFileSync('gh',['api',path],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024}));
const assert=(v,m)=>{if(!v)throw new Error(m);};
const id=process.env.CLI_PUBLISH_RUN_ID;
assert(/^[1-9]\d*$/.test(id || ''),'publish run id required');
const run=api(`repos/moewolf-dev/moe-icons-cli/actions/runs/${id}`);
assert(run.path==='.github/workflows/publish.yml' && run.conclusion==='success','only successful canonical publish runs may notify plugins');
const receipt=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
assert(receipt.schemaVersion===1 && receipt.repository==='moewolf-dev/moe-icons-cli' && String(receipt.runId)===id && receipt.provenance===true && receipt.conclusion==='success','receipt producer mismatch');
assert(/^\d+\.\d+\.\d+$/.test(receipt.version) && /^[a-f0-9]{40}$/.test(receipt.releaseCommit) && /^sha512-/.test(receipt.npmIntegrity),'receipt identity invalid');
const registry=await (await fetch(`https://registry.npmjs.org/@moewolf%2fmoe-icons-cli/${receipt.version}`,{signal:AbortSignal.timeout(30000)})).json();
assert(registry.dist?.integrity===receipt.npmIntegrity,'published integrity mismatch');
const pin=api(`repos/moewolf-dev/moe-icons-cli/contents/src/catalog/resource-release.json?ref=${receipt.releaseCommit}`);
const resource=JSON.parse(Buffer.from(pin.content,'base64').toString());
const eventId=`resource:${resource.resourceVersion}:cli:${receipt.version}`;
const delivery={eventId,cliVersion:receipt.version,cliPublishRunId:id,cliPublishHead:run.head_sha,cliNpmIntegrity:receipt.npmIntegrity,resourceVersion:resource.resourceVersion,descriptorSha256:resource.privateDescriptorSha256,cliReleaseCommit:receipt.releaseCommit};
assert(process.env.PLUGIN_DISPATCH_TOKEN,'Configure PLUGIN_DISPATCH_TOKEN: plugin repository Contents write only; never reuse a broad user token');
const start=Date.now();
execFileSync('gh',['api','--method','POST','repos/moewolf-dev/moe-icons-plugins/dispatches','--input','-'],{input:JSON.stringify({event_type:'moe-icons-cli-release',client_payload:{eventId,delivery}}),env:{...process.env,GH_TOKEN:process.env.PLUGIN_DISPATCH_TOKEN},stdio:['pipe','inherit','inherit'],timeout:30000});
console.log(JSON.stringify({eventId,publishRunId:id,status:'dispatched'}));

let receiver;
while(Date.now()-start<75*60*1000){
 const list=api('repos/moewolf-dev/moe-icons-plugins/actions/workflows/resource-update.yml/runs?per_page=50').workflow_runs || [];
 const matching=list.filter(r=>r.event==='repository_dispatch' && r.display_title===`Plugin resource ${eventId}` && Date.parse(r.created_at)>=start-5000);
 assert(matching.length<=1,'ambiguous plugin receiver runs');receiver=matching[0];
 if(receiver?.status==='completed'){
  assert(receiver.conclusion==='success',`Plugin receiver failed: ${receiver.html_url}; replay notification without republishing CLI`);
  const dir=fs.mkdtempSync('/tmp/moe-plugin-receipt-');
  try{
   execFileSync('gh',['run','download',String(receiver.id),'--repo','moewolf-dev/moe-icons-plugins','--name','plugin-publication-receipt','--dir',dir],{timeout:60000});
   const report=JSON.parse(fs.readFileSync(`${dir}/plugin-publication-receipt.json`,'utf8'));
   assert(report.eventId===eventId && report.cliVersion===receipt.version && report.resourceVersion===resource.resourceVersion && report.descriptorSha256===resource.privateDescriptorSha256 && report.marketplaceVerified===true && /^[a-f0-9]{64}$/.test(report.vsixSha256 || ''),'Plugin publication receipt mismatch');
   console.log(JSON.stringify({status:'verified',receiverRunId:receiver.id,receipt:report}));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
  process.exit(0);
 }
 console.log(JSON.stringify({eventId,receiver:receiver?.html_url,status:receiver?.status || 'awaiting receiver'}));
 await new Promise(resolve=>setTimeout(resolve,10000));
}
throw new Error('Plugin notification timed out; replay notification from the same published CLI run');
