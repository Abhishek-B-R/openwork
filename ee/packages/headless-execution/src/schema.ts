import { z } from "zod"
export const actorSchema = z.object({ organizationId: z.string().min(1).max(160), memberId: z.string().min(1).max(160) }).strict()
export const surfaceSchema = z.enum(["workbot", "slack"])
export const runInputSchema = z.object({
  surface: surfaceSchema,
  conversationKey: z.string().min(1).max(160),
  idempotencyKey: z.string().min(1).max(160),
  prompt: z.string().trim().min(1).max(20000),
  limits: z.object({ timeoutMs: z.number().int().min(1000).max(300000).optional(), maxTurns: z.number().int().min(1).max(32).optional() }).strict().optional(),
  scheduleId: z.string().min(1).max(160).optional(),
}).strict()
export const runSchema = runInputSchema.extend({
  id: z.string(), actor: actorSchema,
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "blocked"]),
  createdAt: z.string(), startedAt: z.string().nullable(), finishedAt: z.string().nullable(), result: z.string().nullable(),
  failure: z.object({ code: z.string(), message: z.string() }).nullable(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), durationMs: z.number() }).nullable(),
})
export const eventSchema = z.object({ sequence: z.number(), runId: z.string(), createdAt: z.string(), kind: z.enum(["status", "activity", "result"]), text: z.string() })
export const scheduleInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(20000),
  surface: surfaceSchema,
  conversationKey: z.string().min(1).max(160),
  intervalMinutes: z.number().int().min(1).max(10080),
  nextRunAt: z.iso.datetime(),
}).strict()
export const scheduleSchema = scheduleInputSchema.extend({ id: z.string(), actor: actorSchema, paused: z.boolean(), createdAt: z.string() })
export type HeadlessSchedule = z.infer<typeof scheduleSchema>
export class HeadlessError extends Error {
  constructor(public code: string, message: string, public status: 400 | 403 | 404 | 409 = 403) { super(message) }
}
