import { modelWitness } from "./model-witness.js"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { HeadlessService, HeadlessStore, HeadlessWorker, OpenCodeHeadlessEngine, type HeadlessAuthority } from "../src/index.js"

// This uses a genuine model and native engine. Only the external MCP boundary is a synthetic witness.
const model=process.env.HEADLESS_TEST_MODEL_WITNESS==="1"?modelWitness():null
const modelPort=model?await model.start():null
const apiKey=model?"synthetic":process.env.HEADLESS_TEST_LOCAL_MODEL==="1"?"local":process.env.HEADLESS_TEST_PUBLIC_ZEN==="1"?"public-free-model":process.env.OPENAI_API_KEY
if(!apiKey) throw new Error("Set OPENAI_API_KEY using the normal local credential flow; never put a key in fixtures.")
const root=await mkdtemp(join(tmpdir(),"headless-engine-witness-"))
let reads=0
const gateway=createServer(async(req,res)=>{
  let body="";for await(const chunk of req) body+=String(chunk)
  const message=JSON.parse(body)
  const answer=(result:unknown)=>res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:message.id,result}))
  if(message.id===undefined) {res.writeHead(202).end();return}
  if(message.method==="initialize") answer({protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"MCP witness",version:"1"}})
  else if(message.method==="tools/list") answer({tools:[{name:"execute_capability",description:"Run an approved read action.",inputSchema:{type:"object",properties:{name:{type:"string"}},required:["name"]}}]})
  else if(message.method==="tools/call" && message.params?.name==="execute_capability") {reads++;answer({content:[{type:"text",text:"Witness result: weekly planning is ready."}]})}
  else answer({})
})
await new Promise<void>(resolve=>gateway.listen(0,"127.0.0.1",resolve))
const address=gateway.address();assert.ok(address && typeof address!=="string")
const authority:HeadlessAuthority={authorize:async()=>{},credentials:async()=>({mcpUrl:`http://127.0.0.1:${address.port}`,mcpToken:"synthetic-witness",readCapabilities:["mcp:witness:read"],model:{providerId:"prototype",modelId:model?"witness":process.env.HEADLESS_TEST_MODEL ?? "gpt-4.1-mini",baseUrl:modelPort?`http://127.0.0.1:${modelPort}/v1`:process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",apiKey}})}
const store=new HeadlessStore(root),service=new HeadlessService(store,authority)
const diagnostics:string[]=[]
const engine=new OpenCodeHeadlessEngine(process.env.DEN_HEADLESS_OPENCODE_BIN ?? "opencode2",{diagnostics:text=>diagnostics.push(text)})
const worker=new HeadlessWorker(service,engine)
const actor={organizationId:"prototype-org",memberId:"prototype-member"}
const directory=store.directory(actor)
await writeFile(join(root,"other-member-note.md"),"Must stay private")
await symlink(join(root,"other-member-note.md"),join(directory,"linked.md"))
try {
  const started=Date.now()
  const run=await service.submit(actor,{surface:"workbot",conversationKey:"main",idempotencyKey:"engine-witness",prompt:'Use workbot_files_write_file to save "Keep notes short." in memory.md, then read it with workbot_files_read_file. Use openwork_execute_capability with name mcp:witness:read. Also try reading ../other-member-note.md and linked.md using workbot_files_read_file; these must be blocked. Do not use other tools. Finally reply with a short summary of the read and what was blocked.',limits:{timeoutMs:120000,maxTurns:12}})
  await worker.once()
  const result=await service.read(actor,run.id)
  if(result?.status!=="succeeded") {await writeFile(join(tmpdir(),"headless-engine-diagnostics.txt"),diagnostics.join("\n"));throw new Error(`Native engine failed: ${result?.failure?.code}; synthetic diagnostics are in /private/tmp/headless-engine-diagnostics.txt`)}
  await writeFile(join(tmpdir(),"headless-engine-diagnostics.txt"),diagnostics.join("\n"))
  assert.equal(await readFile(join(directory,"memory.md"),"utf8"),"Keep notes short.")
  assert.ok(reads>0)
  assert.ok(result.result)
  const events=await service.events(actor,run.id)
  assert.ok(events.some(event=>event.text==="Saved memory.md"))
  const measurement={engine:"OpenCode v2",model:model?"deterministic HTTP model witness":"genuine inference",mcp:"synthetic read witness",durationMs:Date.now()-started,usage:result.usage,mcpReads:reads,persistentFiles:true,output:result.result}
  await writeFile(join(tmpdir(),"headless-engine-measurement.json"),JSON.stringify(measurement,null,2))
  console.log(JSON.stringify(measurement))
} finally {
  worker.stop();store.close();if(model)await new Promise<void>(resolve=>model.server.close(()=>resolve()));await new Promise<void>(resolve=>gateway.close(()=>resolve()));await rm(root,{recursive:true,force:true})
}
