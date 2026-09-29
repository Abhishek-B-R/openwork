import assert from "node:assert/strict"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import {
  createGatewayGovernanceResolver, createGovernanceAdmission, createGovernanceBudget, GovernanceFailure,
  governanceFailureResponse, sameGovernanceResolution, validateGovernanceAnswers, validatedGovernanceCorrelation,
} from "../src/governance.js"
import { GovernanceEvaluatorFailure, governanceModel } from "../src/governance-evaluator.js"
import { governanceConfig, governanceFixture, knownGovernanceOff, memoryGovernanceRecords, memoryGovernanceStore, policyFixture, waitForDecisions } from "./helpers/governance-fixture.js"
import { createHmac, hkdfSync } from "node:crypto"
import { deriveGovernanceAdmissionKey, governanceAdmissionDigest, governanceAdmissionKeyInfo, governanceAdmissionTtlMs } from "../src/governance-records.js"
import { governanceExtractorVersion } from "../src/governance-input.js"
import type { EvaluateGatewayGovernance } from "../src/governance-evaluator.js"
import { gatewayGovernanceErrorSchema, hasGatewayGovernanceHttpMarker } from "@openwork/types/den/gateway-governance"

const signal = () => new AbortController().signal
const body = { messages: [{ role: "user", content: "new synthetic contribution" }] }
const answers = (scores: number[]) => ({ model: governanceModel, answers: Object.fromEntries(scores.map((noul, index) => [`p${index}`, { type: "noul", noul }])) })

function failure(code: string) {
  return (error: unknown) => error instanceof GovernanceFailure && error.code === `openwork_gateway_governance_${code}`
}

test("fresh resolver distinguishes off, enforce, empty, unknown, corrupt and unavailable; off does not inspect evaluator config", async () => {
  const fixture = governanceFixture()
  assert.equal((await fixture.resolve("org_test_org", signal())).kind, "enforce")
  fixture.state.settings.enabled = false
  const disabled = createGatewayGovernanceResolver({ loadState: async () => fixture.state, config: () => { throw new Error("Must not read evaluator configuration") } })
  assert.deepEqual(await disabled("org_test_org", signal()), { kind: "off", settingsRevision: 1 })
  for (const state of [null, {}, { ...fixture.state, settings: null }, { ...fixture.state, organizationId: "org_other" },
    { ...fixture.state, settings: { ...fixture.state.settings, enabled: "false" } },
    { ...fixture.state, settings: { ...fixture.state.settings, revision: 0 } }]) {
    const resolve = createGatewayGovernanceResolver({ loadState: async () => state, config: governanceConfig })
    assert.equal((await resolve("org_test_org", signal())).kind, "unavailable")
  }
  const broken = createGatewayGovernanceResolver({ loadState: async () => { throw new Error("PRIVATE_DB_PARAMETERS") }, config: governanceConfig })
  assert.deepEqual(await broken("org_test_org", signal()), { kind: "unavailable", internalReason: "state_unavailable" })
  const empty = governanceFixture([])
  const result = await empty.resolve("org_test_org", signal())
  assert.equal(result.kind, "enforce")
  if (result.kind === "enforce") assert.equal(result.snapshot.policies.length, 0)
})

test("hosted requires Enterprise regardless of legacy flags; enabled loss of module, readiness or entitlement never means off", async () => {
  const fixture = governanceFixture()
  for (const overrides of [
    { GATEWAY_GOVERNANCE_MODE: "disabled" },
    { TYPESAFE_API_KEY: "" },
    { GATEWAY_GOVERNANCE_PROCESSING_APPROVED: "false" },
    { GATEWAY_GOVERNANCE_PASS_MAX: undefined },
    { GATEWAY_GOVERNANCE_BLOCK_MIN: undefined },
    { GATEWAY_GOVERNANCE_MODEL: "jev-9.0.0" },
  ]) {
    const resolve = createGatewayGovernanceResolver({ loadState: async () => fixture.state, config: () => governanceConfig(overrides) })
    assert.equal((await resolve("org_test_org", signal())).kind, "unavailable")
  }
  const nonEnterprise = { ...fixture.state, metadata: { plan: { tier: "business" } } }
  const hosted = createGatewayGovernanceResolver({ loadState: async () => nonEnterprise, config: () => governanceConfig({ DEN_PLAN_GATING_ENABLED: "false" }) })
  assert.equal((await hosted("org_test_org", signal())).kind, "unavailable")
  const selfhost = createGatewayGovernanceResolver({ loadState: async () => nonEnterprise, config: () => governanceConfig({ GATEWAY_GOVERNANCE_MODE: "self_hosted_module" }) })
  assert.equal((await selfhost("org_test_org", signal())).kind, "enforce")
})

