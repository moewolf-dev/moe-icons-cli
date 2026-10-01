import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = process.env.MOEICONS_CODE_LIBRARY_REPO ?? resolve(root, '../moe-icons-code-library');
const relative = 'scripts/svg-model.cjs';
const bytes = readFileSync(join(repo, relative));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const sourceCommit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
let sourceCommitExact = false;
try { sourceCommitExact = digest(execFileSync('git', ['-C', repo, 'show', `HEAD:${relative}`], { stdio: ['ignore', 'pipe', 'ignore'] })) === digest(bytes); } catch { /* New local source: explicitly not a committed candidate. */ }
const target = join(root, 'src/generator/shared');
mkdirSync(target, { recursive: true });
writeFileSync(join(target, 'svg-model.cjs'), bytes);
writeFileSync(join(target, 'SOURCE.json'), JSON.stringify({ sourceRepo: 'moewolf-dev/moe-icons-code-library', sourcePath: relative, sourceCommit, sourceCommitExact, sha256: digest(bytes) }, null, 2) + '\n');
