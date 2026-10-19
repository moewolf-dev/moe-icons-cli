import { cpSync, mkdirSync } from 'node:fs';
const target = new URL('../dist/core/small-pack/', import.meta.url);
mkdirSync(target, { recursive: true });
for (const name of ['candidate-set.cjs', 'candidate-set.d.cts', 'candidate-set-v1.schema.json', 'tar-read.cjs', 'tar-read.d.cts', 'PIN.json']) cpSync(new URL('../src/core/small-pack/' + name, import.meta.url), new URL(name, target));
