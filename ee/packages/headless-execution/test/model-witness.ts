import { createServer } from "node:http"
/** Deterministic model boundary for protocol/UI acceptance. This is not real inference. */
export function modelWitness(port=0) {
  let requests=0
  const server=createServer(async(req,res)=>{
    let raw="";for await(const chunk of req) raw+=String(chunk)
    if(req.url==="/v1/models") {res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({data:[{id:"witness"}]}));return}
    const body=JSON.parse(raw),messages=body.messages ?? [],last=messages.at(-1),lastCall=messages.flatMap((item:{tool_calls?:Array<{id:string;function:{name:string;arguments:string}}>})=>item.tool_calls ?? []).find((call:{id:string})=>call.id===last?.tool_call_id),lastName=last?.name ?? lastCall?.function.name,prompt=messages.filter((item:{role:string})=>item.role==="user").at(-1)?.content
    requests++
    const tools=(body.tools ?? []).map((item:{function:{name:string}})=>item.function.name)
    console.log(JSON.stringify({request:requests,witnessToolNames:tools,lastRole:last?.role,lastTool:lastName}))
    let tool:string|undefined,args:unknown={},text=""
    if(last?.role!=="tool") {tool=tools.find((name:string)=>name==="workbot_files_write_file");args={path:"memory.md",text:"Keep notes short."}}
    else if(lastName==="workbot_files_write_file") {tool=tools.find((name:string)=>name==="workbot_files_read_file");args={path:"memory.md"}}
    else if(lastName==="workbot_files_read_file" && lastCall?.function.arguments?.includes("memory.md")) {
      tool=tools.find((name:string)=>name==="openwork_search_capabilities") ?? tools.find((name:string)=>name==="openwork_execute_capability")
      args=tool==="openwork_search_capabilities"?{query:"witness read"}:{name:"mcp:witness:read"}
    } else if(lastName==="openwork_search_capabilities") {
      const content=typeof last.content==="string"?last.content:JSON.stringify(last.content)
      const match=content.match(/mcp:emc_[a-z0-9]+:read_witness/)
      if(match) {tool="openwork_execute_capability";args={name:match[0],body:{}}}
      else text="Saved and read memory.md. No connected read witness was returned."
    } else if(lastName==="openwork_execute_capability") {tool="workbot_files_read_file";args={path:"../other-member-note.md"}}
    else if(lastName==="workbot_files_read_file" && lastCall?.function.arguments?.includes("../")) {tool="workbot_files_read_file";args={path:"linked.md"}}
    else {
      const content=typeof prompt==="string"?prompt:JSON.stringify(prompt)
      text=content?.startsWith("Read my connected calendar")?JSON.stringify({events:[],blockedReason:"No live calendar is connected in this local prototype."}):"Saved and read memory.md. Read the connected witness. This is a deterministic model witness result."
    }
    if(!tool&&!text)text="Saved and read memory.md. This is a deterministic model witness result."
    const chunk={id:`chatcmpl-${requests}`,object:"chat.completion.chunk",created:Math.floor(Date.now()/1000),model:"witness",choices:[{index:0,delta:tool?{role:"assistant",tool_calls:[{index:0,id:`call-${requests}`,type:"function",function:{name:tool,arguments:JSON.stringify(args)}}]}:{role:"assistant",content:text},finish_reason:null}]}
    const finish={...chunk,choices:[{index:0,delta:{},finish_reason:tool?"tool_calls":"stop"}],usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20}}
    res.writeHead(200,{"content-type":"text/event-stream"});res.write(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`);res.end()
  })
  return {server,get requests(){return requests},start:()=>new Promise<number>(resolve=>server.listen(port,"127.0.0.1",()=>{const address=server.address();if(address&&typeof address!=="string")resolve(address.port)}))}
}
