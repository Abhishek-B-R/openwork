import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { z } from "zod"
import {
  analyzeScores,
  buildCalibrationRequest,
  CALIBRATION_TIMEOUT_MS,
  createFakeTransport,
  loadDataset,
  main,
  parseCalibrationAnswers,
  parseDataset,
  renderMarkdown,
  scoreDataset,
  type CalibrationIo,
  type ScoresFile,
} from "../scripts/governance-calibration.js"
import { GovernanceEvaluatorFailure, governanceModel, type EvaluateGatewayGovernance } from "../src/governance-evaluator.js"
import { buildGovernanceQuestions } from "../src/governance.js"

const requestSchema = z.object({
  model: z.string(),
  state: z.object({ contributions: z.array(z.object({ text: z.array(z.string()) }).strict()) }).strict(),
  questions: z.record(z.string(), z.object({ type: z.literal("noul"), instructions: z.string() }).strict()),
}).strict()

const fixedNow = () => new Date("2026-01-02T03:04:05.000Z")

function scoresFile(items: Array<{ score: number; positive: boolean; tags?: string[] }>): ScoresFile {
  return {
    schemaVersion: 1, synthetic: true, mode: "fake", model: governanceModel, scoredAt: "2026-01-01T00:00:00.000Z",
    dataset: { size: items.length, sha256: "0".repeat(64) }, policies: [{ key: "sample", name: "Sample policy" }],
    items: items.map((item, index) => ({ id: `item-${index}`, tags: item.tags ?? [], labels: { sample: item.positive }, scores: { sample: item.score } })),
    failures: [],
  }
}

function repeat<T>(count: number, value: T): T[] {
  return Array.from({ length: count }, () => value)
}

function capture(overrides: Partial<CalibrationIo> = {}) {
  const lines: string[] = []
  const io: CalibrationIo = { env: {}, stdout: (line) => { lines.push(line) }, stderr: (line) => { lines.push(line) }, now: fixedNow, sleep: async () => {}, ...overrides }
  return { io, lines }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "governance-calibration-"))
}

test("threshold grid math: precision, recall, false-block rate, miss rate and the recommended pair", () => {
  const file = scoresFile([
    ...repeat(19, { score: 0.9, positive: true, tags: ["code"] }),
    { score: 0.4, positive: true, tags: ["injection"] },
    ...repeat(49, { score: 0.1, positive: false }),
    { score: 0.5, positive: false, tags: ["boundary"] },
  ])
  const report = analyzeScores(file, undefined, fixedNow())
  const block = (value: number) => report.overall.block.find((point) => point.blockMin === value)
  const pass = (value: number) => report.overall.pass.find((point) => point.passMax === value)
  assert.equal(report.overall.block.length, 100)
  assert.equal(report.overall.pass.length, 100)
  assert.deepEqual(block(0.5), { blockMin: 0.5, blocked: 20, truePositives: 19, falsePositives: 1, precision: 0.95, recall: 0.95, falseBlockRate: 0.02 })
  assert.deepEqual(block(0.51), { blockMin: 0.51, blocked: 19, truePositives: 19, falsePositives: 0, precision: 1, recall: 0.95, falseBlockRate: 0 })
  assert.equal(block(0.91)?.blocked, 0)
  assert.equal(block(0.91)?.precision, null)
  assert.equal(pass(0.39)?.missRate, 0)
  assert.equal(pass(0.4)?.missRate, 0.05)
  assert.equal(pass(0.9)?.missRate, 1)
  assert.equal(pass(0.1)?.allowedPassRate, 49 / 50)

  assert.equal(report.recommendation.feasible, true)
  if (!report.recommendation.feasible) return
  const pair = report.recommendation.pair
  assert.equal(pair.passMax, 0.89)
  assert.equal(pair.blockMin, 0.9)
  assert.equal(pair.precision, 1)
  assert.equal(pair.falseBlockRate, 0)
  assert.equal(pair.missRate, 0.05)
  assert.equal(pair.uncertain, 0)
  assert.deepEqual(report.perTag.find((tag) => tag.tag === "injection"), { tag: "injection", items: 1, violating: 1, allowed: 0, blockedViolations: 0, falseBlocks: 0, missed: 1, uncertain: 0, allowedPassed: 0 })
  assert.equal(report.perTag[0].tag, "injection")

  const tighter = analyzeScores(file, { maxFalseBlockRate: 0.02, minPrecision: 0.95, maxMissRate: 0 }, fixedNow())
  assert.equal(tighter.recommendation.feasible, true)
  if (!tighter.recommendation.feasible) return
  assert.equal(tighter.recommendation.pair.passMax, 0.39)
  assert.equal(tighter.recommendation.pair.blockMin, 0.51)
  assert.equal(tighter.recommendation.pair.uncertain, 2)
  assert.equal(tighter.recommendation.pair.uncertainRate, 2 / 70)
  assert.equal(tighter.recommendation.pair.allowedUncertainRate, 1 / 50)
  assert.equal(tighter.recommendation.pair.violationUncertainRate, 1 / 20)
  const markdown = renderMarkdown(tighter)
  assert.match(markdown, /GATEWAY_GOVERNANCE_PASS_MAX=0\.39/)
  assert.match(markdown, /GATEWAY_GOVERNANCE_BLOCK_MIN=0\.51/)
})

