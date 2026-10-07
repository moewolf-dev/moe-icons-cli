import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateCodeLibraryReleaseEvent } from './validate-code-library-event.mjs';
import { validateFreeCatalog, assertCatalogMatchesDescriptor } from './refresh-bundled-catalog.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (value, message) => { if (!value) throw new Error(message); };
export function verifyPinCandidate({ event: input, artifact, candidateDir }) {
  const event = validateCodeLibraryReleaseEvent(input);
  assert(String(artifact.id) === event.freeCandidateArtifactId && artifact.expired === false, 'candidate artifact identity/expiry mismatch');
  assert(String(artifact.workflow_run?.id) === event.upstreamRunId, 'candidate artifact upstream run mismatch');
  assert(artifact.workflow_run?.head_sha === event.generatorCommit, 'candidate artifact generator commit mismatch');
  const root = realpathSync(candidateDir);
  const read = name => {
    assert(typeof name === 'string' && /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..', 'unsafe candidate filename');
    const file = realpathSync(resolve(root, name));
    assert(file.startsWith(root + sep), 'candidate file escapes root');
    return readFileSync(file);
  };
  const descriptorBytes = read('release-descriptor.json');
  assert(sha(descriptorBytes) === event.publicDescriptorSha256, 'public descriptor digest mismatch');
  const descriptor = JSON.parse(descriptorBytes);
  assert(!descriptor.pro && !descriptor.ent && descriptor.fullVersion === event.resourceVersion && descriptor.sourceCommit === event.sourceCommit && descriptor.generatorCommit === event.generatorCommit, 'candidate descriptor identity mismatch');
  const ref = descriptor.free?.metadata;
  assert(ref && ref.filename === `moe-icons-free-metadata-${event.resourceVersion}.tgz`, 'missing candidate metadata reference');
  const archive = read(ref.filename);
  assert(sha(archive) === ref.sha256 && archive.length === ref.size, 'metadata archive digest/size mismatch');
  const archivePath = resolve(root, ref.filename);
  const entries = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }).trim().split(/\r?\n/);
  const catalogs = entries.filter(name => name.replace(/^\.\//, '') === 'metadata/catalog.json');
  assert(catalogs.length === 1, 'metadata must contain exactly one canonical catalog');
  // Read one named member; never extract archive paths into the runner workspace.
  const bytes = execFileSync('tar', ['-xzOf', archivePath, catalogs[0]], { maxBuffer: 8 * 1024 * 1024 });
  const catalogRef = ref.files?.['catalog.json'];
  assert(catalogRef && bytes.length === catalogRef.size && sha(bytes) === catalogRef.sha256, 'catalog digest/size mismatch');
  const catalog = JSON.parse(bytes);
  validateFreeCatalog(catalog);
  assertCatalogMatchesDescriptor(catalog, descriptor);
  const catalogText = JSON.stringify(catalog, null, 2) + '\n';
  return { catalogText, catalogSha256: sha(catalogText), inputCatalogSha256: sha(bytes) };
}

if (process.argv[1]?.endsWith('verify-pin-candidate.mjs')) {
  try {
    const [eventPath, artifactPath, candidateDir, output] = process.argv.slice(2);
    const result = verifyPinCandidate({ event: JSON.parse(readFileSync(eventPath)), artifact: JSON.parse(readFileSync(artifactPath)), candidateDir });
    writeFileSync(output, result.catalogText);
    process.stdout.write(JSON.stringify({ catalogSha256: result.catalogSha256, inputCatalogSha256: result.inputCatalogSha256 }) + '\n');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
