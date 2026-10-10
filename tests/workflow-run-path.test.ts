import {test,expect} from 'vitest';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {workflowRunPathMatches}=createRequire(import.meta.url)('../scripts/workflow-run-path.cjs');

const path = '.github/workflows/package-candidate.yml';
test('workflow path is exact and optional ref is bound to producer branch/tag', () => {
  for (const suffix of ['', '@main', '@refs/heads/main', '@refs/tags/main'])
    assert.equal(workflowRunPathMatches({path:path+suffix,head_branch:'main'},path),true);
  assert.equal(workflowRunPathMatches({path:path+'@v1.2.3',head_branch:'v1.2.3'},path),true);
  for(const value of [path+'@other',path+'@main@other','other/'+path,path.replace('package-candidate','publish')])
    assert.equal(workflowRunPathMatches({path:value,head_branch:'main'},path),false);
  assert.equal(workflowRunPathMatches({path:path+'@main'},path),false);
});