test("invalid policy snapshots, duplicate identities, >20 active policies and oversized guidance fail closed", async () => {
  const fixture = governanceFixture()
  for (const policies of [null, [policyFixture({ guidance: "x".repeat(4001) })], [policyFixture(), policyFixture()],
    [policyFixture({ revision: 0 })], [policyFixture({ name: "x".repeat(121) })],
    Array.from({ length: 21 }, (_value, index) => policyFixture({ id: `p${index}` })),
    Array.from({ length: 20 }, (_value, index) => policyFixture({ id: `p${index}`, guidance: "x".repeat(4000) }))]) {
    const resolve = createGatewayGovernanceResolver({ loadState: async () => ({ ...fixture.state, policies }), config: governanceConfig })
    assert.equal((await resolve("org_test_org", signal())).kind, "unavailable")
  }
  const drafts = governanceFixture([policyFixture({ status: "draft" }), policyFixture({ id: "archived", status: "archived" })])
  const resolution = await drafts.resolve("org_test_org", signal())
  assert.equal(resolution.kind, "enforce")
  if (resolution.kind === "enforce") assert.deepEqual(resolution.snapshot.policies, [])
})

test("one batch carries one Noul per active policy and no historical context or tool results", async () => {
  const fixture = governanceFixture([policyFixture(), policyFixture({ id: "policy_two", name: "Another exact DB name" }), policyFixture({ id: "draft", status: "draft" })])
  let calls = 0
  const admission = createGovernanceAdmission({ organizationId: "org_test_org", protocol: "openai_chat", signal: signal(), resolve: fixture.resolve,
    body: { messages: [{ role: "user", content: "OLD_PRIVATE_TEXT" }, { role: "assistant", content: "old answer" },
      { role: "user", content: "new contribution" }, { role: "assistant", tool_calls: [{ type: "function" }] },
      { role: "tool", content: "TOOL_PRIVATE_RESULT" }] },
    evaluate: async (request, options) => {
      calls++
      assert.equal(request.model, "jev-1.13.0")
      assert.deepEqual(request.state, { contributions: [{ text: ["new contribution"] }] })
      assert.deepEqual(Object.keys(request.questions), ["p0", "p1"])
      assert.ok(Object.values(request.questions).every((question) => question.type === "noul"))
      assert.ok(options.timeoutMs <= 5000 && options.timeoutMs > 0)
      assert.equal(options.signal.aborted, false)
      return answers([0.1, 0])
    },
  })
  try { await admission.check(); await admission.recheck() } finally { admission.dispose() }
  assert.equal(calls, 1)
})

