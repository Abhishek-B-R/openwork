import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import type { GatewayRequestProtocol } from "@openwork/types/den/gateway"
import {
  GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER,
  GATEWAY_GOVERNANCE_ERROR_HEADER,
  GATEWAY_GOVERNANCE_SESSION_HEADER,
  gatewayGovernanceErrorSchema,
  gatewayGovernancePolicySchema,
  gatewayGovernanceSettingsSchema,
  MAX_GATEWAY_GOVERNANCE_ACTIVE_POLICIES,
  type GatewayGovernanceError,
  type GatewayGovernancePolicy,
} from "@openwork/types/den/gateway-governance"
import { buildGatewayGovernanceQuestions, getGatewayGovernanceAvailability, getGatewayGovernancePolicySetBudget, GATEWAY_GOVERNANCE_MAX_TIMEOUT_MS, parseGatewayGovernanceConfig } from "@openwork-ee/utils/gateway-governance"
import { assertGovernanceInputBudget, classifyGovernanceContribution, GovernanceInputError, governanceExtractorVersion, type GovernanceContributionState } from "./governance-input.js"
import { governanceAdmissionTtlMs, type GatewayGovernanceRecords, type GovernanceAdmissionReceipt, type GovernanceDecisionOutcome, type GovernanceDecisionRecord, type GovernanceRoute } from "./governance-records.js"
import { evaluateGatewayGovernance, GovernanceEvaluatorFailure, governanceModel, type EvaluateGatewayGovernance, type GovernanceEvaluationRequest } from "./governance-evaluator.js"

export const governanceBudgetMs = GATEWAY_GOVERNANCE_MAX_TIMEOUT_MS
export const governanceDecisionVersion = "noul-bands-v1"

type Config = ReturnType<typeof parseGatewayGovernanceConfig>
export type LoadGatewayGovernanceState = (organizationId: string, signal: AbortSignal) => Promise<unknown>
export type GovernanceSnapshot = {
  organizationId: string
  settingsRevision: number
  policySetRevision: number
  policies: GatewayGovernancePolicy[]
  config: Config & { apiKey: string; passMax: number; blockMin: number }
  extractorVersion: string
  decisionVersion: string
}
export type GatewayGovernanceResolution =
  | { kind: "off"; settingsRevision: number }
  | { kind: "enforce"; snapshot: GovernanceSnapshot }
  | { kind: "unavailable"; internalReason: string }
export type ResolveGatewayGovernance = (organizationId: string, signal: AbortSignal) => Promise<GatewayGovernanceResolution>

type Code = GatewayGovernanceError["error"]["code"]
type Violation = GatewayGovernanceError["error"]["violations"][number]

const stateSchema = z.object({ organizationId: z.string().min(1), metadata: z.unknown(), settings: gatewayGovernanceSettingsSchema, policies: z.unknown() })

export const loadGatewayGovernanceStateFromDb: LoadGatewayGovernanceState = async (organizationId, signal) => {
  signal.throwIfAborted()
  const { db } = await import("./db.js")
  const { readGatewayGovernanceState } = await import("@openwork-ee/den-db/gateway-governance")
  signal.throwIfAborted()
  return readGatewayGovernanceState(db, organizationId)
}

