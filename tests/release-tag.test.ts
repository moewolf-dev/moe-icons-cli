import {describe,it,expect} from "vitest";
import {ensureReleaseTag} from "../scripts/ensure-release-tag.mjs";
const commit="a".repeat(40),good={ref:"refs/tags/v0.0.3",object:{type:"commit",sha:commit}};
const args={tag:"v0.0.3",commit,token:"test-secret"};
function fake(items: Array<[number,unknown]>) {const calls:Array<{url:string,options:RequestInit}>=[];return {calls,fetchImpl:async(url:string,options:RequestInit)=>{calls.push({url,options});const item=items.shift();if(!item)throw Error("unexpected request");return new Response(JSON.stringify(item[1]),{status:item[0]});}};}
describe("exact release tag recovery",()=>{
 it("creates only an absent tag and verifies a fresh exact readback",async()=>{const f=fake([[404,{message:"Not Found"}],[201,{}],[200,good]]);expect(await ensureReleaseTag({...args,...f})).toMatchObject({created:true,commit});expect(JSON.parse(f.calls[1]!.options.body as string)).toEqual({ref:good.ref,sha:commit});});
 it("reuses an exact existing tag without writing",async()=>{const f=fake([[200,good]]);expect(await ensureReleaseTag({...args,...f})).toMatchObject({created:false});expect(f.calls).toHaveLength(1);});
 it("never treats error JSON as a tag or swallows API failures",async()=>{for(const status of [403,500]){const f=fake([[status,{message:"Not Found"}]]);await expect(ensureReleaseTag({...args,...f})).rejects.toThrow(`HTTP ${status}`);expect(f.calls).toHaveLength(1);}});
 it("rejects drift and annotated objects without overwriting",async()=>{for(const object of [{type:"commit",sha:"b".repeat(40)},{type:"tag",sha:commit}]){const f=fake([[200,{...good,object}]]);await expect(ensureReleaseTag({...args,...f})).rejects.toThrow();expect(f.calls).toHaveLength(1);}});
 it("accepts a creation race only after exact readback",async()=>{const f=fake([[404,{}],[422,{}],[200,good]]);expect(await ensureReleaseTag({...args,...f})).toMatchObject({created:false});const bad=fake([[404,{}],[422,{}],[200,{...good,object:{type:"commit",sha:"b".repeat(40)}}]]);await expect(ensureReleaseTag({...args,...bad})).rejects.toThrow("target mismatch");});
 it("validates all locators before credential-bearing requests",async()=>{for(const override of [{repo:"foreign/repo"},{tag:"v0.0.3/other"},{commit:"bad"}]){const f=fake([]);await expect(ensureReleaseTag({...args,...f,...override})).rejects.toThrow();expect(f.calls).toHaveLength(0);}});
});