test("complete finite answer validation precedes all decisions and returns exact DB names for every violation", async () => {
  const fixture = governanceFixture([policyFixture(), policyFixture({ id: "policy_two", name: "Stored policy two", revision: 7 })])
  const resolution = await fixture.resolve("org_test_org", signal())
  assert.equal(resolution.kind, "enforce")
  if (resolution.kind !== "enforce") return
  const snapshot = resolution.snapshot
  assert.doesNotThrow(() => validateGovernanceAnswers(answers([0, 0.1]), snapshot))
  for (const malformed of [undefined, {}, answers([]), answers([0]), answers([0, 0, 0]), answers([0, NaN]), answers([0, Infinity]),
    answers([0, -0.01]), answers([0, 1.01]), { ...answers([0, 0]), model: "jev-latest" },
    { model: governanceModel, answers: { p0: { type: "choice", noul: 0 }, p1: { type: "noul", noul: 0 } } },
    { model: governanceModel, answers: { p0: { type: "noul", noul: 1 } } },
    { model: governanceModel, answers: { p0: { type: "noul", noul: 0 }, wrong: { type: "noul", noul: 0 } } },
  ]) assert.throws(() => validateGovernanceAnswers(malformed, snapshot), failure("unavailable"))
  assert.throws(() => validateGovernanceAnswers(answers([0.5, 0]), snapshot), failure("uncertain"))
  assert.throws(() => validateGovernanceAnswers(answers([0.9, 1]), snapshot), (error: unknown) => {
    assert.ok(error instanceof GovernanceFailure)
    assert.equal(error.evaluationComplete, true)
    assert.deepEqual(error.violations, [
      { policy_id: "policy_one", policy_revision: 1, policy_name: "Restricted content" },
      { policy_id: "policy_two", policy_revision: 7, policy_name: "Stored policy two" },
    ])
    return failure("blocked")(error)
  })
})

test("only positively off and valid empty sets avoid evaluator calls; unsupported input still fails when enabled with zero policies", async () => {
  for (const resolve of [knownGovernanceOff, governanceFixture([]).resolve]) {
    const admission = createGovernanceAdmission({ organizationId: "org_test_org", protocol: "openai_chat", body, signal: signal(), resolve,
      evaluate: async () => { assert.fail("No evaluator request expected") } })
    try { await admission.check(); await admission.recheck() } finally { admission.dispose() }
  }
  const admission = createGovernanceAdmission({ organizationId: "org_test_org", protocol: "passthrough", body, signal: signal(), resolve: governanceFixture([]).resolve,
    evaluate: async () => { assert.fail("No evaluator request expected") } })
  try { await assert.rejects(admission.check(), failure("unsupported_input")) } finally { admission.dispose() }
})

test("one transient retry at most, Retry-After bounded by total deadline, no retries for malformed/blocked/uncertain/auth results", async () => {
  for (const [error, expected] of [
    [new GovernanceEvaluatorFailure(true, 0), 2],
    [new GovernanceEvaluatorFailure(true, 10_000), 1],
    [new GovernanceEvaluatorFailure(false), 1],
    [new Error("PRIVATE_EVALUATOR_ERROR"), 1],
  ]) {
    let calls = 0
    const admission = createGovernanceAdmission({ organizationId: "org_test_org", protocol: "openai_chat", body, signal: signal(), resolve: governanceFixture().resolve,
      evaluate: async () => { calls++; throw error } })
    try { await assert.rejects(admission.check(), failure("unavailable")) } finally { admission.dispose() }
    assert.equal(calls, expected)
  }
  for (const result of [answers([1]), answers([0.5]), {}]) {
    let calls = 0
    const admission = createGovernanceAdmission({ organizationId: "org_test_org", protocol: "openai_chat", body, signal: signal(), resolve: governanceFixture().resolve,
      evaluate: async () => { calls++; return result } })
    try { await assert.rejects(admission.check(), GovernanceFailure) } finally { admission.dispose() }
    assert.equal(calls, 1)
  }
})

test("shared deadline includes slow resolver and uncooperative evaluator; cancellation propagates", async () => {
  for (const slowResolver of [true, false]) {
    let evaluationSignal: AbortSignal | undefined
    const admission = createGovernanceAdmission({ organizationId: "org_test_org", protocol: "openai_chat", body, signal: signal(), timeoutMs: 30,
      resolve: slowResolver ? async () => new Promise(() => {}) : governanceFixture().resolve,
      evaluate: async (_request, options) => { evaluationSignal = options.signal; return new Promise(() => {}) },
    })
    const start = performance.now()
    try { await assert.rejects(admission.check(), failure("unavailable")) } finally { admission.dispose() }
    assert.ok(performance.now() - start < 1000)
    if (!slowResolver) assert.equal(evaluationSignal?.aborted, true)
  }
  const controller = new AbortController()
  const budget = createGovernanceBudget(controller.signal)
  const pending = budget.run(() => delay(1000))
  controller.abort()
  try { await assert.rejects(pending, failure("unavailable")) } finally { budget.dispose() }
})

