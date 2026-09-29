import { APIConnectionError, APIError, APITimeoutError, TypeSafeClient } from "@typesafe-ai/sdk"
import type { NoulQuestion, SystemOneRequest } from "@typesafe-ai/sdk"
import { GATEWAY_GOVERNANCE_SUPPORTED_MODEL } from "@openwork-ee/utils/gateway-governance"
import { readBoundedBody, RequestBodyLimitError } from "./relay.js"

export const governanceModel = GATEWAY_GOVERNANCE_SUPPORTED_MODEL
export type GovernanceEvaluationRequest = SystemOneRequest<Record<string, NoulQuestion>>
export type EvaluateGatewayGovernance = (request: GovernanceEvaluationRequest, options: {
  organizationId: string
  memberId: string
  apiKey: string
  signal: AbortSignal
  timeoutMs: number
}) => Promise<unknown>

export class GovernanceEvaluatorFailure extends Error {
  constructor(readonly transient: boolean, readonly retryAfterMs?: number) {
    super("Governance evaluator unavailable")
  }
}

export function governanceRetryAfter(headers: Headers, now = Date.now()): number | undefined {
  const milliseconds = headers.get("retry-after-ms")
  if (milliseconds !== null) {
    const value = Number(milliseconds)
    return milliseconds.trim() && Number.isFinite(value) && value >= 0 ? value : Infinity
  }
  const seconds = headers.get("retry-after")
  if (seconds === null) return undefined
  const value = /^\d+(?:\.\d+)?$/.test(seconds) ? Number(seconds) * 1000 : Date.parse(seconds) - now
  return Number.isFinite(value) ? Math.max(0, value) : Infinity
}

export function createTypeSafeGovernanceEvaluator(transport: typeof fetch = globalThis.fetch): EvaluateGatewayGovernance {
  return async (request, options) => {
    let invalidResponse = false
    const client = new TypeSafeClient({
      apiKey: options.apiKey,
      baseURL: "https://api.typesafe.ai",
      defaultModel: governanceModel,
      logLevel: "off",
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      retry: { maxRetries: 0 },
      timeout: options.timeoutMs,
      fetch: async (url, init) => {
        const response = await transport(url, { ...init, redirect: "error" })
        const signal = init?.signal ?? options.signal
        const bytes = await readBoundedBody({ body: response.body, signal }, 65_536).catch((error: unknown) => {
          if (error instanceof RequestBodyLimitError) invalidResponse = true
          throw error
        })
        const headers = new Headers(response.headers)
        headers.delete("content-length")
        headers.delete("content-encoding")
        return new Response(bytes, { status: response.status, headers })
      },
    })
    try {
      return await client.systemOne(request, { signal: options.signal, timeout: options.timeoutMs, retry: { maxRetries: 0 } })
    } catch (error) {
      if (error instanceof APIError) {
        throw new GovernanceEvaluatorFailure(error.status === 429 || (error.status >= 500 && error.status <= 599), governanceRetryAfter(error.headers))
      }
      throw new GovernanceEvaluatorFailure(!invalidResponse && error instanceof APIConnectionError && !(error instanceof APITimeoutError) && !options.signal.aborted)
    }
  }
}

export function guardGatewayGovernanceEvaluator(evaluate: EvaluateGatewayGovernance, clock = () => performance.now()): EvaluateGatewayGovernance {
  let inFlight = 0
  const organizations = new Map<string, number>()
  const members = new Map<string, number>()
  const failures = new Map<string, { count: number; until: number }>()
  const decrement = (counts: Map<string, number>, key: string) => {
    const count = (counts.get(key) ?? 1) - 1
    if (count === 0) counts.delete(key)
    else counts.set(key, count)
  }
  return async (request, options) => {
    const now = clock()
    for (const [key, state] of failures) if (state.until <= now) failures.delete(key)
    const organization = options.organizationId
    const member = JSON.stringify([organization, options.memberId])
    if (options.signal.aborted || inFlight >= 32 || (organizations.get(organization) ?? 0) >= 4 || (members.get(member) ?? 0) >= 2
      || (failures.get(organization)?.count ?? 0) >= 3) throw new GovernanceEvaluatorFailure(false)
    inFlight++
    organizations.set(organization, (organizations.get(organization) ?? 0) + 1)
    members.set(member, (members.get(member) ?? 0) + 1)
    try {
      const result = await evaluate(request, options)
      failures.delete(organization)
      return result
    } catch (error) {
      if (!options.signal.aborted) {
        if (!failures.has(organization) && failures.size >= 256) {
          const oldest = failures.keys().next().value
          if (oldest !== undefined) failures.delete(oldest)
        }
        failures.set(organization, { count: (failures.get(organization)?.count ?? 0) + 1, until: clock() + 15_000 })
      }
      throw error
    } finally {
      inFlight--
      decrement(organizations, organization)
      decrement(members, member)
    }
  }
}

export const evaluateGatewayGovernance = guardGatewayGovernanceEvaluator(createTypeSafeGovernanceEvaluator())
