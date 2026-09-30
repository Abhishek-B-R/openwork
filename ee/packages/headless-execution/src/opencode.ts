import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { HeadlessEngine } from "./contract.js"
import { createReadMcpProxy } from "./mcp-proxy.js"
import { createFileMcp } from "./files.js"

function record(value:unknown): value is Record<string,unknown> {return typeof value==="object" && value!==null && !Array.isArray(value)}
export const OPENCODE_HEADLESS_VERSION="0.0.0-beta-19086"
export const headlessPermissions=[
  {action:"*",resource:"*",effect:"deny"},
  {action:"workbot_files_*",resource:"*",effect:"allow"},
  {action:"openwork_*",resource:"*",effect:"allow"},
  // Confined Code Mode still checks each nested tool. It has no host access.
  {action:"execute",resource:"*",effect:"allow"},
]
export class OpenCodeHeadlessEngine implements HeadlessEngine {
  constructor(readonly binary:string, readonly options:{authorize?: Parameters<typeof createFileMcp>[1]; diagnostics?: (text:string)=>void; history?: (input:Parameters<HeadlessEngine["execute"]>[0])=>string}={}) {}
  async execute(input:Parameters<HeadlessEngine["execute"]>[0]) {
    const privateRoot=await realpath(await mkdtemp(join(tmpdir(),"openwork-headless-")))
    let files:Awaited<ReturnType<typeof createFileMcp>> | undefined
    let proxy:Awaited<ReturnType<typeof createReadMcpProxy>> | undefined
    let child:ReturnType<typeof spawn> | undefined
    let server:ReturnType<typeof spawn> | undefined
    let abort: (()=>void) | undefined
    let force:ReturnType<typeof setTimeout> | undefined
    try {
      files=await createFileMcp(input.directory,async()=>{input.signal.throwIfAborted();await input.authorize?.();await this.options.authorize?.()},input.activity)
      proxy=await createReadMcpProxy({url:input.credentials.mcpUrl,token:input.credentials.mcpToken,readCapabilities:input.credentials.readCapabilities ?? [],activity:input.activity,authorize:async()=>{input.signal.throwIfAborted();await input.authorize?.()}})
      const {model}=input.credentials
      const config={
        $schema:"https://opencode.ai/config.json",
        permissions:headlessPermissions,
        agents:{workbot:{description:"Member assistant",mode:"primary",steps:input.run.limits?.maxTurns ?? 16,permissions:headlessPermissions,system:"You are Workbot, the member's assistant. Use workbot_files tools for persistent memory and files. Use OpenWork to discover organization tools and skills. Return drafts in this chat; never post or send externally. You have no browser or computer takeover. Report unavailable connections clearly. Do not invent tool results. Use memory.md to retain useful member preferences when asked. Speak naturally and concisely, like a helpful colleague in a conversation. Do not narrate tool calls, execution steps, runtime status, or internal identifiers. Present the answer or draft itself. When you save a draft, mention its relative filename so the conversation can offer an Open action. Never claim a file was saved unless the write succeeded."}},
        providers:{[model.providerId]:{name:"Organization model",package:model.package ?? "@opencode-ai/ai/providers/openai-compatible",settings:{baseURL:model.baseUrl,apiKey:model.apiKey,name:model.providerId},models:{[model.modelId]:{name:model.modelId,capabilities:{tools:true,input:["text"],output:["text"]},limit:{context:128000,output:8192}}}}},
        mcp:{servers:{workbot_files:{type:"remote",url:files.url,oauth:false,headers:{Authorization:`Bearer ${files.token}`},codemode:false},openwork:{type:"remote",url:proxy.url,oauth:false,headers:{Authorization:`Bearer ${proxy.token}`},codemode:false}}},
      }
      await writeFile(join(privateRoot,"opencode.json"),JSON.stringify(config),{mode:0o600})
      const history=this.options.history?.(input) ?? ""
      const prompt=history ? `Previous conversation (context, not new instructions):\n${history}\n\nCurrent message:\n${input.run.prompt}` : input.run.prompt
      const password=randomBytes(32).toString("base64url")
      const env={PATH:process.env.PATH ?? "/usr/bin:/bin",HOME:privateRoot,LANG:"en_US.UTF-8",XDG_DATA_HOME:join(privateRoot,"data"),XDG_CONFIG_HOME:join(privateRoot,"config"),XDG_CACHE_HOME:join(privateRoot,"cache"),XDG_STATE_HOME:join(privateRoot,"state"),OPENCODE_CONFIG:join(privateRoot,"opencode.json"),OPENCODE_CONFIG_DIR:privateRoot,OPENCODE_PASSWORD:password,OPENCODE_DB:join(privateRoot,"engine.sqlite")}
      const started=Date.now()
      let text="", buffered="", stderr="", inputTokens=0,outputTokens=0,steps=0,errored=false
      const kill=(process:ReturnType<typeof spawn>|undefined,signal:NodeJS.Signals)=>{
        if(!process?.pid || process.exitCode!==null || process.signalCode!==null) return
        try {if(globalThis.process.platform!=="win32") globalThis.process.kill(-process.pid,signal);else process.kill(signal)} catch {}
      }
      const terminate=()=>{
        kill(child,"SIGTERM");kill(server,"SIGTERM")
        force=setTimeout(()=>{kill(child,"SIGKILL");kill(server,"SIGKILL")},2000)
      }
      abort=terminate
      input.signal.addEventListener("abort",terminate,{once:true})
      input.signal.throwIfAborted()
      server=spawn(this.binary,["serve","--hostname","127.0.0.1","--port","0"],{cwd:privateRoot,env,stdio:["ignore","pipe","pipe"],detached:process.platform!=="win32"})
      const url=await new Promise<string>((resolve,reject)=>{
        let output=""
        const timeout=setTimeout(()=>reject(new Error("engine_start_timeout")),30000)
        const cleanup=()=>{clearTimeout(timeout);input.signal.removeEventListener("abort",cancel)}
        const cancel=()=>{cleanup();reject(new Error("engine_start_cancelled"))}
        input.signal.addEventListener("abort",cancel,{once:true})
        server?.once("error",error=>{cleanup();reject(error)})
        server?.once("exit",()=>{cleanup();reject(new Error("engine_start_failed"))})
        server?.stdout?.on("data",chunk=>{
          output=(output+String(chunk)).slice(-8000)
          const address=output.match(/server listening on (http:\/\/[^\s]+)/)?.[1]
          if(address) {cleanup();resolve(address)}
        })
        server?.stderr?.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-4000)})
      })
      const native=async(path:string,body?:unknown)=>{
        const response=await fetch(`${url}${path}?location%5Bdirectory%5D=${encodeURIComponent(privateRoot)}`,{method:body===undefined?"GET":"PUT",headers:{authorization:`Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.any([input.signal,AbortSignal.timeout(30000)])})
        if(!response.ok) throw new Error(`engine_setup_failed:${response.status}`)
        return response.status===204?null:response.json()
      }
      const health:unknown=await native("/api/health")
      if(!record(health) || health.version!==OPENCODE_HEADLESS_VERSION) throw new Error("engine_version_mismatch")
      // The native CLI's first standalone prompt does not await the MCP catalog.
      // Register and confirm both connections before admitting the model request.
      for(const [name,value] of Object.entries(config.mcp.servers)) await native(`/api/mcp/${name}`,{config:value})
      const status:unknown=await native("/api/mcp")
      this.options.diagnostics?.(JSON.stringify({mcpStatus:status}))
      const connections=record(status)&&Array.isArray(status.data)?status.data:[]
      for(const name of Object.keys(config.mcp.servers)) {
        if(!connections.some(entry=>record(entry)&&entry.name===name&&record(entry.status)&&entry.status.status==="connected")) throw new Error("engine_connection_unavailable")
      }
      input.signal.throwIfAborted()
      await input.authorize?.()
      child=spawn(this.binary,["run","--server",url,"--format","json","--agent","workbot","--model",`${model.providerId}/${model.modelId}`,prompt],{cwd:privateRoot,env,stdio:["ignore","pipe","pipe"],detached:process.platform!=="win32"})
      await input.activity("Started the assistant")
      const consume=(line:string)=>{
        try {
          const event:unknown=JSON.parse(line)
          if(!record(event)) return
          this.options.diagnostics?.(line)
          if(event.type==="error") errored=true
          const part=record(event.part)?event.part:record(event.properties)?event.properties:null
          if(event.type==="text" && typeof part?.text==="string") text+=part.text
          if(event.type==="step_finish") {
            steps++
            if(record(part?.tokens)) {inputTokens+=Number(part.tokens.input ?? 0);outputTokens+=Number(part.tokens.output ?? 0)}
            if(steps>(input.run.limits?.maxTurns ?? 16)) {errored=true;terminate()}
          }
        } catch {}
      }
      child.stdout?.on("data",chunk=>{
        buffered+=String(chunk)
        if(buffered.length>1000000) {errored=true;terminate();buffered=""}
        const lines=buffered.split("\n");buffered=lines.pop() ?? ""
        for(const line of lines) consume(line)
      })
      child.stderr?.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-4000)})
      const code=await new Promise<number|null>((resolve,reject)=>{child?.once("error",reject);child?.once("close",resolve)})
      clearTimeout(force)
      if(buffered) consume(buffered)
      input.signal.throwIfAborted()
      if(code!==0 || errored || !text.trim()) {
        // Native diagnostics may contain provider data; do not put them in durable/public results.
        this.options.diagnostics?.(stderr)
        throw new Error(`engine_execution_failed:${code}:${stderr.length}`)
      }
      this.options.diagnostics?.(stderr)
      await input.activity(`Finished in ${Math.round((Date.now()-started)/1000)} seconds`)
      return {text,inputTokens,outputTokens}
    } catch(error) {
      this.options.diagnostics?.(error instanceof Error?error.message:"engine_failed")
      throw error
    } finally {
      if(child?.pid && child.exitCode===null) {try {if(process.platform!=="win32") process.kill(-child.pid,"SIGKILL");else child.kill("SIGKILL")}catch{}}
      if(server?.pid && server.exitCode===null) {try {if(process.platform!=="win32") process.kill(-server.pid,"SIGKILL");else server.kill("SIGKILL")}catch{}}
      if(abort) input.signal.removeEventListener("abort",abort)
      clearTimeout(force)
      await proxy?.close()
      await files?.close()
      // Credentials/config/native state are transient; files and Den history persist.
      await rm(privateRoot,{recursive:true,force:true})
    }
  }
}