test("multi-policy items use the runtime rule: any policy score at or above blockMin blocks the request", () => {
  const file: ScoresFile = {
    ...scoresFile([]),
    policies: [{ key: "a", name: "A" }, { key: "b", name: "B" }],
    items: [
      { id: "one", tags: [], labels: { a: false, b: true }, scores: { a: 0.02, b: 0.97 } },
      { id: "two", tags: [], labels: { a: false, b: false }, scores: { a: 0.03, b: 0.04 } },
    ],
  }
  const report = analyzeScores(file, undefined, fixedNow())
  assert.equal(report.overall.positives, 1)
  assert.equal(report.overall.negatives, 1)
  assert.equal(report.overall.block.find((point) => point.blockMin === 0.97)?.truePositives, 1)
  assert.equal(report.perPolicy.a.positives, 0)
  assert.equal(report.perPolicy.b.positives, 1)
})

test("infeasible targets are reported with reasons and the closest options", () => {
  const report = analyzeScores(scoresFile([...repeat(10, { score: 0.5, positive: true }), ...repeat(10, { score: 0.5, positive: false })]), undefined, fixedNow())
  assert.equal(report.recommendation.feasible, false)
  if (report.recommendation.feasible) return
  assert.equal(report.recommendation.closest.length, 3)
  assert.ok(report.recommendation.reasons.some((reason) => reason.startsWith("No blockMin")))
  assert.ok(report.recommendation.closest.every((pair) => pair.shortfall > 0 && pair.passMax < pair.blockMin))
  assert.ok(report.evaluatedPair)
  const markdown = renderMarkdown(report)
  assert.match(markdown, /\*\*Infeasible:\*\*/)
  assert.match(markdown, /Closest options/)
  assert.doesNotMatch(markdown, /GATEWAY_GOVERNANCE_PASS_MAX=/)
})

