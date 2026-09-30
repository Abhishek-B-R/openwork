import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises"
import { createServer } from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { z } from "zod"

const fileInput=z.object({path:z.string().min(1).max(500),text:z.string().max(100000).optional()}).strict()
const rpcSchema=z.object({jsonrpc:z.literal("2.0"),id:z.union([z.string(),z.number()]).optional(),method:z.string(),params:z.unknown().optional()})
const callSchema=z.object({name:z.string(),arguments:z.unknown().optional()})
const maxFileBytes=100000
export class ActorFiles {
  constructor(readonly root:string) {}
  private async path(name:string, createParents=false) {
    if (isAbsolute(name) || name.includes("\\") || name.split("/").some(piece=>!piece || piece==="." || piece===".." || piece.startsWith("."))) throw new Error("Use a file path inside your files folder.")
    const canonical=await realpath(this.root)
    const target=resolve(canonical,name)
    if (!target.startsWith(canonical+sep)) throw new Error("This file is outside your files folder.")
    const pieces=relative(canonical,target).split(sep)
    let current=canonical
    for (const [index,piece] of pieces.entries()) {
      current=join(current,piece)
      try {
        const stat=await lstat(current)
        if (stat.isSymbolicLink()) throw new Error("Linked paths are blocked.")
        if (index<pieces.length-1 && !stat.isDirectory()) throw new Error("This path is not a folder.")
      } catch(error) {
        if (!(error instanceof Error && "code" in error && error.code==="ENOENT")) throw error
        if (index<pieces.length-1) {
          if (!createParents) throw new Error("This folder does not exist.")
          await mkdir(current,{mode:0o700})
        }
      }
    }
    return target
  }
  async read(name:string) {
    const target=await this.path(name)
    const file=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW)
    try {
      const stat=await file.stat()
      if (!stat.isFile() || stat.size>maxFileBytes) throw new Error("Choose a text file smaller than 100 KB.")
      return await file.readFile("utf8")
    } finally {await file.close()}
  }
  async write(name:string,text:string) {
    if (Buffer.byteLength(text)>maxFileBytes) throw new Error("Keep files smaller than 100 KB.")
    const target=await this.path(name,true)
    const file=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW,0o600)
    try {
      if (!(await file.stat()).isFile()) throw new Error("Choose a regular text file.")
      await file.truncate(0); await file.writeFile(text,"utf8"); await file.sync()
    } finally {await file.close()}
    return `Saved ${name}`
  }
  async list() {
    const entries: string[]=[]
    const walk=async(directory:string,depth:number)=>{
      if (depth>5 || entries.length>=200) return
      for (const entry of await readdir(directory,{withFileTypes:true})) {
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue
        const path=join(directory,entry.name)
        if (entry.isDirectory()) await walk(path,depth+1)
        else if (entry.isFile()) entries.push(relative(this.root,path))
        if (entries.length>=200) break
      }
    }
    await walk(this.root,0)
    return entries.sort()
  }
}
/** A sessionless Streamable HTTP MCP endpoint; the token is private to this run. */
export async function createFileMcp(root:string, authorize:()=>Promise<void>, activity:(text:string)=>Promise<void>) {
  const files=new ActorFiles(root)
  const token=randomBytes(32).toString("base64url")
  const tools=[
    {name:"read_file",description:"Read a text file in the member's persistent files folder.",inputSchema:{type:"object",properties:{path:{type:"string"}},required:["path"],additionalProperties:false}},
    {name:"write_file",description:"Save a text file in the member's persistent files folder. Cannot write outside this folder.",inputSchema:{type:"object",properties:{path:{type:"string"},text:{type:"string"}},required:["path","text"],additionalProperties:false}},
    {name:"list_files",description:"List the member's persistent files.",inputSchema:{type:"object",properties:{},additionalProperties:false}},
  ]
  const server=createServer(async(req,res)=>{
    const given=Buffer.from(req.headers.authorization ?? "")
    const expected=Buffer.from(`Bearer ${token}`)
    if (given.length!==expected.length || !timingSafeEqual(given,expected)) {res.writeHead(401).end();return}
    if (req.method!=="POST") {res.writeHead(405).end();return}
    try {
      let body=""
      for await(const chunk of req) {body+=String(chunk);if(Buffer.byteLength(body)>150000) throw new Error("Request too large")}
      const rpc=rpcSchema.parse(JSON.parse(body))
      await authorize()
      if(rpc.id===undefined) {res.writeHead(202).end();return}
      let result:unknown
      if(rpc.method==="initialize") result={protocolVersion:"2025-03-26",capabilities:{tools:{}},serverInfo:{name:"workbot-files",version:"1.0.0"}}
      else if(rpc.method==="ping") result={}
      else if(rpc.method==="tools/list") result={tools}
      else if(rpc.method==="tools/call") {
        const call=callSchema.parse(rpc.params)
        try {
          let text:string
          if(call.name==="list_files") {text=JSON.stringify(await files.list());await activity("Listed your files")}
          else {
            const args=fileInput.parse(call.arguments)
            if(call.name==="read_file") {text=await files.read(args.path);await activity(`Read ${args.path}`)}
            else if(call.name==="write_file" && args.text!==undefined) {text=await files.write(args.path,args.text);await activity(`Saved ${args.path}`)}
            else throw new Error("This file action is unavailable.")
          }
          result={content:[{type:"text",text}]}
        } catch(error) {result={isError:true,content:[{type:"text",text:error instanceof Error?error.message:"File action failed"}]}}
      } else {res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:rpc.id,error:{code:-32601,message:"Method unavailable"}}));return}
      res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({jsonrpc:"2.0",id:rpc.id,result}))
    } catch {res.writeHead(403).end()}
  })
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve))
  const address=server.address()
  if (!address || typeof address==="string") throw new Error("File service failed to start")
  return {url:`http://127.0.0.1:${address.port}/mcp`,token,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))}
}
