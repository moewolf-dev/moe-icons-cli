import {describe,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runLoginUseCase,runSessionStatusUseCase,runLogoutUseCase,runAccessTokenUseCase} from '../src/core/auth.js';
import {boundedResponse} from '../src/auth/transport.js';
import {createFileTokenStore} from '../src/auth/token-store.js';
import type {CommandContext} from '../src/core/context.js';
const context=(env:Record<string,string>):CommandContext=>({env,cwd:'.',signal:new AbortController().signal,now:()=>new Date(),ui:{confirm:async()=>true} as never});
describe('default authentication lifecycle',()=>{
 it('coordinates separate stores sharing one file and keeps concurrent status checks authenticated',async()=>{
  const root=mkdtempSync(join(tmpdir(),'moe-refresh-concurrent-'));
  try{
   const first=createFileTokenStore({rootDir:root}),second=createFileTokenStore({rootDir:root});
   first.set({accountId:'fixture',accessToken:'old',refreshToken:'fixture',expiresAt:0,scope:'openid',storedAt:1});
   const request=vi.fn(async()=>{await new Promise(resolve=>setTimeout(resolve,75));return Response.json({access_token:'new',refresh_token:'rotated',expires_in:3600});});
   const states=await Promise.all([runSessionStatusUseCase(context({}),{tokenStore:first,fetch:request}),runSessionStatusUseCase(context({}),{tokenStore:second,fetch:request})]);
   expect(states.map(state=>state.kind)).toEqual(['authenticated','authenticated']);expect(request).toHaveBeenCalledTimes(1);
   expect(second.getActive()?.refreshToken).toBe('rotated');
  }finally{rmSync(root,{recursive:true,force:true});}
 });
 it('cancels a waiting refresh without aborting the owner or leaving a lock',async()=>{
  const root=mkdtempSync(join(tmpdir(),'moe-refresh-cancel-'));
  try{
   const store=createFileTokenStore({rootDir:root});store.set({accountId:'fixture',accessToken:'old',refreshToken:'fixture',expiresAt:0,scope:'openid',storedAt:1});
   let respond!:(value:Response)=>void;const response=new Promise<Response>(resolve=>{respond=resolve;});
   const request=vi.fn(async()=>response),owner=runAccessTokenUseCase(context({}),{tokenStore:store,fetch:request});
   const controller=new AbortController();const waiting=runAccessTokenUseCase({...context({}),signal:controller.signal},{tokenStore:createFileTokenStore({rootDir:root}),fetch:request});
   controller.abort();await expect(waiting).rejects.toThrow(/cancelled/);
   respond(Response.json({access_token:'new',expires_in:3600}));expect(await owner).toBe('new');expect(request).toHaveBeenCalledTimes(1);
   expect(readFileSync(join(root,'token-store.json'),'utf8')).toContain('new');
   await expect(store.withRefreshLock!(async()=>true)).resolves.toBe(true);
  }finally{rmSync(root,{recursive:true,force:true});}
 });
 it('keeps a dangling storage preference unknown instead of selecting another backend',async()=>{
  const root=mkdtempSync(join(tmpdir(),'moe-preference-invalid-'));
  try{symlinkSync(join(root,'absent'),join(root,'session-store.json'));expect(await runSessionStatusUseCase(context({MOEICONS_STATE_DIR:root,MOEICONS_DISABLE_SYSTEM_KEYCHAIN:'1'}))).toMatchObject({kind:'unknown'});}
  finally{rmSync(root,{recursive:true,force:true});}
 });
 it('remembers approved default file storage across new contexts and clears it on logout',async()=>{
  const root=mkdtempSync(join(tmpdir(),'moe-session-lifecycle-'));
  try {
   const env={MOEICONS_STATE_DIR:root,MOEICONS_DISABLE_SYSTEM_KEYCHAIN:'1'};
   const request=vi.fn().mockResolvedValueOnce({status:201,data:{loginId:'fixture',pollingToken:'fixture',browserUrl:'https://moeicons.com/cli-login',intervalSeconds:1,expiresAt:new Date(Date.now()+60000).toISOString()}}).mockResolvedValueOnce({status:200,data:{status:'complete',exchangeCode:'fixture'}}).mockResolvedValueOnce({status:200,data:{accountId:'fixture',accessToken:'fixture-only',refreshToken:'fixture-only',expiresIn:3600,tokenType:'Bearer'}});
   await runLoginUseCase(context(env),{request,openBrowser:async()=>{}});
   expect(await runSessionStatusUseCase(context(env))).toMatchObject({kind:'authenticated'});
   expect(readFileSync(join(root,'session-store.json'),'utf8')).not.toContain('fixture-only');
   await runLogoutUseCase(context(env),{fetch:async()=>new Response(null,{status:200})});
   expect(await runSessionStatusUseCase(context(env))).toEqual({kind:'signed-out'});
  }finally{rmSync(root,{recursive:true,force:true});}
 });
 it('refreshes with shipped public config and does not restore a session after concurrent logout',async()=>{
  const root=mkdtempSync(join(tmpdir(),'moe-refresh-'));
  try{
   const store=createFileTokenStore({rootDir:root});const session={accountId:'fixture',accessToken:'old',refreshToken:'fixture',expiresAt:0,scope:'openid',storedAt:1};store.set(session);
   const request=vi.fn(async(url:unknown)=>{expect(String(url)).toBe('https://login.moewolf.com/oauth/token');return Response.json({access_token:'new',expires_in:60});});
   expect(await runAccessTokenUseCase(context({}),{tokenStore:store,fetch:request})).toBe('new');
   store.set(session);
   await expect(runAccessTokenUseCase(context({}),{tokenStore:store,fetch:async()=>{store.clear();return Response.json({access_token:'late'});}})).rejects.toThrow(/session changed/);
   expect(store.getActive()).toBeUndefined();
  }finally{rmSync(root,{recursive:true,force:true});}
 });
 it('bounds an endless body even when a transport fixture ignores abort',async()=>{
  await expect(boundedResponse(async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));}})),'https://fixture.invalid',{},25)).rejects.toThrow(/timed out/);
 });
 it('rejects an already cancelled request and oversized response',async()=>{
  const controller=new AbortController();controller.abort();const fetchMock=vi.fn();
  await expect(boundedResponse(fetchMock,'https://fixture.invalid',{signal:controller.signal})).rejects.toThrow(/cancelled/);expect(fetchMock).not.toHaveBeenCalled();
  await expect(boundedResponse(async()=>new Response('x'.repeat(64001)),'https://fixture.invalid',{})).rejects.toThrow(/size limit/);
 });
});
