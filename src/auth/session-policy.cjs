// Canonical CLI/extension session-store selection. Contains no credentials.
const {homedir} = require('node:os');
const {join, isAbsolute} = require('node:path');
const {existsSync, lstatSync, readFileSync, mkdirSync, writeFileSync, renameSync} = require('node:fs');
function stateRoot(env) { const root=env.MOEICONS_STATE_DIR || join(homedir(), '.moeicons'); if(!isAbsolute(root)) throw new Error('MOEICONS_STATE_DIR must be absolute'); return root; }
function selectedStore(env) {
  if (env.MOEICONS_DISABLE_SYSTEM_KEYCHAIN === '1' && env.MOEICONS_TOKEN_STORE_DIR) { if(!isAbsolute(env.MOEICONS_TOKEN_STORE_DIR)) throw new Error('MOEICONS_TOKEN_STORE_DIR must be absolute'); return {mode:'file', rootDir:env.MOEICONS_TOKEN_STORE_DIR}; }
  const path = join(stateRoot(env), 'session-store.json');
  if (!existsSync(path)) return {mode:env.MOEICONS_DISABLE_SYSTEM_KEYCHAIN === '1' ? 'none' : 'system'};
  const meta=lstatSync(path);
  if (!meta.isFile() || meta.isSymbolicLink() || meta.size>4096 || (process.platform!=='win32' && ((meta.mode & 0o077)!==0 || meta.uid!==process.getuid()))) throw new Error('Session storage preference is not readable securely');
  const value=JSON.parse(readFileSync(path,'utf8'));
  if (value.schemaVersion!==1 || value.mode!=='file' || typeof value.rootDir!=='string' || !isAbsolute(value.rootDir)) throw new Error('Invalid session storage preference');
  return {mode:'file',rootDir:value.rootDir};
}
function rememberFileStore(env, rootDir) {
  if (!isAbsolute(rootDir)) throw new Error('Session store requires an absolute directory');
  const root=stateRoot(env); mkdirSync(root,{recursive:true,mode:0o700});
  const path=join(root,'session-store.json'), temp=path+'.'+process.pid+'.tmp';
  writeFileSync(temp,JSON.stringify({schemaVersion:1,mode:'file',rootDir})+'\n',{mode:0o600,flag:'wx'}); renameSync(temp,path);
}
function missingCredential(platform,error) {
  return platform==='darwin' ? error.code===44 || error.status===44 : platform==='linux' ? (error.code===1 || error.status===1) && !String(error.stderr || '').trim() : platform==='win32' ? error.code===44 || error.status===44 || /0x80070490|Element not found/i.test(String(error.stderr || '')) : false;
}
module.exports={selectedStore,rememberFileStore,stateRoot,missingCredential};