test("governance phases share a spent-time budget but unrelated pauses do not consume it", async () => {
  for (const enabled of [false, true]) {
    const fixture = governanceFixture()
    fixture.state.settings.enabled = enabled
    let reads = 0
    let calls = 0
    let currentSignal: AbortSignal | undefined
    const admission = createGovernanceAdmission({ organizationId: "org_test_org", protocol: "openai_chat", body, signal: signal(), timeoutMs: 150,
      resolve: (id, inputSignal) => { reads++; currentSignal = inputSignal; return fixture.resolve(id, inputSignal) },
      evaluate: async () => { calls++; return answers([0]) },
    })
    try {
      await admission.check()
      await delay(200)
      assert.equal(currentSignal?.aborted, false)
      await admission.recheck()
      assert.equal(reads, 2)
      assert.equal(calls, enabled ? 1 : 0)
    } finally { admission.dispose() }
  }
  const budget = createGovernanceBudget(signal(), 150)
  try {
    await budget.run(() => delay(30))
    const remaining = budget.remaining()
    assert.ok(remaining < 150)
    await delay(200)
    assert.equal(budget.remaining(), remaining)
    assert.equal(budget.signal.aborted, false)
    await assert.rejects(budget.run(() => new Promise(() => {})), failure("unavailable"))
    assert.equal(budget.signal.aborted, true)
  } finally { budget.dispose() }
})

test("fresh lookup after an unrelated pause remains mandatory and bounded", async () => {
  let reads = 0
  const admission = createGovernanceAdmission({ organizationId: "org_test_org", protocol: "openai_chat", body, signal: signal(), timeoutMs: 100,
    resolve: async () => { if (++reads === 1) return { kind: "off", settingsRevision: 1 }; return new Promise(() => {}) },
    evaluate: async () => { assert.fail("No evaluator expected") },
  })
  try {
    await admission.check()
    await delay(150)
    await assert.rejects(admission.recheck(), failure("unavailable"))
    assert.equal(reads, 2)
  } finally { admission.dispose() }
})

test("freshness rejects off-to-on, on-to-off, policy/threshold/entitlement changes and lookup loss", async () => {
  for (const change of ["enable", "disable", "policy", "threshold", "plan", "lookup"]) {
    const fixture = governanceFixture()
    if (change === "enable") fixture.state.settings.enabled = false
    let lookupLost = false
    const admission = createGovernanceAdmission({ organizationId: "org_test_org", protocol: "openai_chat", body, signal: signal(),
      resolve: (organizationId, signal) => lookupLost ? Promise.reject(new Error("unavailable")) : fixture.resolve(organizationId, signal),
      evaluate: async () => answers([0]),
    })
    try {
      await admission.check()
      if (change === "enable") fixture.state.settings.enabled = true
      if (change === "disable") fixture.state.settings.enabled = false
      if (change === "policy") fixture.state.policies[0].guidance = "changed policy even if writer forgot revision"
      if (change === "threshold") fixture.config.passMax = 0.05
      if (change === "plan") fixture.state.metadata.plan.tier = "business"
      if (change === "lookup") lookupLost = true
      await assert.rejects(admission.recheck(), failure(change === "plan" || change === "lookup" ? "unavailable" : "policy_changed"))
    } finally { admission.dispose() }
  }
  assert.equal(sameGovernanceResolution({ kind: "off", settingsRevision: 1 }, { kind: "off", settingsRevision: 2 }), false)
})

