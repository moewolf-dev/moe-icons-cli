import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifyPinCandidate } from '../scripts/verify-pin-candidate.mjs';
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
it('binds candidate archive and catalog to the exact event and workflow run', () => {
 const root = mkdtempSync(join(tmpdir(), 'moe-pin-proof-'));
 try {
  mkdirSync(join(root, 'metadata'));
  const catalog = JSON.stringify({ schemaVersion: 1, catalogVersion: '0.0.18', sourceVersion: '0.0.18', sourceCommit: 'a'.repeat(40), generatorCommit: 'b'.repeat(40), styleGroups: ['moe-colored','moe-lite-outline','moe-outline','moe-solid'].map(id => ({id,type:'outline',tiers:['free','pro'],formats:['svg'],imageSizes:[]})), icons: [{id:'ui-search',prefix:'ui',label:'Search',aliases:[],availableIn:['moe-outline']}] });
  writeFileSync(join(root, 'metadata/catalog.json'), catalog);
  const filename = 'moe-icons-free-metadata-0.0.18.tgz';
  execFileSync('tar', ['-czf', join(root, filename), '-C', root, 'metadata']);
  const archive = readFileSync(join(root, filename));
  const descriptor = JSON.stringify({ fullVersion:'0.0.18',sourceCommit:'a'.repeat(40),generatorCommit:'b'.repeat(40),free:{metadata:{filename,size:archive.length,sha256:sha(archive),files:{'catalog.json':{size:Buffer.byteLength(catalog),sha256:sha(catalog)}}}} });
  writeFileSync(join(root, 'release-descriptor.json'), descriptor);
  const event = {resourceVersion:'0.0.18',sourceCommit:'a'.repeat(40),generatorCommit:'b'.repeat(40),privateDescriptorSha256:'c'.repeat(64),publicDescriptorSha256:sha(descriptor),freeCandidateArtifactId:'123',upstreamRunId:'456',correlationId:'456-1-cli-pin',binding:null};
  const artifact = {id:123,expired:false,workflow_run:{id:456,head_sha:'b'.repeat(40)}};
  const result = verifyPinCandidate({event,artifact,candidateDir:root});
  expect(JSON.parse(result.catalogText).icons[0].id).toBe('ui-search');
  expect(result.catalogSha256).toBe(sha(result.catalogText));
  expect(() => verifyPinCandidate({event,artifact:{...artifact,expired:true},candidateDir:root})).toThrow(/expiry/);
  expect(() => verifyPinCandidate({event,artifact:{...artifact,workflow_run:{id:457,head_sha:'b'.repeat(40)}},candidateDir:root})).toThrow(/run mismatch/);
  expect(() => verifyPinCandidate({event,artifact:{...artifact,workflow_run:{id:456,head_sha:'e'.repeat(40)}},candidateDir:root})).toThrow(/commit mismatch/);
  writeFileSync(join(root, filename), 'corrupted');
  expect(() => verifyPinCandidate({event,artifact,candidateDir:root})).toThrow(/archive digest/);
 } finally {rmSync(root,{recursive:true,force:true});}
});
