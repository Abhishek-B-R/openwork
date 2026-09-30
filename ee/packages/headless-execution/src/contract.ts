/** Actors are resolved by Den. Never accept actor IDs from transport payloads. */
export interface HeadlessActor {
  organizationId: string
  memberId: string
}
export type HeadlessSurface = "workbot" | "slack"
export type HeadlessRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "blocked"
export interface HeadlessRunInput {
  surface: HeadlessSurface
  conversationKey: string
  idempotencyKey: string
  prompt: string
  limits?: { timeoutMs?: number; maxTurns?: number }
  scheduleId?: string
}
export interface HeadlessRun extends HeadlessRunInput {
  id: string
  actor: HeadlessActor
  status: HeadlessRunStatus
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  result: string | null
  failure: { code: string; message: string } | null
  usage: { inputTokens: number; outputTokens: number; durationMs: number } | null
}
export interface HeadlessEvent {
  sequence: number
  runId: string
  createdAt: string
  kind: "status" | "activity" | "result"
  text: string
}
/** Durable state is scoped by organization, member and surface. */
export interface HeadlessExecution {
  submit(actor: HeadlessActor, input: HeadlessRunInput): Promise<HeadlessRun>
  read(actor: HeadlessActor, runId: string): Promise<HeadlessRun | null>
  events(actor: HeadlessActor, runId: string, afterSequence?: number): Promise<HeadlessEvent[]>
  cancel(actor: HeadlessActor, runId: string): Promise<HeadlessRun | null>
  conversation(actor: HeadlessActor, surface: HeadlessSurface, conversationKey: string): Promise<HeadlessRun[]>
}
/** Check at admission, claim, during execution and before output. */
export interface HeadlessAuthority {
  authorize(actor: HeadlessActor, surface: HeadlessSurface): Promise<void>
  validateCredentials?(actor: HeadlessActor, credentials: Awaited<ReturnType<HeadlessAuthority["credentials"]>>): Promise<void>
  credentials(actor: HeadlessActor): Promise<{
    mcpUrl: string
    mcpToken: string
    readCapabilities?: string[]
    model: { providerId: string; modelId: string; baseUrl: string; apiKey: string; package?: string }
  }>
}
export interface HeadlessEngine {
  execute(input: {
    actor: HeadlessActor
    run: HeadlessRun
    directory: string
    credentials: Awaited<ReturnType<HeadlessAuthority["credentials"]>>
    signal: AbortSignal
    authorize?: () => Promise<void>
    activity: (text: string) => Promise<void>
  }): Promise<{ text: string; inputTokens: number; outputTokens: number }>
}