test("validated IDs correlate errors but never authorize evaluation bypass; HTTP contract is nonretryable and no-store", () => {
  for (const value of ["bad id", "x\ny", "x".repeat(129), "", null]) assert.equal(validatedGovernanceCorrelation(value), undefined)
  assert.equal(validatedGovernanceCorrelation("msg_synthetic-1"), "msg_synthetic-1")
  const response = governanceFailureResponse(new GovernanceFailure("openwork_gateway_governance_policy_changed"), {
    requestId: "request_synthetic", decisionId: "decision_synthetic", headers: new Headers({ "x-openwork-governance-contribution-id": "msg_synthetic", "x-openwork-governance-session-id": "invalid id" }),
  })
  assert.equal(hasGatewayGovernanceHttpMarker(response), true)
  assert.equal(response.headers.get("cache-control"), "no-store")
  assert.equal(response.headers.get("x-openwork-governance-contribution-id"), "msg_synthetic")
  assert.equal(response.headers.get("x-openwork-governance-session-id"), null)
})

test("no receipt means every continuation is reevaluated, regardless of caller skip flags and correlation IDs", async () => {
  let calls = 0
  const fixture = governanceFixture()
  for (let step = 0; step < 2; step++) {
    const admission = createGovernanceAdmission({ organizationId: "org_test_org", protocol: "openai_chat", body: { ...body, already_checked: true }, signal: signal(), resolve: fixture.resolve,
      evaluate: async () => { calls++; return answers([step === 0 ? 0 : 1]) } })
    try {
      if (step === 0) await admission.check()
      else await assert.rejects(admission.check(), failure("blocked"))
    } finally { admission.dispose() }
  }
  assert.equal(calls, 2)
})

test("error payload contains no policy guidance, probabilities or evaluator bodies", async () => {
  const response = governanceFailureResponse(new GovernanceFailure("openwork_gateway_governance_uncertain", [{ policy_id: "policy_one", policy_revision: 1, policy_name: "Stored name" }], true), {
    requestId: "request_synthetic", decisionId: "decision_synthetic", headers: new Headers(),
  })
  const parsed = gatewayGovernanceErrorSchema.parse(await response.json())
  assert.equal(parsed.error.evaluation_complete, true)
  assert.equal(parsed.error.upstream_dispatched, false)
  assert.doesNotMatch(JSON.stringify(parsed), /guidance|noul|apiKey|synthetic-evaluator-key/)
})

const turn = [{ role: "user", content: "receipt synthetic text" }]
const continuationBody = (messages: unknown[] = turn) => ({ messages: [...messages, { role: "assistant", tool_calls: [{ type: "function" }] }, { role: "tool", content: "PRIVATE_TOOL_OUTPUT" }] })

async function admit(input: {
  body: unknown
  resolve: Parameters<typeof createGovernanceAdmission>[0]["resolve"]
  records?: ReturnType<typeof memoryGovernanceRecords>["records"]
  evaluate?: EvaluateGatewayGovernance
  organizationId?: string
  memberId?: string
  now?: () => Date
  between?: () => void
}) {
  let calls = 0
  const admission = createGovernanceAdmission({ organizationId: input.organizationId ?? "org_test_org", memberId: input.memberId ?? "member_a", requestId: "request_synthetic",
    route: "provider", protocol: "openai_chat", body: input.body, signal: signal(), resolve: input.resolve, records: input.records, now: input.now,
    evaluate: async (request, options) => { calls++; return input.evaluate ? input.evaluate(request, options) : answers(request.questions ? Object.keys(request.questions).map(() => 0) : []) } })
  try {
    await admission.check()
    input.between?.()
    await admission.recheck()
    return { calls, decisionId: admission.decisionId }
  } finally { admission.dispose() }
}