export function createGatewayGovernanceResolver(input: {
  loadState: LoadGatewayGovernanceState
  config: () => Config
}): ResolveGatewayGovernance {
  return async (organizationId, signal) => {
    try {
      signal.throwIfAborted()
      const state = stateSchema.safeParse(await input.loadState(organizationId, signal))
      signal.throwIfAborted()
      if (!state.success || state.data.organizationId !== organizationId) return { kind: "unavailable", internalReason: "invalid_state" }
      if (!state.data.settings.enabled) return { kind: "off", settingsRevision: state.data.settings.revision }
      const config = input.config()
      const availability = getGatewayGovernanceAvailability(config, state.data.metadata)
      if (!availability.available) return { kind: "unavailable", internalReason: availability.reason }
      if (config.model !== governanceModel || !config.apiKey?.trim() || config.passMax === undefined || config.blockMin === undefined
        || !Number.isFinite(config.passMax) || !Number.isFinite(config.blockMin) || config.passMax < 0 || config.passMax >= config.blockMin || config.blockMin > 1
        || !Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) return { kind: "unavailable", internalReason: "invalid_config" }
      const policies = z.array(gatewayGovernancePolicySchema).safeParse(state.data.policies)
      if (!policies.success || new Set(policies.data.map((policy) => policy.id)).size !== policies.data.length) return { kind: "unavailable", internalReason: "invalid_policies" }
      const active = policies.data.filter((policy) => policy.status === "active").sort((a, b) => a.id.localeCompare(b.id))
      if (active.length > MAX_GATEWAY_GOVERNANCE_ACTIVE_POLICIES) return { kind: "unavailable", internalReason: "too_many_policies" }
      if (!getGatewayGovernancePolicySetBudget(active).publishable) return { kind: "unavailable", internalReason: "policy_budget_exhausted" }
      return { kind: "enforce", snapshot: {
        organizationId,
        settingsRevision: state.data.settings.revision,
        policySetRevision: state.data.settings.policySetRevision,
        policies: active,
        config: { ...config, apiKey: config.apiKey, passMax: config.passMax, blockMin: config.blockMin },
        extractorVersion: governanceExtractorVersion,
        decisionVersion: governanceDecisionVersion,
      } }
    } catch {
      return { kind: "unavailable", internalReason: "state_unavailable" }
    }
  }
}

export const resolveGatewayGovernance = createGatewayGovernanceResolver({
  loadState: loadGatewayGovernanceStateFromDb,
  config: () => parseGatewayGovernanceConfig(process.env),
})

export class GovernanceFailure extends Error {
  constructor(readonly code: Code, readonly violations: Violation[] = [], readonly evaluationComplete = false, readonly oversized = false) {
    super(code)
  }
}

function unavailable(): GovernanceFailure { return new GovernanceFailure("openwork_gateway_governance_unavailable") }

export function createGovernanceBudget(signal: AbortSignal, timeoutMs = governanceBudgetMs) {
  const controller = new AbortController()
  const timeout = Math.min(governanceBudgetMs, Math.max(1, timeoutMs))
  let spent = 0
  let activeSince: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const abort = () => controller.abort()
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  const remaining = () => Math.max(0, Math.floor(timeout - spent - (activeSince === undefined ? 0 : performance.now() - activeSince)))
  return {
    signal: controller.signal,
    remaining,
    spent: () => Math.max(0, Math.round(spent + (activeSince === undefined ? 0 : performance.now() - activeSince))),
    async run<T>(operation: () => PromiseLike<T>): Promise<T> {
      if (controller.signal.aborted || remaining() <= 0 || activeSince !== undefined) throw unavailable()
      const started = performance.now()
      activeSince = started
      timer = setTimeout(abort, remaining())
      let onAbort = () => {}
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(unavailable())
        controller.signal.addEventListener("abort", onAbort, { once: true })
      })
      try {
        const result = await Promise.race([Promise.resolve().then(() => {
          if (controller.signal.aborted) throw unavailable()
          return operation()
        }), cancelled])
        if (controller.signal.aborted || remaining() <= 0) throw unavailable()
        return result
      } finally {
        clearTimeout(timer)
        timer = undefined
        spent += performance.now() - started
        activeSince = undefined
        controller.signal.removeEventListener("abort", onAbort)
      }
    },
    dispose() { clearTimeout(timer); signal.removeEventListener("abort", abort); controller.abort() },
  }
}

export function buildGovernanceQuestions(policies: GatewayGovernancePolicy[]): GovernanceEvaluationRequest["questions"] {
  return buildGatewayGovernanceQuestions(policies)
}

function violation(policy: GatewayGovernancePolicy): Violation {
  return { policy_id: policy.id, policy_revision: policy.revision, policy_name: policy.name }
}

