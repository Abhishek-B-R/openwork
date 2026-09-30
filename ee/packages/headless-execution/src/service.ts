import { randomUUID } from "node:crypto"
import type { HeadlessActor, HeadlessAuthority, HeadlessEngine, HeadlessExecution, HeadlessRunInput, HeadlessSurface } from "./contract.js"
import { actorSchema, runInputSchema, scheduleInputSchema, HeadlessError } from "./schema.js"
import { HeadlessStore, newRun } from "./store.js"

export class HeadlessService implements HeadlessExecution {
  constructor(readonly store: HeadlessStore, readonly authority: HeadlessAuthority) {}
  async submit(actor: HeadlessActor, input: HeadlessRunInput) {
    actor = actorSchema.parse(actor); input = runInputSchema.parse(input)
    await this.authority.authorize(actor,input.surface)
    return this.store.transaction(()=>this.store.insert(newRun(actor,input)))
  }
  async read(actor: HeadlessActor, runId: string) {
    const run = this.store.scoped(actor,runId)
    if (run) await this.authority.authorize(actor,run.surface)
    return run
  }
  async events(actor: HeadlessActor, runId: string, afterSequence=0) {
    const run = await this.read(actor,runId)
    return run ? this.store.events(runId,afterSequence) : []
  }
  async cancel(actor: HeadlessActor, runId: string) {
    const run = await this.read(actor,runId)
    if (run && (run.status === "queued" || run.status === "running")) {
      run.status="cancelled"; run.finishedAt=new Date().toISOString(); run.result=null
      this.store.transaction(()=>{ this.store.update(run); this.store.event(run.id,"status","Stopped") })
    }
    return run
  }
  async conversation(actor: HeadlessActor, surface: HeadlessSurface, key: string) {
    await this.authority.authorize(actor,surface)
    return this.store.conversation(actor,surface,key)
  }
  async createSchedule(actor: HeadlessActor, input: unknown) {
    const data=scheduleInputSchema.parse(input)
    await this.authority.authorize(actor,data.surface)
    const schedule={...data,id:randomUUID(),actor,paused:false,createdAt:new Date().toISOString()}
    this.store.saveSchedule(schedule)
    return schedule
  }
  async schedules(actor: HeadlessActor, surface: HeadlessSurface) {
    await this.authority.authorize(actor,surface)
    return this.store.schedules(actor).filter(item=>item.surface===surface)
  }
  async updateSchedule(actor: HeadlessActor, id: string, update: {paused?:boolean; title?:string; prompt?:string; intervalMinutes?:number; nextRunAt?:string}) {
    const previous=this.store.schedule(actor,id)
    if (!previous) throw new HeadlessError("schedule_not_found","This automation is unavailable.",404)
    await this.authority.authorize(actor,previous.surface)
    const next={...previous,...scheduleInputSchema.parse({title:update.title ?? previous.title,prompt:update.prompt ?? previous.prompt,surface:previous.surface,conversationKey:previous.conversationKey,intervalMinutes:update.intervalMinutes ?? previous.intervalMinutes,nextRunAt:update.nextRunAt ?? previous.nextRunAt})}
    next.paused=update.paused ?? previous.paused
    this.store.saveSchedule(next)
    return next
  }
  async runNow(actor: HeadlessActor,id:string,idempotencyKey:string) {
    const schedule=this.store.schedule(actor,id)
    if (!schedule) throw new HeadlessError("schedule_not_found","This automation is unavailable.",404)
    return this.submit(actor,{surface:schedule.surface,conversationKey:schedule.conversationKey,idempotencyKey,prompt:schedule.prompt,scheduleId:id})
  }
  async tickSchedules(now=Date.now()) {
    for (const schedule of this.store.due(now)) {
      try {
        await this.authority.authorize(schedule.actor,schedule.surface)
        this.store.transaction(()=>{
          const current=this.store.schedule(schedule.actor,schedule.id)
          if (!current || current.paused || Date.parse(current.nextRunAt)>now) return
          this.store.insert(newRun(schedule.actor,{surface:schedule.surface,conversationKey:schedule.conversationKey,idempotencyKey:`schedule:${schedule.id}:${current.nextRunAt}`,prompt:schedule.prompt,scheduleId:schedule.id}))
          current.nextRunAt=new Date(now+current.intervalMinutes*60000).toISOString()
          this.store.saveSchedule(current)
        })
      } catch {
        // Retain the schedule, but pause it when its owner loses authority.
        schedule.paused=true; this.store.saveSchedule(schedule)
      }
    }
  }
}
export class HeadlessWorker {
  readonly owner=randomUUID()
  private active: AbortController | null=null
  constructor(readonly service: HeadlessService, readonly engine: HeadlessEngine, readonly leaseMs=15000) {}
  stop() { this.active?.abort(new Error("worker_stopped")) }
  async once(): Promise<boolean> {
    await this.service.tickSchedules()
    const run=this.service.store.claim(this.owner,Date.now(),this.leaseMs)
    if (!run) return false
    const controller=new AbortController(); this.active=controller
    const started=Date.now()
    let credentials:Awaited<ReturnType<HeadlessAuthority["credentials"]>> | undefined
    let checking=false
    const check=async()=>{
      if (checking) return
      checking=true
      try {
        if (!this.service.store.heartbeat(run.id,this.owner,Date.now(),this.leaseMs)) throw new HeadlessError("run_stopped","This run was stopped.")
        await this.service.authority.authorize(run.actor,run.surface)
        if (credentials) await this.service.authority.validateCredentials?.(run.actor,credentials)
      } catch(error) { controller.abort(error) }
      finally {checking=false}
    }
    const heartbeat=setInterval(()=>void check(),Math.min(1000,this.leaseMs/3))
    const deadline=setTimeout(()=>controller.abort(new HeadlessError("run_timeout","This run reached its time limit. Try a smaller task.",409)),run.limits?.timeoutMs ?? 120000)
    try {
      await this.service.authority.authorize(run.actor,run.surface)
      credentials=await this.service.authority.credentials(run.actor)
      controller.signal.throwIfAborted()
      const result=await this.engine.execute({actor:run.actor,run,directory:this.service.store.directory(run.actor),credentials,signal:controller.signal,authorize:async()=>{if(!this.service.store.owns(run.id,this.owner)) throw new HeadlessError("lease_lost","This worker no longer owns the run.");await this.service.authority.authorize(run.actor,run.surface);if(credentials) await this.service.authority.validateCredentials?.(run.actor,credentials);controller.signal.throwIfAborted();if(!this.service.store.owns(run.id,this.owner)) throw new HeadlessError("lease_lost","This worker no longer owns the run.")},activity:async text=>{
        await this.service.authority.authorize(run.actor,run.surface)
        controller.signal.throwIfAborted()
        if (!this.service.store.owns(run.id,this.owner)) throw new HeadlessError("run_stopped","This run was stopped.")
        this.service.store.event(run.id,"activity",text)
      }})
      await this.service.authority.authorize(run.actor,run.surface)
      await this.service.authority.validateCredentials?.(run.actor,credentials)
      controller.signal.throwIfAborted()
      run.status="succeeded"; run.result=result.text.slice(0,20000)
      run.usage={inputTokens:result.inputTokens,outputTokens:result.outputTokens,durationMs:Date.now()-started}
    } catch(error) {
      const reason=controller.signal.aborted ? controller.signal.reason : error
      run.status=reason instanceof HeadlessError && reason.code!=="run_timeout" ? "blocked" : "failed"
      if (reason instanceof Error && reason.message==="worker_stopped") run.status="cancelled"
      run.failure=reason instanceof HeadlessError ? {code:reason.code,message:reason.message} : {code:"execution_failed",message:"The assistant could not finish this run. Check the connection and try again."}
      run.result=null; run.usage={inputTokens:0,outputTokens:0,durationMs:Date.now()-started}
    } finally {
      clearInterval(heartbeat); clearTimeout(deadline); this.active=null
      run.finishedAt=new Date().toISOString()
      this.service.store.finish(run,this.owner)
    }
    return true
  }
}