test("admission digest is HMAC-SHA256 over canonical scope and contribution with an HKDF-derived key", () => {
  const secret = "synthetic-db-encryption-key-for-governance-tests-0123456789"
  const expectedKey = new Uint8Array(hkdfSync("sha256", secret, new Uint8Array(0), "openwork-gateway-governance-admission-v1", 32))
  assert.equal(governanceAdmissionKeyInfo, "openwork-gateway-governance-admission-v1")
  assert.deepEqual(deriveGovernanceAdmissionKey(secret), expectedKey)
  const state = { contributions: [{ text: ["a", "b"] }] }
  const digest = governanceAdmissionDigest(expectedKey, { organizationId: "org_1", memberId: "member_1", extractorVersion: "v1", state })
  assert.match(digest, /^[0-9a-f]{64}$/)
  assert.equal(digest, createHmac("sha256", expectedKey).update('["org_1","member_1","v1",{"contributions":[{"text":["a","b"]}]}]').digest("hex"))
  for (const changed of [{ organizationId: "org_2" }, { memberId: "member_2" }, { extractorVersion: "v2" }, { state: { contributions: [{ text: ["a", "c"] }] } }]) {
    assert.notEqual(governanceAdmissionDigest(expectedKey, { organizationId: "org_1", memberId: "member_1", extractorVersion: "v1", state, ...changed }), digest)
  }
  assert.notEqual(governanceAdmissionDigest(deriveGovernanceAdmissionKey(`${secret}x`), { organizationId: "org_1", memberId: "member_1", extractorVersion: "v1", state }), digest)
})

test("an all-pass submission stores a scoped 30-minute receipt; its tool continuation is admitted without reevaluation after a policy change", async () => {
  const fixture = governanceFixture()
  const { store, records } = memoryGovernanceRecords()
  const clock = new Date("2026-09-29T12:00:00.000Z")
  const first = await admit({ body: { messages: turn }, resolve: fixture.resolve, records, now: () => clock })
  assert.equal(first.calls, 1)
  assert.equal(store.admissions.length, 1)
  const receipt = store.admissions[0]
  assert.match(receipt.digest, /^[0-9a-f]{64}$/)
  assert.equal(receipt.digest, records.digest({ organizationId: "org_test_org", memberId: "member_a", extractorVersion: governanceExtractorVersion, state: { contributions: [{ text: ["receipt synthetic text"] }] } }))
  assert.deepEqual({ ...receipt, digest: undefined }, { organizationId: "org_test_org", memberId: "member_a", digest: undefined, policySetRevision: 1,
    decisionId: first.decisionId, createdAt: clock, expiresAt: new Date(clock.getTime() + governanceAdmissionTtlMs) })
  assert.equal(governanceAdmissionTtlMs, 30 * 60_000)

  fixture.state.settings.policySetRevision = 2
  fixture.state.policies[0].guidance = "Stricter synthetic guidance"
  fixture.state.policies[0].revision = 2
  const continued = await admit({ body: continuationBody(), resolve: fixture.resolve, records, now: () => new Date(clock.getTime() + 60_000),
    between: () => { fixture.state.settings.policySetRevision = 3 } })
  assert.equal(continued.calls, 0)
  assert.equal(store.admissions.length, 1)
  const decisions = await waitForDecisions(store, 2)
  assert.deepEqual(decisions.map((row) => row.outcome), ["allowed", "receipt_reused"])
  assert.equal(decisions[1].policySetRevision, 1)
  assert.equal(decisions[1].evaluatorAttempts, 0)
  assert.equal(decisions[1].evaluatorModel, null)
})

