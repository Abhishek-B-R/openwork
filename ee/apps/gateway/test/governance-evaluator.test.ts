import assert from "node:assert/strict"
import { test } from "node:test"
import { createTypeSafeGovernanceEvaluator, guardGatewayGovernanceEvaluator, GovernanceEvaluatorFailure, governanceModel, governanceRetryAfter } from "../src/governance-evaluator.js"
import { createGovernanceAdmission } from "../src/governance.js"
import { governanceFixture } from "./helpers/governance-fixture.js"

const request = { model: governanceModel, state: { contributions: [{ text: ["PRIVATE_INPUT_MARKER"] }] }, questions: { p0: { type: "noul", instructions: "PRIVATE_POLICY_MARKER" } } } satisfies Parameters<ReturnType<typeof createTypeSafeGovernanceEvaluator>>[0]
const options = () => ({ organizationId: "org_synthetic", memberId: "member_synthetic", apiKey: "SYNTHETIC_KEY", timeoutMs: 1000, signal: new AbortController().signal })

test("SDK is pinned, sends one systemOne request, has no redirects/retries/body logging even when SDK environment requests debug", async () => {
  const oldLogLevel = process.env.TYPESAFE_LOG_LEVEL
  const oldBase = process.env.TYPESAFE_BASE_URL
  const oldModel = process.env.TYPESAFE_DEFAULT_MODEL
  process.env.TYPESAFE_LOG_LEVEL = "debug"
  process.env.TYPESAFE_BASE_URL = "https://untrusted.test"
  process.env.TYPESAFE_DEFAULT_MODEL = "jev-latest"
  const logs: unknown[][] = []
  const originals = { debug: console.debug, info: console.info, warn: console.warn, error: console.error }
  console.debug = (...args: unknown[]) => { logs.push(args) }
  console.info = (...args: unknown[]) => { logs.push(args) }
  console.warn = (...args: unknown[]) => { logs.push(args) }
  console.error = (...args: unknown[]) => { logs.push(args) }
  let calls = 0
  const evaluate = createTypeSafeGovernanceEvaluator(async (url, init) => {
    calls++
    assert.equal(url, "https://api.typesafe.ai/v1/systemone")
    assert.equal(init?.redirect, "error")
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer SYNTHETIC_KEY")
    assert.equal(new Headers(init?.headers).get("x-typesafe-retry-count"), null)
    assert.equal(typeof init?.body, "string")
    assert.deepEqual(JSON.parse(String(init?.body)), request)
    return Response.json({ error: "PRIVATE_ERROR_BODY" }, { status: 529, headers: { "retry-after": "5" } })
  })
  try {
    await assert.rejects(evaluate(request, options()), (error: unknown) => {
      assert.ok(error instanceof GovernanceEvaluatorFailure)
      assert.equal(error.transient, true)
      assert.equal(error.retryAfterMs, 5000)
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE|SYNTHETIC_KEY/)
      return true
    })
    assert.equal(calls, 1)
    assert.deepEqual(logs, [])
  } finally {
    Object.assign(console, originals)
    for (const [key, value] of Object.entries({ TYPESAFE_LOG_LEVEL: oldLogLevel, TYPESAFE_BASE_URL: oldBase, TYPESAFE_DEFAULT_MODEL: oldModel })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test("real SDK adapter plus admission performs at most two network attempts, and never retries credential failures", async () => {
  for (const status of [429, 500, 529, 401, 403, 422]) {
    let calls = 0
    const evaluate = createTypeSafeGovernanceEvaluator(async () => {
      calls++
      return Response.json({ error: "PRIVATE_ERROR" }, { status, headers: { "retry-after-ms": "0" } })
    })
    const admission = createGovernanceAdmission({ organizationId: "org_test_org", protocol: "openai_chat", body: { messages: [{ role: "user", content: "synthetic" }] },
      signal: new AbortController().signal, resolve: governanceFixture().resolve, evaluate })
    try { await assert.rejects(admission.check(), { code: "openwork_gateway_governance_unavailable" }) } finally { admission.dispose() }
    assert.equal(calls, status === 429 || status >= 500 ? 2 : 1)
  }
})

test("SDK connection failure can retry once, successful retry still requires complete validated answers", async () => {
  let calls = 0
  const evaluate = createTypeSafeGovernanceEvaluator(async () => {
    if (++calls === 1) throw new TypeError("PRIVATE_CONNECTION_MESSAGE")
    return Response.json({ model: governanceModel, answers: { p0: { type: "noul", noul: 0 } } })
  })
  const admission = createGovernanceAdmission({ organizationId: "org_test_org", protocol: "openai_chat", body: { messages: [{ role: "user", content: "synthetic" }] },
    signal: new AbortController().signal, resolve: governanceFixture().resolve, evaluate })
  try { await admission.check(); await admission.recheck() } finally { admission.dispose() }
  assert.equal(calls, 2)
})

test("SDK response body and waiting network request are bounded and abort signal reaches transport", async () => {
  const evaluate = createTypeSafeGovernanceEvaluator(async () => new Response("PRIVATE".repeat(20_000)))
  await assert.rejects(evaluate(request, options()), GovernanceEvaluatorFailure)
  let receivedSignal: AbortSignal | null | undefined
  const slow = createTypeSafeGovernanceEvaluator(async (_url, init) => {
    receivedSignal = init?.signal
    return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("PRIVATE_ABORT_BODY")), { once: true }))
  })
  const controller = new AbortController()
  const pending = slow(request, { ...options(), signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, GovernanceEvaluatorFailure)
  assert.equal(receivedSignal?.aborted, true)
})

test("Retry-After supports milliseconds, seconds, dates and refuses invalid/unbounded delays", () => {
  const now = Date.parse("2026-01-01T00:00:00Z")
  assert.equal(governanceRetryAfter(new Headers({ "retry-after-ms": "250" }), now), 250)
  assert.equal(governanceRetryAfter(new Headers({ "retry-after": "2" }), now), 2000)
  assert.equal(governanceRetryAfter(new Headers({ "retry-after": "Thu, 01 Jan 2026 00:00:03 GMT" }), now), 3000)
  assert.equal(governanceRetryAfter(new Headers({ "retry-after": "broken" }), now), Infinity)
  assert.equal(governanceRetryAfter(new Headers({ "retry-after-ms": "-1" }), now), Infinity)
})

test("per-member, per-organization and global concurrency are bounded without queueing", async () => {
  const releases: Array<() => void> = []
  const guarded = guardGatewayGovernanceEvaluator(async () => new Promise((resolve) => { releases.push(() => resolve({})) }))
  const pending = [guarded(request, options()), guarded(request, options())]
  await assert.rejects(guarded(request, options()), GovernanceEvaluatorFailure)
  pending.push(guarded(request, { ...options(), memberId: "second" }), guarded(request, { ...options(), memberId: "second" }))
  await assert.rejects(guarded(request, { ...options(), memberId: "third" }), GovernanceEvaluatorFailure)
  for (let index = 0; index < 28; index++) pending.push(guarded(request, { ...options(), organizationId: `org_${index}` }))
  await assert.rejects(guarded(request, { ...options(), organizationId: "org_overflow" }), GovernanceEvaluatorFailure)
  releases.forEach((release) => release())
  await Promise.all(pending)
  const last = guarded(request, options())
  releases.at(-1)?.()
  await last
})

test("scoped circuit breaks repeated evaluator failures and expires; one organization does not block another", async () => {
  let now = 0
  let calls = 0
  const guarded = guardGatewayGovernanceEvaluator(async () => { calls++; throw new GovernanceEvaluatorFailure(true) }, () => now)
  for (let index = 0; index < 3; index++) await assert.rejects(guarded(request, options()), GovernanceEvaluatorFailure)
  await assert.rejects(guarded(request, options()), GovernanceEvaluatorFailure)
  assert.equal(calls, 3)
  await assert.rejects(guarded(request, { ...options(), organizationId: "other_org" }), GovernanceEvaluatorFailure)
  assert.equal(calls, 4)
  now = 15_001
  await assert.rejects(guarded(request, options()), GovernanceEvaluatorFailure)
  assert.equal(calls, 5)
})
