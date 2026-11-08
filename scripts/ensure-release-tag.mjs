import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function ensureReleaseTag({repo='moewolf-dev/moe-icons-cli',tag,commit,token,fetchImpl=fetch}) {
  assert.equal(repo,'moewolf-dev/moe-icons-cli');assert.match(tag,/^v\d+\.\d+\.\d+$/);assert.match(commit,/^[a-f0-9]{40}$/);assert.ok(token);
  const headers={Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','Content-Type':'application/json'};
  const request=(path,options={})=>fetchImpl(`https://api.github.com/repos/${repo}/${path}`,{headers,redirect:'error',signal:AbortSignal.timeout(30000),...options});
  // GitHub explains refusals in the response body (message, documentation_url)
  // and a request id; keep them for diagnosis without ever echoing the token.
  const describe=async(response,what)=>{
    let body='';try{body=await response.clone().text();}catch{}
    let message='',documentation='';
    try{const parsed=JSON.parse(body);message=String(parsed.message||'');documentation=String(parsed.documentation_url||'');}catch{}
    const requestId=response.headers?.get?.('x-github-request-id')||'';
    return `${what} failed (HTTP ${response.status}${requestId?`, request ${requestId}`:''})`+
      `${message?`: ${message}`:''}${documentation?` (${documentation})`:''}`+
      ` [tag=${tag} commit=${commit}]`;
  };
  let response=await request(`git/ref/tags/${tag}`);let created=false;
  if(response.status===404) {
    response=await request('git/refs',{method:'POST',body:JSON.stringify({ref:`refs/tags/${tag}`,sha:commit})});
    // A concurrent exact creation may return 422. It still must pass fresh readback.
    assert.ok(response.status===201||response.status===422,await describe(response,'GitHub ref creation'));
    created=response.status===201;
    response=await request(`git/ref/tags/${tag}`);
  }
  assert.equal(response.status,200,await describe(response,'GitHub ref lookup'));
  const ref=await response.json();assert.equal(ref.ref,`refs/tags/${tag}`);assert.equal(ref.object?.type,'commit');assert.equal(ref.object?.sha,commit,'release tag target mismatch');
  return {status:'verified',repo,tag,commit,created};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.GITHUB_REF,'refs/heads/main');
  assert.ok(['moewolf-dev/moe-icons-cli','moewolf-dev/moe-icons-code-library'].includes(process.env.GITHUB_REPOSITORY));
  console.log(JSON.stringify(await ensureReleaseTag({tag:process.env.TAG,commit:process.env.CLI_COMMIT,token:process.env.GH_TOKEN})));
}
