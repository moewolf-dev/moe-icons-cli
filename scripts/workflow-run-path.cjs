'use strict';

// Accept only the exact workflow path and an optional ref bound to the API run.
function canonicalWorkflowRunPath(run) {
  const value = String(run?.path || '');
  const [file, ref, extra] = value.split('@');
  if (extra !== undefined || !/^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/.test(file)) return null;
  if (ref !== undefined) {
    const branch = String(run?.head_branch || '');
    if (!branch || ![branch, `refs/heads/${branch}`, `refs/tags/${branch}`].includes(ref)) return null;
  }
  return file;
}
function workflowRunPathMatches(run, expected) {
  return canonicalWorkflowRunPath(run) === expected;
}
module.exports = { canonicalWorkflowRunPath, workflowRunPathMatches };
