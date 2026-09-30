import { HeadlessWorker, OpenCodeHeadlessEngine } from "@openwork-ee/headless-execution"
import { headlessService } from "./runtime.js"
const service=headlessService()
const engine=new OpenCodeHeadlessEngine(process.env.DEN_HEADLESS_OPENCODE_BIN ?? "opencode2",{history:input=>service.store.conversation(input.actor,input.run.surface,input.run.conversationKey).filter(run=>run.id!==input.run.id && run.status==="succeeded").slice(-12).map(run=>`Member: ${run.prompt}\nAssistant: ${run.result}`).join("\n").slice(-24000)})
const worker=new HeadlessWorker(service,engine)
let stopped=false
for(const signal of ["SIGINT","SIGTERM"] satisfies NodeJS.Signals[]) process.on(signal,()=>{stopped=true;worker.stop()})
console.info("Headless worker ready")
while(!stopped) {const worked=await worker.once();if(!worked) await new Promise(resolve=>setTimeout(resolve,1000))}
service.store.close()