test("--live refuses without TYPESAFE_API_KEY and sends nothing", async () => {
  for (const env of [{}, { TYPESAFE_API_KEY: "   " }]) {
    const dir = tempDir()
    let calls = 0
    const { io, lines } = capture({ env, transport: async () => { calls++; return new Response(null, { status: 500 }) } })
    try {
      const code = await main(["--live", "--out-md", join(dir, "report.md"), "--out-json", join(dir, "scores.json")], io)
      assert.equal(code, 2)
      assert.equal(calls, 0)
      assert.match(lines.join("\n"), /Refusing --live: TYPESAFE_API_KEY is not set/)
      assert.equal(existsSync(join(dir, "report.md")), false)
      assert.equal(existsSync(join(dir, "scores.json")), false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

test("--live sends runtime-shaped requests with a pinned model, bounded concurrency, and never leaks the key", async () => {
  const sentinel = "tsk_SENTINEL_DO_NOT_PRINT_9f8e7d6c5b4a"
  const { dataset } = loadDataset()
  const fake = createFakeTransport(dataset)
  const dir = tempDir()
  let calls = 0
  let inFlight = 0
  let peak = 0
  const transport: typeof fetch = async (url, init) => {
    calls++
    inFlight++
    peak = Math.max(peak, inFlight)
    try {
      assert.equal(String(url), "https://api.typesafe.ai/v1/systemone")
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${sentinel}`)
      const body = requestSchema.parse(JSON.parse(typeof init?.body === "string" ? init.body : "null"))
      assert.equal(body.model, governanceModel)
      assert.equal(Object.keys(body.questions).length, dataset.policies.length)
      assert.equal(body.state.contributions.length, 1)
      assert.equal(body.state.contributions[0].text.length, 1)
      await new Promise((resolve) => setTimeout(resolve, 1))
      return await fake(url, init)
    } finally { inFlight-- }
  }
  const consoleLines: string[] = []
  const originals = { log: console.log, debug: console.debug, info: console.info, warn: console.warn, error: console.error }
  const names: Array<"log" | "debug" | "info" | "warn" | "error"> = ["log", "debug", "info", "warn", "error"]
  for (const name of names) console[name] = (...args: unknown[]) => { consoleLines.push(args.map(String).join(" ")) }
  const { io, lines } = capture({ env: { TYPESAFE_API_KEY: sentinel }, transport })
  try {
    const code = await main(["--live", "--out-md", join(dir, "report.md"), "--out-json", join(dir, "scores.json")], io)
    assert.equal(code, 0)
    assert.equal(calls, dataset.contributions.length)
    assert.ok(peak <= 4 && peak > 1)
    const outputs = [lines.join("\n"), consoleLines.join("\n"), readFileSync(join(dir, "report.md"), "utf8"), readFileSync(join(dir, "scores.json"), "utf8")]
    for (const output of outputs) {
      assert.doesNotMatch(output, /SENTINEL|tsk_/)
      assert.doesNotMatch(output, /authorization|bearer/i)
    }
    const scores: unknown = JSON.parse(outputs[3])
    assert.ok(typeof scores === "object" && scores !== null && "mode" in scores && "items" in scores && Array.isArray(scores.items))
    assert.equal(scores.mode, "live")
    assert.equal(scores.items.length, dataset.contributions.length)
    assert.match(outputs[2], /live TypeSafe evaluator/)
    assert.match(outputs[2], /Synthetic calibration only/)
    assert.match(outputs[2], new RegExp(`${dataset.contributions.length} synthetic contributions`))
  } finally {
    Object.assign(console, originals)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("scoring retries one transient failure, never retries permanent ones, and validates every answer", async () => {
  const { dataset } = loadDataset()
  const subset = parseDataset({ ...dataset, contributions: dataset.contributions.slice(0, 5) })
  const [retried, rejected, invalid, exhausted, extra] = subset.contributions.map((contribution) => contribution.text)
  const calls = new Map<string, number>()
  const keys = [...subset.policies.map((policy) => policy.key)].sort((a, b) => a.localeCompare(b))
  const answers = (value: number) => Object.fromEntries(keys.map((_key, index) => [`p${index}`, { type: "noul", noul: value }]))
  const evaluate: EvaluateGatewayGovernance = async (request, options) => {
    assert.equal(options.timeoutMs, CALIBRATION_TIMEOUT_MS)
    assert.equal(request.model, governanceModel)
    const text = requestSchema.shape.state.parse(request.state).contributions[0].text[0]
    const count = (calls.get(text) ?? 0) + 1
    calls.set(text, count)
    if (text === retried && count === 1) throw new GovernanceEvaluatorFailure(true, 0)
    if (text === rejected) throw new GovernanceEvaluatorFailure(false)
    if (text === exhausted) throw new GovernanceEvaluatorFailure(true, 0)
    if (text === invalid) return { model: governanceModel, answers: answers(1.5) }
    if (text === extra) return { model: governanceModel, answers: { ...answers(0.2), p99: { type: "noul", noul: 0 } } }
    return { model: governanceModel, answers: answers(0.25) }
  }
  const result = await scoreDataset({ dataset: subset, evaluate, apiKey: "unused", sleep: async () => {} })
  assert.deepEqual(result.items.map((item) => item.id), [subset.contributions[0].id])
  assert.deepEqual(Object.values(result.items[0].scores), repeat(keys.length, 0.25))
  assert.deepEqual(result.failures.map((failure) => failure.reason), ["rejected", "invalid_answer", "transient", "invalid_answer"])
  assert.equal(calls.get(retried), 2)
  assert.equal(calls.get(rejected), 1)
  assert.equal(calls.get(exhausted), 2)
})

test("answer validation requires the pinned model and one finite 0..1 answer per policy", () => {
  const ok = { model: governanceModel, answers: { p0: { type: "noul", noul: 0 }, p1: { type: "noul", noul: 1 } } }
  assert.deepEqual(parseCalibrationAnswers(ok, ["a", "b"]), { a: 0, b: 1 })
  assert.equal(parseCalibrationAnswers({ ...ok, model: "other" }, ["a", "b"]), null)
  assert.equal(parseCalibrationAnswers(ok, ["a"]), null)
  assert.equal(parseCalibrationAnswers(ok, ["a", "b", "c"]), null)
  assert.equal(parseCalibrationAnswers({ ...ok, answers: { ...ok.answers, p1: { type: "noul", noul: Number.NaN } } }, ["a", "b"]), null)
  assert.equal(parseCalibrationAnswers({ ...ok, answers: { ...ok.answers, p1: { type: "noul", noul: -0.1 } } }, ["a", "b"]), null)
})

test("calibration requests match the runtime state shape and question builder", () => {
  const { dataset } = loadDataset()
  const request = buildCalibrationRequest(dataset, "hello")
  assert.deepEqual(request.state, { contributions: [{ text: ["hello"] }] })
  assert.equal(request.model, governanceModel)
  const sorted = [...dataset.policies].sort((a, b) => a.key.localeCompare(b.key))
  assert.deepEqual(request.questions, buildGovernanceQuestions(sorted.map((policy) => ({ id: policy.key, name: policy.name, guidance: policy.guidance, status: "active", revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }))))
  assert.ok(requestSchema.shape.questions.parse(request.questions).p0.instructions.endsWith(sorted[0].guidance))
})

test("dataset covers every policy, tag and language with both classes and only placeholder data", () => {
  const { dataset } = loadDataset()
  assert.ok(dataset.contributions.length >= 120)
  assert.equal(dataset.policies.length, 5)
  for (const policy of dataset.policies) {
    assert.ok(policy.guidance.length <= 600)
    const positives = dataset.contributions.filter((contribution) => contribution.labels[policy.key]).length
    assert.ok(positives >= 10, policy.key)
  }
  const both = (tag: string) => {
    const tagged = dataset.contributions.filter((contribution) => contribution.tags.includes(tag))
    return tagged.some((contribution) => Object.values(contribution.labels).some(Boolean)) && tagged.some((contribution) => !Object.values(contribution.labels).some(Boolean))
  }
  for (const tag of ["multilingual", "injection", "code", "long", "boundary", "lang:es", "lang:fr", "lang:de", "lang:ja"]) assert.ok(both(tag), tag)
  assert.ok(dataset.contributions.some((contribution) => contribution.tags.includes("redacted")))
  assert.ok(dataset.contributions.filter((contribution) => contribution.tags.includes("long")).every((contribution) => contribution.text.length >= 700))
  for (const contribution of dataset.contributions) {
    for (const email of contribution.text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []) assert.match(email, /@(?:[\w-]+\.)*example\.(?:test|com)$/, contribution.id)
    for (const key of contribution.text.match(/\b(?:sk|ghp)_[A-Za-z0-9_]{6,}/g) ?? []) assert.match(key, /FAKE0000/, contribution.id)
  }
})

test("--fake is deterministic and --scores reproduces the same report offline", async () => {
  const dir = tempDir()
  try {
    const run = async (name: string) => {
      const { io } = capture({ env: { TYPESAFE_API_KEY: "must-not-be-used" }, transport: async () => { throw new Error("network must not be used") } })
      assert.equal(await main(["--fake", "--out-md", join(dir, `${name}.md`), "--out-json", join(dir, `${name}.json`)], io), 0)
      return { md: readFileSync(join(dir, `${name}.md`), "utf8"), json: readFileSync(join(dir, `${name}.json`), "utf8") }
    }
    const first = await run("first")
    const second = await run("second")
    assert.equal(first.json, second.json)
    assert.equal(first.md, second.md)
    assert.doesNotMatch(first.json + first.md, /must-not-be-used/)
    assert.match(first.md, /deterministic fake evaluator/)
    const { io } = capture()
    assert.equal(await main(["--scores", join(dir, "first.json"), "--out-md", join(dir, "offline.md")], io), 0)
    assert.equal(readFileSync(join(dir, "offline.md"), "utf8"), first.md)
    assert.equal(existsSync(join(dir, "offline.json")), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("CLI rejects ambiguous modes and oversized concurrency", async () => {
  for (const argv of [[], ["--live", "--fake"], ["--fake", "--concurrency", "5"], ["--fake", "--unknown"], ["--scores"]]) {
    const { io } = capture()
    assert.equal(await main(argv, io), 2, argv.join(" "))
  }
})