test("receipts are never used for new submissions, other members or organizations, changed text, expired entries, or client flags", async () => {
  const fixture = governanceFixture()
  const { store, records } = memoryGovernanceRecords()
  const clock = new Date("2026-09-29T12:00:00.000Z")
  await admit({ body: { messages: turn }, resolve: fixture.resolve, records, now: () => clock })
  const otherOrg = governanceFixture()
  otherOrg.state.organizationId = "org_other"
  const cases: { name: string; input: Omit<Parameters<typeof admit>[0], "records"> }[] = [
    { name: "same text new submission", input: { body: { messages: turn, governance_receipt: store.admissions[0].digest, already_checked: true }, resolve: fixture.resolve, now: () => clock } },
    { name: "other member", input: { body: continuationBody(), resolve: fixture.resolve, memberId: "member_b", now: () => clock } },
    { name: "other organization", input: { body: continuationBody(), resolve: otherOrg.resolve, organizationId: "org_other", now: () => clock } },
    { name: "changed text", input: { body: continuationBody([{ role: "user", content: "receipt synthetic text!" }]), resolve: fixture.resolve, now: () => clock } },
    { name: "expired", input: { body: continuationBody(), resolve: fixture.resolve, now: () => new Date(clock.getTime() + governanceAdmissionTtlMs + 1) } },
  ]
  for (const entry of cases) {
    const isolated = memoryGovernanceRecords(memoryGovernanceStore())
    isolated.store.admissions.push(...store.admissions)
    const result = await admit({ ...entry.input, records: isolated.records, evaluate: async () => answers([0]) })
    assert.equal(result.calls, 1, entry.name)
    if (entry.name === "same text new submission") assert.equal(isolated.store.lookups.length, 0)
  }
  const blocked = memoryGovernanceRecords(memoryGovernanceStore())
  blocked.store.admissions.push(...store.admissions)
  const admission = createGovernanceAdmission({ organizationId: "org_test_org", memberId: "member_a", protocol: "openai_chat", body: { messages: turn }, signal: signal(),
    resolve: fixture.resolve, records: blocked.records, now: () => clock, evaluate: async () => answers([1]) })
  try { await assert.rejects(admission.check(), failure("blocked")) } finally { admission.dispose() }
  assert.equal(blocked.store.lookups.length, 0)
})

test("receipt lookup failure evaluates normally; receipt write failure still admits the passed request", async () => {
  const fixture = governanceFixture()
  const { store, records } = memoryGovernanceRecords()
  await admit({ body: { messages: turn }, resolve: fixture.resolve, records })
  store.failLookup = true
  assert.equal((await admit({ body: continuationBody(), resolve: fixture.resolve, records })).calls, 1)
  const failing = memoryGovernanceRecords()
  failing.store.failWrite = true
  failing.store.failDecision = true
  const warnings: unknown[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args) }
  try {
    assert.equal((await admit({ body: { messages: turn }, resolve: fixture.resolve, records: failing.records })).calls, 1)
    await delay(20)
  } finally { console.warn = warn }
  assert.equal(failing.store.admissions.length, 0)
  assert.doesNotMatch(JSON.stringify(warnings), /PRIVATE_|receipt synthetic text/)
  assert.ok(warnings.length >= 1)
})

test("receipt-admitted continuations need only a non-unavailable final resolution", async () => {
  for (const final of ["off", "changed", "unavailable"]) {
    const fixture = governanceFixture()
    const { records } = memoryGovernanceRecords()
    await admit({ body: { messages: turn }, resolve: fixture.resolve, records })
    let lost = false
    const resolve: typeof fixture.resolve = (id, inputSignal) => lost ? Promise.reject(new Error("PRIVATE")) : fixture.resolve(id, inputSignal)
    const run = admit({ body: continuationBody(), resolve, records, between: () => {
      if (final === "off") fixture.state.settings.enabled = false
      if (final === "changed") fixture.state.settings.policySetRevision = 9
      if (final === "unavailable") lost = true
    } })
    if (final === "unavailable") await assert.rejects(run, failure("unavailable"))
    else assert.equal((await run).calls, 0)
  }
})

