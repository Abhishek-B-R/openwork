import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ActorFiles, HeadlessError, HeadlessService, HeadlessStore, HeadlessWorker, createReadMcpProxy, type HeadlessAuthority, type HeadlessEngine } from "../src/index.js"
const actor={organizationId:"organization-a",memberId:"member-a"}
const input={surface:"workbot",conversationKey:"main",idempotencyKey:"one",prompt:"Write a note"} satisfies Parameters<HeadlessService["submit"]>[1]
const credentials={mcpUrl:"http://127.0.0.1:1",mcpToken:"test",model:{providerId:"test",modelId:"test",baseUrl:"http://127.0.0.1:1",apiKey:"test"}}
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),"headless-test-"))
  let enabled=true
  const authority:HeadlessAuthority={authorize:async()=>{if(!enabled)throw new HeadlessError("headless_disabled","Blocked by your team")},credentials:async()=>credentials}
  const store=new HeadlessStore(root),service=new HeadlessService(store,authority)
  return {root,store,service,disable:()=>{enabled=false},close:async()=>{store.close();await rm(root,{recursive:true,force:true})}}
}
test("durable queue, actor isolation, idempotency and restart",async()=>{
  const f=await fixture()
  try {
    const run=await f.service.submit(actor,input)
    assert.equal((await f.service.submit(actor,input)).id,run.id)
    await assert.rejects(()=>f.service.submit(actor,{...input,prompt:"Different"}),{code:"idempotency_conflict"})
    assert.equal(await f.service.read({...actor,memberId:"member-b"},run.id),null)
    assert.equal(await f.service.read({...actor,organizationId:"organization-b"},run.id),null)
    const files=new ActorFiles(f.store.directory(actor));await files.write("memory.md","Keep notes short")
    const other=new HeadlessStore(f.root)
    assert.equal(other.get(run.id)?.status,"queued")
    assert.equal(await new ActorFiles(other.directory(actor)).read("memory.md"),"Keep notes short")
    assert.equal(other.claim("worker-a",Date.now(),15000)?.id,run.id)
    assert.equal(f.store.claim("worker-b",Date.now(),15000),null)
    other.close()
  } finally {await f.close()}
})
test("scheduled/manual runs, edit, pause and resume share durable history",async()=>{
  const f=await fixture()
  try {
    const schedule=await f.service.createSchedule(actor,{title:"Brief",prompt:"Write draft",surface:"workbot",conversationKey:"main",intervalMinutes:60,nextRunAt:new Date(Date.now()-1000).toISOString()})
    await f.service.updateSchedule(actor,schedule.id,{title:"Daily brief",paused:true})
    await f.service.tickSchedules();assert.equal((await f.service.conversation(actor,"workbot","main")).length,0)
    await f.service.updateSchedule(actor,schedule.id,{paused:false})
    await f.service.tickSchedules();await f.service.tickSchedules()
    assert.equal((await f.service.conversation(actor,"workbot","main")).length,1)
    const manual=await f.service.runNow(actor,schedule.id,"manual")
    assert.equal(manual.scheduleId,schedule.id)
    const worker=new HeadlessWorker(f.service,{execute:async()=>({text:"Draft ready",inputTokens:3,outputTokens:2})})
    await worker.once();await worker.once()
    assert.equal((await f.service.read(actor,manual.id))?.result,"Draft ready")
    assert.ok((await f.service.events(actor,manual.id)).some(event=>event.kind==="result"))
  } finally {await f.close()}
})
test("cancellation and flag disable interrupt real worker control without publishing a result",async()=>{
  for(const mode of ["cancel","disable"]) {
    const f=await fixture()
    try {
      let started:()=>void=()=>{}
      const ready=new Promise<void>(resolve=>{started=resolve})
      const engine:HeadlessEngine={execute:async input=>{started();await new Promise((_,reject)=>input.signal.addEventListener("abort",()=>reject(input.signal.reason),{once:true}));return {text:"Must never publish",inputTokens:0,outputTokens:0}}}
      const run=await f.service.submit(actor,input),worker=new HeadlessWorker(f.service,engine)
      const work=worker.once();await ready
      if(mode==="cancel") await f.service.cancel(actor,run.id);else f.disable()
      await work
      assert.equal(f.store.get(run.id)?.result,null)
      assert.equal(f.store.get(run.id)?.status,mode==="cancel"?"cancelled":"blocked")
      if(mode==="disable") await assert.rejects(()=>f.service.submit(actor,{...input,idempotencyKey:"disabled"}),{code:"headless_disabled"})
    } finally {await f.close()}
  }
})
test("expired lease records uncertain failure and never replays work",async()=>{
  const f=await fixture()
  try {
    const run=await f.service.submit(actor,input)
    f.store.claim("dead-worker",Date.now()-20000,1000)
    assert.equal(f.store.claim("new-worker",Date.now(),1000),null)
    assert.equal(f.store.get(run.id)?.failure?.code,"worker_interrupted")
  } finally {await f.close()}
})
test("file tools reject path traversal, symlink parents and symlink targets",async()=>{
  const f=await fixture()
  try {
    const directory=f.store.directory(actor),files=new ActorFiles(directory)
    await files.write("notes/note.md","safe")
    await assert.rejects(()=>files.read("../jobs.sqlite"))
    await assert.rejects(()=>files.write("/tmp/outside.txt","blocked"))
    await symlink(f.root,join(directory,"linked"))
    await symlink(join(f.root,"jobs.sqlite"),join(directory,"link.txt"))
    await assert.rejects(()=>files.read("linked/jobs.sqlite"),/Linked paths/)
    await assert.rejects(()=>files.write("linked/escape.txt","blocked"),/Linked paths/)
    await assert.rejects(()=>files.read("link.txt"),/Linked paths/)
    assert.deepEqual(await files.list(),["notes/note.md"])
  } finally {await f.close()}
})
test("MCP proxy rejects sends, scripts, unapproved and revoked actions before forwarding",async()=>{
  let count=0,enabled=true
  const {createServer}=await import("node:http")
  const upstream=createServer((_req,res)=>{count++;res.writeHead(200,{"content-type":"application/json"}).end('{"jsonrpc":"2.0","id":1,"result":{}}')})
  await new Promise<void>(resolve=>upstream.listen(0,"127.0.0.1",resolve))
  const address=upstream.address();assert.ok(address && typeof address!=="string")
  const proxy=await createReadMcpProxy({url:`http://127.0.0.1:${address.port}`,token:"private",readCapabilities:["mcp:witness:read"],authorize:async()=>{if(!enabled)throw new Error("revoked")}})
  try {
    const call=async(name:string,args={})=>fetch(proxy.url,{method:"POST",headers:{authorization:`Bearer ${proxy.token}`,"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})}).then(res=>res.json())
    await call("execute_capability",{name:"mcp:witness:send"});await call("execute_capability_script");await call("create_skill");assert.equal(count,0)
    await call("execute_capability",{name:"mcp:witness:read"});assert.equal(count,1)
    enabled=false;await call("execute_capability",{name:"mcp:witness:read"});assert.equal(count,1)
  } finally {await proxy.close();await new Promise<void>(resolve=>upstream.close(()=>resolve()))}
})

test("lease fencing rejects stale tools and late results immediately",async()=>{
  const f=await fixture()
  try {
    let rejected=false
    const engine:HeadlessEngine={execute:async input=>{
      // Simulate replacement/expiry between heartbeat ticks.
      f.store.database.prepare("UPDATE runs SET lease_owner='replacement' WHERE id=?").run(input.run.id)
      await assert.rejects(()=>input.authorize?.() ?? Promise.resolve(),{code:"lease_lost"});rejected=true
      await assert.rejects(()=>input.activity("Must not persist"))
      return {text:"Must not publish",inputTokens:0,outputTokens:0}
    }}
    const run=await f.service.submit(actor,input),worker=new HeadlessWorker(f.service,engine)
    await worker.once()
    assert.equal(rejected,true)
    assert.equal(f.store.get(run.id)?.result,null)
    assert.ok(!(await f.service.events(actor,run.id)).some(event=>event.text==="Must not persist"))
  } finally {await f.close()}
})
