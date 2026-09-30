import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { ActorFiles } from "@openwork-ee/headless-execution/files"
import { HeadlessError, runInputSchema, runSchema, eventSchema, scheduleInputSchema, scheduleSchema, surfaceSchema } from "@openwork-ee/headless-execution/schema"
import type { HeadlessService } from "@openwork-ee/headless-execution"
import { jsonValidator, orgMemberRoute, paramValidator, queryValidator, type OrganizationContextVariables } from "../middleware/index.js"
import { jsonResponse } from "../openapi.js"
import { assertHeadlessFlags } from "./authority.js"

const idSchema=z.object({id:z.string().min(1).max(160)})
const listSchema=z.object({surface:surfaceSchema,conversationKey:z.string().min(1).max(160)})
const errorSchema=z.object({error:z.string(),message:z.string()})
const stateSchema=z.object({enabled:z.boolean(),blockedReason:z.string().nullable(),runs:z.array(runSchema),schedules:z.array(scheduleSchema),files:z.array(z.string())})
const headlessRoute=(options:DescribeRouteOptions & {"x-mcp":false})=>describeRoute(options)
const route=(summary:string,schema:z.ZodType)=>headlessRoute({tags:["Headless execution"],summary,"x-mcp":false,responses:{200:jsonResponse(summary,schema),400:jsonResponse("Invalid request",errorSchema),403:jsonResponse("Assistant blocked",errorSchema),404:jsonResponse("Unavailable",errorSchema),409:jsonResponse("Request conflict",errorSchema)}})
function actor(c:{get(name:"organizationContext"):OrganizationContextVariables["organizationContext"]}) {const context=c.get("organizationContext");return {organizationId:context.organization.id,memberId:context.currentMember.id}}
async function respond<T>(operation:()=>Promise<T>) {
  try {return {ok:true,value:await operation()} satisfies {ok:true;value:T}}
  catch(error) {if(error instanceof HeadlessError) return {ok:false,error,status:error.status} satisfies {ok:false;error:HeadlessError;status:number};throw error}
}
export function registerHeadlessRoutes<T extends {Variables:Partial<OrganizationContextVariables>}>(app:Hono<T>,provided?:HeadlessService) {
  const service=async()=>provided ?? (await import("./runtime.js")).headlessService()
  app.get("/v1/workbot",route("Read Workbot",stateSchema),orgMemberRoute(),async c=>{
    const context=c.get("organizationContext")
    try {assertHeadlessFlags(context.organization.metadata,"workbot")} catch(error) {
      return c.json({enabled:false,blockedReason:error instanceof Error?error.message:"Blocked by your team",runs:[],schedules:[],files:[]})
    }
    const scope=actor(c)
    const result=await respond(async()=>({enabled:true,blockedReason:null,runs:await (await service()).conversation(scope,"workbot","main"),schedules:await (await service()).schedules(scope,"workbot"),files:await new ActorFiles((await service()).store.directory(scope)).list()}))
    return result.ok?c.json(result.value):c.json({error:result.error.code,message:result.error.message},result.error.status)
  })
  app.post("/v1/headless/runs",route("Send assistant message",z.object({run:runSchema})),orgMemberRoute(),jsonValidator(runInputSchema),async c=>{
    const result=await respond(async()=> (await service()).submit(actor(c),c.req.valid("json")))
    return result.ok?c.json({run:result.value}):c.json({error:result.error.code,message:result.error.message},result.error.status)
  })
  app.get("/v1/headless/runs",route("Read assistant conversation",z.object({runs:z.array(runSchema)})),orgMemberRoute(),queryValidator(listSchema),async c=>{
    const query=c.req.valid("query");const result=await respond(async()=> (await service()).conversation(actor(c),query.surface,query.conversationKey))
    return result.ok?c.json({runs:result.value}):c.json({error:result.error.code,message:result.error.message},result.error.status)
  })
  app.get("/v1/headless/runs/:id",route("Read assistant run",z.object({run:runSchema.nullable()})),orgMemberRoute(),paramValidator(idSchema),async c=>{
    const result=await respond(async()=> (await service()).read(actor(c),c.req.valid("param").id))
    return result.ok?c.json({run:result.value}):c.json({error:result.error.code,message:result.error.message},result.error.status)
  })
  app.get("/v1/headless/runs/:id/events",route("Read assistant activity",z.object({events:z.array(eventSchema)})),orgMemberRoute(),paramValidator(idSchema),queryValidator(z.object({after:z.coerce.number().int().min(0).default(0)})),async c=>{
    const result=await respond(async()=> (await service()).events(actor(c),c.req.valid("param").id,c.req.valid("query").after))
    return result.ok?c.json({events:result.value}):c.json({error:result.error.code,message:result.error.message},result.error.status)
  })
  app.post("/v1/headless/runs/:id/cancel",route("Stop assistant run",z.object({run:runSchema.nullable()})),orgMemberRoute(),paramValidator(idSchema),async c=>{
    const result=await respond(async()=> (await service()).cancel(actor(c),c.req.valid("param").id))
    return result.ok?c.json({run:result.value}):c.json({error:result.error.code,message:result.error.message},result.error.status)
  })
  app.post("/v1/workbot/schedules",route("Schedule assistant work",z.object({schedule:scheduleSchema})),orgMemberRoute(),jsonValidator(scheduleInputSchema.omit({surface:true,conversationKey:true})),async c=>{
    const result=await respond(async()=> (await service()).createSchedule(actor(c),{...c.req.valid("json"),surface:"workbot",conversationKey:"main"}))
    return result.ok?c.json({schedule:result.value}):c.json({error:result.error.code,message:result.error.message},result.error.status)
  })
  const requireWorkbotSchedule=async(scope:ReturnType<typeof actor>,id:string)=>{
    await (await service()).authority.authorize(scope,"workbot")
    if((await service()).store.schedule(scope,id)?.surface!=="workbot") throw new HeadlessError("schedule_not_found","This automation is unavailable.",404)
  }
  app.patch("/v1/workbot/schedules/:id",route("Edit scheduled work",z.object({schedule:scheduleSchema})),orgMemberRoute(),paramValidator(idSchema),jsonValidator(scheduleInputSchema.omit({surface:true,conversationKey:true}).partial().extend({paused:z.boolean().optional()}).strict()),async c=>{
    const result=await respond(async()=>{await requireWorkbotSchedule(actor(c),c.req.valid("param").id);return (await service()).updateSchedule(actor(c),c.req.valid("param").id,c.req.valid("json"))})
    return result.ok?c.json({schedule:result.value}):c.json({error:result.error.code,message:result.error.message},result.error.status)
  })
  app.post("/v1/workbot/schedules/:id/run",route("Run scheduled work now",z.object({run:runSchema})),orgMemberRoute(),paramValidator(idSchema),jsonValidator(z.object({idempotencyKey:z.string().min(1).max(160)}).strict()),async c=>{
    const result=await respond(async()=>{await requireWorkbotSchedule(actor(c),c.req.valid("param").id);return (await service()).runNow(actor(c),c.req.valid("param").id,c.req.valid("json").idempotencyKey)})
    return result.ok?c.json({run:result.value}):c.json({error:result.error.code,message:result.error.message},result.error.status)
  })
  app.get("/v1/workbot/files",route("Read assistant file",z.object({path:z.string(),text:z.string()})),orgMemberRoute(),queryValidator(z.object({path:z.string().min(1).max(500)})),async c=>{
    const scope=actor(c);const access=await respond(async()=> (await service()).authority.authorize(scope,"workbot"))
    if(!access.ok) return c.json({error:access.error.code,message:access.error.message},access.error.status)
    const path=c.req.valid("query").path
    try {return c.json({path,text:await new ActorFiles((await service()).store.directory(scope)).read(path)})}
    catch {return c.json({error:"file_unavailable",message:"This file is unavailable. Choose another file."},404)}
  })
}