test("one metadata decision row per enforced outcome with usage, attempts and route; off organizations write none", async () => {
  const fixture = governanceFixture([policyFixture(), policyFixture({ id: "policy_two", name: "Second", revision: 4 })])
  const cases: { outcome: string; evaluate: EvaluateGatewayGovernance; body?: unknown; resolve?: typeof fixture.resolve; between?: () => void }[] = [
    { outcome: "allowed", evaluate: async () => ({ ...answers([0, 0]), usage: { input_tokens: 120, output_tokens: 7 } }) },
    { outcome: "blocked", evaluate: async () => ({ ...answers([1, 0]), usage: { input_tokens: 90, output_tokens: 5 } }) },
    { outcome: "uncertain", evaluate: async () => answers([0.5, 0]) },
    { outcome: "unsupported_input", evaluate: async () => answers([0, 0]), body: { messages: [] } },
    { outcome: "unavailable", evaluate: async () => { throw new GovernanceEvaluatorFailure(false) } },
    { outcome: "policy_changed", evaluate: async () => answers([0, 0]), between: () => { fixture.state.settings.policySetRevision++ } },
  ]
  for (const entry of cases) {
    const { store, records } = memoryGovernanceRecords()
    const admission = createGovernanceAdmission({ organizationId: "org_test_org", memberId: "member_a", requestId: "request_synthetic", route: "managed", protocol: "openai_chat",
      body: entry.body ?? body, signal: signal(), resolve: fixture.resolve, records, evaluate: entry.evaluate })
    try {
      await admission.check()
      entry.between?.()
      await admission.recheck()
    } catch (error) { assert.ok(error instanceof GovernanceFailure) } finally { admission.dispose(); admission.dispose() }
    const [row, ...rest] = await waitForDecisions(store)
    await delay(10)
    assert.equal(rest.length + store.decisions.length - 1, 0, entry.outcome)
    assert.equal(row.outcome, entry.outcome)
    assert.equal(row.route, "managed")
    assert.equal(row.decisionId, admission.decisionId)
    assert.equal(row.requestId, "request_synthetic")
    assert.equal(row.memberId, "member_a")
    assert.equal(row.extractorVersion, governanceExtractorVersion)
    assert.ok(Number.isInteger(row.latencyMs) && row.latencyMs >= 0)
    assert.doesNotMatch(JSON.stringify(row), /new synthetic contribution|BLOCK_ME|guidance|"noul"|synthetic-evaluator-key/)
    if (entry.outcome === "allowed") assert.deepEqual([row.evaluatorInputTokens, row.evaluatorOutputTokens, row.evaluatorAttempts, row.evaluatorModel], [120, 7, 1, governanceModel])
    if (entry.outcome === "blocked") assert.deepEqual(row.failedPolicies, [{ id: "policy_one", revision: 1, name: "Restricted content" }])
    if (entry.outcome === "unsupported_input") assert.equal(row.evaluatorAttempts, 0)
    if (entry.outcome !== "unsupported_input") assert.deepEqual(row.policies, [{ id: "policy_one", revision: 1 }, { id: "policy_two", revision: 4 }])
  }
  const retry = memoryGovernanceRecords()
  let attempt = 0
  const retried = createGovernanceAdmission({ organizationId: "org_test_org", memberId: "member_a", protocol: "openai_chat", body, signal: signal(), resolve: fixture.resolve,
    records: retry.records, evaluate: async () => { if (attempt++ === 0) throw new GovernanceEvaluatorFailure(true, 0); return answers([0, 0]) } })
  try { await retried.check() } finally { retried.dispose() }
  assert.equal((await waitForDecisions(retry.store))[0].evaluatorAttempts, 2)
  assert.equal((await waitForDecisions(retry.store))[0].outcome, "allowed")

  const unknown = memoryGovernanceRecords()
  const unavailableResolver = createGovernanceAdmission({ organizationId: "org_test_org", protocol: "openai_chat", body, signal: signal(),
    resolve: async () => ({ kind: "unavailable", internalReason: "state_unavailable" }), records: unknown.records })
  try { await assert.rejects(unavailableResolver.check(), failure("unavailable")) } finally { unavailableResolver.dispose() }
  const [unknownRow] = await waitForDecisions(unknown.store)
  assert.deepEqual([unknownRow.outcome, unknownRow.policySetRevision, unknownRow.memberId], ["unavailable", null, null])

  const off = memoryGovernanceRecords()
  const offAdmission = createGovernanceAdmission({ organizationId: "org_test_org", memberId: "member_a", protocol: "openai_chat", body, signal: signal(), resolve: knownGovernanceOff,
    records: off.records, evaluate: async () => { assert.fail("No evaluator expected") } })
  try { await offAdmission.check(); await offAdmission.recheck() } finally { offAdmission.dispose() }
  await delay(20)
  assert.deepEqual([off.store.decisions, off.store.admissions, off.store.lookups], [[], [], []])
})