export function validateGovernanceAnswers(result: unknown, snapshot: GovernanceSnapshot) {
  const response = z.object({
    model: z.literal(governanceModel),
    answers: z.record(z.string(), z.object({ type: z.literal("noul"), noul: z.number().finite().min(0).max(1) }).strict()),
  }).safeParse(result)
  if (!response.success) throw unavailable()
  const keys = snapshot.policies.map((_policy, index) => `p${index}`)
  if (Object.keys(response.data.answers).length !== keys.length || keys.some((key) => !Object.hasOwn(response.data.answers, key))) throw unavailable()
  const blocked: Violation[] = []
  const uncertain: Violation[] = []
  snapshot.policies.forEach((policy, index) => {
    const answer = response.data.answers[`p${index}`].noul
    if (answer >= snapshot.config.blockMin) blocked.push(violation(policy))
    else if (answer > snapshot.config.passMax) uncertain.push(violation(policy))
  })
  if (blocked.length) throw new GovernanceFailure("openwork_gateway_governance_blocked", blocked, true)
  if (uncertain.length) throw new GovernanceFailure("openwork_gateway_governance_uncertain", uncertain, true)
}

export function sameGovernanceResolution(before: GatewayGovernanceResolution, after: GatewayGovernanceResolution) {
  if (before.kind === "off" && after.kind === "off") return before.settingsRevision === after.settingsRevision
  if (before.kind !== "enforce" || after.kind !== "enforce") return false
  return JSON.stringify(before.snapshot) === JSON.stringify(after.snapshot)
}

export function validatedGovernanceCorrelation(value: string | null): string | undefined {
  return value !== null && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ? value : undefined
}

export function governanceFailureResponse(failure: GovernanceFailure, input: { requestId: string; decisionId: string; headers: Headers }) {
  const contributionId = validatedGovernanceCorrelation(input.headers.get(GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER))
  const sessionId = validatedGovernanceCorrelation(input.headers.get(GATEWAY_GOVERNANCE_SESSION_HEADER))
  const messages: Record<Code, string> = {
    openwork_gateway_governance_blocked: `This message was blocked by organization policies: ${failure.violations.map((policy) => policy.policy_name).join("; ")}.`,
    openwork_gateway_governance_uncertain: `This message could not be cleared against organization policies: ${failure.violations.map((policy) => policy.policy_name).join("; ")}.`,
    openwork_gateway_governance_unavailable: "Couldn't check organization policies. This request wasn't sent to the target model.",
    openwork_gateway_governance_policy_changed: "Organization policies changed before dispatch. Submit the message again.",
    openwork_gateway_governance_unsupported_input: failure.oversized
      ? "This message or its attachments are too large to check. Shorten the message or remove an attachment."
      : "This request does not identify a supported new user text contribution. Use a new text message and supported text attachments.",
  }
  const body = gatewayGovernanceErrorSchema.parse({ error: {
    source: "openwork_gateway", type: "governance_error", code: failure.code, message: messages[failure.code], schema_version: 1,
    request_id: input.requestId, decision_id: input.decisionId, input_scope: "new_user_contribution", upstream_dispatched: false,
    retryable: false, evaluation_complete: failure.evaluationComplete, violations: failure.violations,
    ...(contributionId ? { contribution_id: contributionId } : {}),
  } })
  const headers = new Headers({ [GATEWAY_GOVERNANCE_ERROR_HEADER]: "1", "x-should-retry": "false", "cache-control": "no-store" })
  if (contributionId) headers.set(GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER, contributionId)
  if (sessionId) headers.set(GATEWAY_GOVERNANCE_SESSION_HEADER, sessionId)
  const status = failure.code === "openwork_gateway_governance_blocked" ? 403
    : failure.code === "openwork_gateway_governance_unavailable" ? 503
    : failure.code === "openwork_gateway_governance_policy_changed" ? 503 : 422
  return Response.json(body, { status, headers })
}

const usageSchema = z.object({ usage: z.object({ input_tokens: z.number().int().min(0).max(2_147_483_647), output_tokens: z.number().int().min(0).max(2_147_483_647) }) })
const receiptLookupMs = 750
const receiptWriteMs = 1000

function evaluatorUsage(result: unknown) {
  const parsed = usageSchema.safeParse(result)
  return parsed.success ? { input: parsed.data.usage.input_tokens, output: parsed.data.usage.output_tokens } : undefined
}

function outcomeFor(code: Code): GovernanceDecisionOutcome {
  switch (code) {
    case "openwork_gateway_governance_blocked": return "blocked"
    case "openwork_gateway_governance_uncertain": return "uncertain"
    case "openwork_gateway_governance_unsupported_input": return "unsupported_input"
    case "openwork_gateway_governance_policy_changed": return "policy_changed"
    case "openwork_gateway_governance_unavailable": return "unavailable"
  }
}

