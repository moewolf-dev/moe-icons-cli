import {readFileSync,readdirSync,appendFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export function verifyRecoveryIdentity({run,jobs,pkg,manifest,sha,repository,runId}) {
  if (String(run.id)!==String(runId)||run.repository?.full_name!==repository||run.head_branch!=='main'||run.path!=='.github/workflows/publish.yml'||run.status!=='completed'||run.conclusion!=='failure') throw Error('not a failed main publish workflow from this repository');
  if (jobs.total_count>100) throw Error('job history exceeds verified page');
  const successful=name=>jobs.jobs.filter(j=>j.name===name&&j.status==='completed'&&j.conclusion==='success').sort((a,b)=>b.id-a.id)[0];
  // Push releases validate inside pack; only manual entrypoints have a validate job.
  if (!successful('pack')||!successful('acceptance')||(run.event!=='push'&&!successful('validate'))) throw Error('original complete pack, acceptance and manual-entry validation required');
  const publish=jobs.jobs.filter(j=>j.name==='publish').sort((a,b)=>b.id-a.id)[0];
  if (publish?.conclusion!=='failure') throw Error('only failed publication can resume');
  if (pkg.name!=='@moewolf/moe-icons-cli'||!/^\d+\.\d+\.\d+$/.test(pkg.version)||! /^[a-f0-9]{64}$/.test(pkg.payloadHash??'')) throw Error('invalid frozen package identity');
  if (manifest.schemaVersion!==1||manifest.version!==pkg.version||manifest.sha256!==sha) throw Error('candidate manifest mismatch');
  return {acceptanceJob:successful('acceptance').id,version:pkg.version,payloadHash:pkg.payloadHash};
}
if (process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=resolve(process.argv[2]);
  const json=p=>JSON.parse(readFileSync(p,'utf8'));
  const run=json(join(root,'run.json')),jobs=json(join(root,'jobs.json'));
  const candidates=readdirSync(join(root,'artifacts')); if(candidates.length!==1) throw Error('exactly one candidate artifact required');
  const dir=join(root,'artifacts',candidates[0]);const tarballs=readdirSync(dir).filter(n=>n.endsWith('.tgz'));if(tarballs.length!==1)throw Error('exactly one immutable tarball required');
  const tgz=join(dir,tarballs[0]),sha=createHash('sha256').update(readFileSync(tgz)).digest('hex');
  const pkg=JSON.parse(execFileSync('tar',['-xOf',tgz,'package/package.json'],{encoding:'utf8'}));
  const identity=verifyRecoveryIdentity({run,jobs,pkg,manifest:json(join(dir,'candidate-manifest.json')),sha,repository:process.env.GITHUB_REPOSITORY,runId:process.env.RUN_ID});
  const gh=args=>execFileSync('gh',args,{encoding:'utf8'});
  const acceptanceLog=gh(['run','view',String(run.id),'--repo',process.env.GITHUB_REPOSITORY,'--job',String(identity.acceptanceJob),'--log']);
  if (!acceptanceLog.includes(`candidate_sha=${sha}`))throw Error('original accepted artifact digest not found');
  const frozen=JSON.parse(execFileSync(process.execPath,['scripts/release-commit.mjs','find','--payload-hash',pkg.payloadHash,'--source-commit',run.head_sha],{encoding:'utf8'}));
  if (!frozen||frozen.version!==pkg.version)throw Error('original frozen release commit not found');
  const draft=JSON.parse(gh(['release','view',frozen.tag,'--repo',process.env.GITHUB_REPOSITORY,'--json','isDraft,targetCommitish,body']));
  if (!draft.isDraft||draft.targetCommitish!==frozen.sha||!draft.body.includes(`sha256: ${sha}`)||!draft.body.includes(`payloadHash: ${pkg.payloadHash}`)) throw Error('draft release does not bind this immutable candidate');
  const tag=JSON.parse(gh(['api',`repos/${process.env.GITHUB_REPOSITORY}/git/ref/tags/${frozen.tag}`]));
  if(tag.object.type!=='commit'||tag.object.sha!==frozen.sha)throw Error('frozen tag mismatch');
  const originalPkg=JSON.parse(execFileSync('git',['show',`${frozen.sha}:package.json`],{encoding:'utf8'}));
  if(JSON.stringify(originalPkg)!==JSON.stringify(pkg))throw Error('packed package differs from frozen commit');
  const outputs={candidate_sha:sha,cli_commit:frozen.sha,release_tag:frozen.tag,next_version:pkg.version,payload_hash:pkg.payloadHash,pin_commit:run.head_sha};
  for(const [key,value]of Object.entries(outputs))appendFileSync(process.env.GITHUB_OUTPUT,`${key}=${value}\n`);
  console.log(JSON.stringify({originalRun:run.id,acceptanceJob:identity.acceptanceJob,...outputs}));
}
