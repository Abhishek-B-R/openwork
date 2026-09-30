import { createServer } from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { z } from "zod"
const rpcSchema=z.object({jsonrpc:z.literal("2.0"),id:z.union([z.string(),z.number()]).optional(),method:z.string(),params:z.unknown().optional()})
const callSchema=z.object({name:z.string(),arguments:z.record(z.string(),z.unknown()).optional()})
const safeMethods=new Set(["initialize","ping","notifications/initialized","tools/list","resources/list","resources/read","prompts/list"])
const safeTools=new Set(["search_capabilities","list_skills","get_skill"])
/** Credentials with execute scope never reach the engine. Admin-approved reads are the only forwarding path. */
export async function createReadMcpProxy(options:{url:string;token:string;readCapabilities:string[];authorize:()=>Promise<void>;activity?:(text:string)=>Promise<void>}) {
  const token=randomBytes(32).toString("base64url")
  const active=new Set<AbortController>()
  const server=createServer(async(req,res)=>{
    const given=Buffer.from(req.headers.authorization ?? ""),expected=Buffer.from(`Bearer ${token}`)
    if(given.length!==expected.length || !timingSafeEqual(given,expected)) {res.writeHead(401).end();return}
    if(req.method!=="POST") {res.writeHead(405).end();return}
    let rpc:z.infer<typeof rpcSchema> | undefined
    try {
      let body=""
      for await(const chunk of req) {body+=String(chunk);if(Buffer.byteLength(body)>100000) throw new Error("Request too large")}
      rpc=rpcSchema.parse(JSON.parse(body))
      await options.authorize()
      if(rpc.method==="tools/call") {
        const call=callSchema.parse(rpc.params)
        if(call.name==="execute_capability") {
          const name=call.arguments?.name
          if(typeof name!=="string" || !options.readCapabilities.includes(name)) throw new Error("This action has not been approved for headless reads by a platform admin.")
        } else if(!safeTools.has(call.name)) throw new Error("This action is blocked for headless work.")
      } else if(!safeMethods.has(rpc.method)) throw new Error("This operation is blocked for headless work.")
      const controller=new AbortController();active.add(controller)
      try {
        const response=await fetch(options.url,{method:"POST",headers:{authorization:`Bearer ${options.token}`,"content-type":"application/json",accept:"application/json, text/event-stream",...(req.headers["mcp-protocol-version"]?{"mcp-protocol-version":String(req.headers["mcp-protocol-version"])}:{})},body:JSON.stringify(rpc),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)]),redirect:"error"})
        let text=await response.text()
        let contentType=response.headers.get("content-type") ?? "application/json"
        if(text.length>2000000) throw new Error("The connected tool returned too much data.")
        await options.authorize()
        if(rpc.method==="tools/list" && response.ok) {
          // Hide blocked mutation/send tools as well as rejecting their calls.
          const lines=contentType.includes("text/event-stream")?text.split("\n").filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trim()):[text]
          let payload:unknown
          for(const line of lines) {try{payload=JSON.parse(line)}catch{}}
          if(typeof payload!=="object" || payload===null || !("result" in payload) || typeof payload.result!=="object" || payload.result===null || !("tools" in payload.result) || !Array.isArray(payload.result.tools)) throw new Error("The team tool catalog could not be verified.")
          const tools=payload.result.tools.filter((tool:unknown)=>typeof tool==="object" && tool!==null && "name" in tool && typeof tool.name==="string" && (safeTools.has(tool.name)||tool.name==="execute_capability"))
          text=JSON.stringify({...payload,result:{...payload.result,tools}});contentType="application/json"
        }
        if(rpc.method==="tools/call") await options.activity?.("Checked a team tool")
        res.writeHead(response.status,{"content-type":contentType}).end(text)
      } finally {active.delete(controller)}
    } catch(error) {
      res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:rpc?.id ?? null,error:{code:-32602,message:error instanceof Error?error.message:"Assistant access is blocked"}}))
    }
  })
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve))
  const address=server.address()
  if(!address || typeof address==="string") throw new Error("Connection proxy failed to start")
  return {url:`http://127.0.0.1:${address.port}/mcp`,token,close:()=>{for(const controller of active) controller.abort();server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()))}}
}