/** Resolves to the operation's value, or null on error or after `ms`; never rejects. */
async function bounded<T>(operation: () => Promise<T>, ms: number): Promise<{ value: T } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(operation).then((value) => ({ value }), () => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms) }),
    ])
  } finally { clearTimeout(timer) }
}

function logRecordFailure(message: string, decisionId: string) {
  console.warn(`[gateway-governance] ${message}`, { decisionId })
}

type Admitted =
  | { kind: "resolution"; resolution: GatewayGovernanceResolution }
  | { kind: "receipt"; snapshot: GovernanceSnapshot; receipt: GovernanceAdmissionReceipt }

export function createGovernanceAdmission(input: {
  organizationId: string
  memberId?: string
  requestId?: string
  route?: GovernanceRoute
  protocol: GatewayRequestProtocol
  body: unknown
  signal: AbortSignal
  resolve?: ResolveGatewayGovernance
  evaluate?: EvaluateGatewayGovernance
  records?: GatewayGovernanceRecords
  now?: () => Date
  timeoutMs?: number
}) {
  const budget = createGovernanceBudget(input.signal, input.timeoutMs)
  const resolve = input.resolve ?? resolveGatewayGovernance
  const evaluate = input.evaluate ?? evaluateGatewayGovernance
  const records = input.records
  const now = input.now ?? (() => new Date())
  const memberId = input.memberId?.trim() ? input.memberId : undefined
  const decisionId = randomUUID()
  let admitted: Admitted | undefined
  let snapshot: GovernanceSnapshot | undefined
  let knownOff = false
  let attempts = 0
  let usage: { input: number; output: number } | undefined
  let pendingReceipt: { digest: string; policySetRevision: number } | undefined
  let pendingOutcome: GovernanceDecisionOutcome | undefined
  let recorded = false

  const record = (outcome: GovernanceDecisionOutcome, failure?: GovernanceFailure, receipt?: GovernanceAdmissionReceipt) => {
    if (recorded) return
    recorded = true
    pendingOutcome = undefined
    if (!records || knownOff) return
    const row: GovernanceDecisionRecord = {
      decisionId,
      requestId: input.requestId ?? decisionId,
      organizationId: input.organizationId,
      memberId: memberId ?? null,
      route: input.route ?? "provider",
      outcome,
      policySetRevision: receipt ? receipt.policySetRevision : snapshot?.policySetRevision ?? null,
      policies: receipt ? [] : (snapshot?.policies ?? []).map((policy) => ({ id: policy.id, revision: policy.revision })),
      failedPolicies: (failure?.violations ?? []).map((policy) => ({ id: policy.policy_id, revision: policy.policy_revision, name: policy.policy_name })),
      evaluatorModel: attempts > 0 ? governanceModel : null,
      extractorVersion: governanceExtractorVersion,
      decisionVersion: governanceDecisionVersion,
      latencyMs: budget.spent(),
      evaluatorInputTokens: usage?.input ?? null,
      evaluatorOutputTokens: usage?.output ?? null,
      evaluatorAttempts: attempts,
      createdAt: now(),
    }
    void Promise.resolve().then(() => records.recordDecision(row)).catch(() => logRecordFailure("Decision audit write failed", decisionId))
  }
  const fail = (error: unknown): never => {
    const failure = error instanceof GovernanceFailure ? error : unavailable()
    record(outcomeFor(failure.code), failure)
    throw failure
  }
  const read = async () => {
    try {
      budget.signal.throwIfAborted()
      const result = await resolve(input.organizationId, budget.signal)
      budget.signal.throwIfAborted()
      return result
    }
    catch { throw unavailable() }
  }
  const digestFor = (state: GovernanceContributionState) => {
    if (!records || !memberId) return undefined
    try { return records.digest({ organizationId: input.organizationId, memberId, extractorVersion: governanceExtractorVersion, state }) }
    catch { logRecordFailure("Admission digest unavailable", decisionId); return undefined }
  }
  const lookupReceipt = async (state: GovernanceContributionState) => {
    const digest = digestFor(state)
    if (!records || !memberId || !digest) return undefined
    const found = await bounded(() => records.findAdmission({ organizationId: input.organizationId, memberId, digest, now: now() }),
      Math.min(receiptLookupMs, Math.max(1, budget.remaining() - 250)))
    const receipt = found?.value
    return receipt && receipt.expiresAt.getTime() > now().getTime() ? receipt : undefined
  }
  const evaluateSnapshot = async (current: GovernanceSnapshot, state: GovernanceContributionState, questions: GovernanceEvaluationRequest["questions"]) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let result: unknown
      try {
        budget.signal.throwIfAborted()
        attempts++
        result = await evaluate({ model: governanceModel, state, questions }, {
          organizationId: input.organizationId,
          memberId: memberId ?? input.organizationId,
          apiKey: current.config.apiKey,
          signal: budget.signal,
          timeoutMs: Math.min(current.config.timeoutMs, budget.remaining()),
        })
        budget.signal.throwIfAborted()
      } catch (error) {
        const backoff = error instanceof GovernanceEvaluatorFailure ? error.retryAfterMs ?? 100 : Infinity
        if (attempt !== 0 || !(error instanceof GovernanceEvaluatorFailure) || !error.transient || backoff + 250 >= budget.remaining()) throw unavailable()
        await delay(backoff, undefined, { signal: budget.signal })
        continue
      }
      usage = evaluatorUsage(result) ?? usage
      validateGovernanceAnswers(result, current)
      return
    }
    throw unavailable()
  }
  return {
    decisionId,
    check: async () => {
      try {
        await budget.run(async () => {
          admitted = undefined
          pendingReceipt = undefined
          const resolution = await read()
          if (resolution.kind === "unavailable") throw unavailable()
          if (resolution.kind === "off") { knownOff = true; admitted = { kind: "resolution", resolution }; return }
          knownOff = false
          const current = resolution.snapshot
          snapshot = current
          try {
            const { state, continuation } = classifyGovernanceContribution(input.protocol, input.body)
            const questions = buildGovernanceQuestions(current.policies)
            assertGovernanceInputBudget(state, questions)
            if (continuation) {
              const receipt = await lookupReceipt(state)
              if (receipt) {
                admitted = { kind: "receipt", snapshot: current, receipt }
                pendingOutcome = "receipt_reused"
                return
              }
            }
            if (current.policies.length) await evaluateSnapshot(current, state, questions)
            admitted = { kind: "resolution", resolution }
            pendingOutcome = "allowed"
            const digest = digestFor(state)
            if (digest) pendingReceipt = { digest, policySetRevision: current.policySetRevision }
          } catch (error) {
            if (error instanceof GovernanceFailure) throw error
            if (error instanceof GovernanceInputError) throw new GovernanceFailure("openwork_gateway_governance_unsupported_input", [], false, error.reason === "too_large")
            throw unavailable()
          }
        })
      } catch (error) {
        admitted = undefined
        fail(error)
      }
    },
    recheck: async () => {
      try {
        await budget.run(async () => {
          let current: GatewayGovernanceResolution
          try { current = await read() } catch (error) { knownOff = false; throw error }
          if (current.kind === "unavailable") { knownOff = false; throw unavailable() }
          if (admitted?.kind === "receipt") return
          if (current.kind === "enforce") { knownOff = false; snapshot = current.snapshot }
          if (!admitted || !sameGovernanceResolution(admitted.resolution, current)) throw new GovernanceFailure("openwork_gateway_governance_policy_changed")
        })
      } catch (error) {
        fail(error)
      }
      if (admitted?.kind === "receipt") { record("receipt_reused", undefined, admitted.receipt); return }
      if (knownOff) { recorded = true; return }
      const receipt = pendingReceipt
      pendingReceipt = undefined
      record("allowed")
      if (!receipt || !records || !memberId) return
      const createdAt = now()
      const written = await bounded(() => records.createAdmission({
        organizationId: input.organizationId,
        memberId,
        digest: receipt.digest,
        policySetRevision: receipt.policySetRevision,
        decisionId,
        expiresAt: new Date(createdAt.getTime() + governanceAdmissionTtlMs),
        createdAt,
      }), receiptWriteMs)
      if (!written) logRecordFailure("Admission receipt write failed", decisionId)
    },
    dispose() {
      if (pendingOutcome && admitted) record(pendingOutcome, undefined, admitted.kind === "receipt" ? admitted.receipt : undefined)
      budget.dispose()
    },
  }
}
