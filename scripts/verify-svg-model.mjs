import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifySvgModel({ root, sourceRepo, requireExact = false }) {
  const directory = join(root, 'src/generator/shared');
  const manifest = JSON.parse(readFileSync(join(directory, 'SOURCE.json'), 'utf8'));
  const bytes = readFileSync(join(directory, 'svg-model.cjs'));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (manifest.sourceRepo !== 'moewolf-dev/moe-icons-code-library' || manifest.sourcePath !== 'scripts/svg-model.cjs' || !/^[0-9a-f]{40}$/.test(manifest.sourceCommit) || manifest.sha256 !== digest) throw new Error('invalid SVG parser source manifest or digest');
  if (requireExact && manifest.sourceCommitExact !== true) throw new Error('SVG parser must be synced from committed source before packaging an Actions candidate');
  if (sourceRepo) {
    const commit = execFileSync('git', ['-C', sourceRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (commit !== manifest.sourceCommit) throw new Error('SVG parser source checkout does not match the pinned commit');
    const sourceBytes = readFileSync(join(sourceRepo, manifest.sourcePath));
    if (!sourceBytes.equals(bytes)) throw new Error('SVG parser differs from its pinned source');
  }
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifySvgModel({ root: resolve(dirname(fileURLToPath(import.meta.url)), '..'), sourceRepo: process.env.MOEICONS_SVG_MODEL_REPO, requireExact: true });
}
