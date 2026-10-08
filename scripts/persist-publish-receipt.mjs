import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
const receipt=JSON.parse(fs.readFileSync('receipt/cli-publish-receipt.json','utf8'));
const gh=(...args)=>execFileSync('gh',args,{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
const release=JSON.parse(gh('release','view',receipt.tag,'--json','assets'));
if(release.assets.some(a=>a.name==='cli-publish-receipt.json')){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'cli-receipt-'));
 try{gh('release','download',receipt.tag,'--pattern','cli-publish-receipt.json','--dir',temp);const prior=JSON.parse(fs.readFileSync(path.join(temp,'cli-publish-receipt.json'),'utf8'));for(const key of ['version','releaseCommit','tgzSha256','npmIntegrity','provenance'])if(prior[key]!==receipt[key])throw new Error('Immutable published receipt conflicts with this candidate');}finally{fs.rmSync(temp,{recursive:true,force:true});}
}else gh('release','upload',receipt.tag,'receipt/cli-publish-receipt.json');
console.log('Durable publish receipt verified');
