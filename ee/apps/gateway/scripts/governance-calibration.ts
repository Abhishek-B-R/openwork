import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { z } from "zod"
import type { GatewayGovernancePolicy } from "@openwork/types/den/gateway-governance"
import { getGatewayGovernancePolicySetBudget } from "@openwork-ee/utils/gateway-governance"
import { buildGovernanceQuestions } from "../src/governance.js"
import { createTypeSafeGovernanceEvaluator, GovernanceEvaluatorFailure, governanceModel, type EvaluateGatewayGovernance, type GovernanceEvaluationRequest } from "../src/governance-evaluator.js"
import { assertGovernanceInputBudget, type GovernanceContributionState } from "../src/governance-input.js"

export const CALIBRATION_TIMEOUT_MS = 10_000
export const CALIBRATION_MAX_CONCURRENCY = 4
export const DEFAULT_DATASET_PATH = fileURLToPath(new URL("./governance-calibration-dataset.json", import.meta.url))
export const DEFAULT_OUT_MD = "/Users/openworklondon/code/docs/gateway/governance-calibration.md"
export const DEFAULT_OUT_JSON = "/Users/openworklondon/code/docs/gateway/governance-calibration-scores.json"
export const FOCUS_TAGS = ["multilingual", "injection", "redacted", "code", "long"]
const FAKE_EVALUATOR_KEY = "offline-fake-evaluator"
const POLICY_TIMESTAMP = "2026-01-01T00:00:00.000Z"
const GRID = Array.from({ length: 101 }, (_value, index) => index)
const EPSILON = 1e-12

export type CalibrationTargets = { maxFalseBlockRate: number; minPrecision: number; maxMissRate: number }
export const DEFAULT_TARGETS: CalibrationTargets = { maxFalseBlockRate: 0.02, minPrecision: 0.95, maxMissRate: 0.05 }

const policyKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/)
const datasetSchema = z.object({
  schemaVersion: z.literal(1),
  synthetic: z.literal(true),
  description: z.string(),
  policies: z.array(z.object({ key: policyKeySchema, name: z.string().trim().min(1).max(120), guidance: z.string().trim().min(1).max(600) }).strict()).min(1).max(20),
  contributions: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    text: z.string().min(1),
    labels: z.record(z.string(), z.boolean()),
    tags: z.array(z.string().min(1)),
  }).strict()).min(1),
}).strict().superRefine((dataset, context) => {
  const keys = dataset.policies.map((policy) => policy.key)
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", message: "Policy keys must be unique" })
  const ids = dataset.contributions.map((contribution) => contribution.id)
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "Contribution ids must be unique" })
  for (const contribution of dataset.contributions) {
    const labelKeys = Object.keys(contribution.labels)
    if (labelKeys.length !== keys.length || keys.some((key) => !Object.hasOwn(contribution.labels, key))) {
      context.addIssue({ code: "custom", message: `Contribution ${contribution.id} must label every policy exactly once` })
    }
  }
})
export type CalibrationDataset = z.infer<typeof datasetSchema>

const scoredItemSchema = z.object({
  id: z.string(),
  tags: z.array(z.string()),
  labels: z.record(z.string(), z.boolean()),
  scores: z.record(z.string(), z.number().finite().min(0).max(1)),
}).strict()
export type ScoredItem = z.infer<typeof scoredItemSchema>
const failureSchema = z.object({ id: z.string(), reason: z.enum(["transient", "rejected", "timeout", "invalid_answer", "error"]) }).strict()
export type ScoringFailure = z.infer<typeof failureSchema>
const scoresFileSchema = z.object({
  schemaVersion: z.literal(1),
  synthetic: z.literal(true),
  mode: z.enum(["live", "fake"]),
  model: z.string(),
  scoredAt: z.string(),
  dataset: z.object({ size: z.number().int().min(0), sha256: z.string() }).strict(),
  policies: z.array(z.object({ key: z.string(), name: z.string() }).strict()).min(1),
  items: z.array(scoredItemSchema),
  failures: z.array(failureSchema),
  summary: z.unknown().optional(),
}).strict().superRefine((file, context) => {
  const keys = file.policies.map((policy) => policy.key)
  for (const item of file.items) {
    if (keys.some((key) => !Object.hasOwn(item.labels, key) || !Object.hasOwn(item.scores, key))) {
      context.addIssue({ code: "custom", message: `Scored item ${item.id} must include a label and a score for every policy` })
    }
  }
})
export type ScoresFile = z.infer<typeof scoresFileSchema>

export class CalibrationInputError extends Error {}

export function parseDataset(value: unknown): CalibrationDataset {
  const parsed = datasetSchema.safeParse(value)
  if (!parsed.success) throw new CalibrationInputError(`Invalid calibration dataset: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`)
  const dataset = parsed.data
  if (!getGatewayGovernancePolicySetBudget(calibrationPolicies(dataset)).publishable) throw new CalibrationInputError("Calibration policy set exceeds the runtime policy budget")
  const questions = buildGovernanceQuestions(calibrationPolicies(dataset))
  for (const contribution of dataset.contributions) {
    try { assertGovernanceInputBudget(calibrationState(contribution.text), questions) }
    catch { throw new CalibrationInputError(`Contribution ${contribution.id} exceeds the runtime input budget`) }
  }
  return dataset
}

export function loadDataset(path = DEFAULT_DATASET_PATH): { dataset: CalibrationDataset; sha256: string } {
  const raw = readFileSync(path, "utf8")
  return { dataset: parseDataset(JSON.parse(raw)), sha256: createHash("sha256").update(raw, "utf8").digest("hex") }
}

export function parseScoresFile(value: unknown): ScoresFile {
  const parsed = scoresFileSchema.safeParse(value)
  if (!parsed.success) throw new CalibrationInputError(`Invalid scores file: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`)
  return parsed.data
}

/** Same ordering the runtime resolver uses for active policies (sorted by id), so p0..pN map identically. */
export function calibrationPolicies(dataset: Pick<CalibrationDataset, "policies">): GatewayGovernancePolicy[] {
  return dataset.policies
    .map((policy): GatewayGovernancePolicy => ({ id: policy.key, name: policy.name, guidance: policy.guidance, status: "active", revision: 1, createdAt: POLICY_TIMESTAMP, updatedAt: POLICY_TIMESTAMP }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function calibrationState(text: string): GovernanceContributionState {
  return { contributions: [{ text: [text] }] }
}

export function buildCalibrationRequest(dataset: Pick<CalibrationDataset, "policies">, text: string): GovernanceEvaluationRequest {
  return { model: governanceModel, state: calibrationState(text), questions: buildGovernanceQuestions(calibrationPolicies(dataset)) }
}

const answersSchema = z.object({
  model: z.literal(governanceModel),
  answers: z.record(z.string(), z.object({ type: z.literal("noul"), noul: z.number().finite().min(0).max(1) }).strict()),
})

/** Returns scores keyed by policy key, or null unless there is exactly one valid answer per policy. */
export function parseCalibrationAnswers(result: unknown, orderedPolicyKeys: readonly string[]): Record<string, number> | null {
  const parsed = answersSchema.safeParse(result)
  if (!parsed.success) return null
  const questionKeys = orderedPolicyKeys.map((_key, index) => `p${index}`)
  const answers = parsed.data.answers
  if (Object.keys(answers).length !== questionKeys.length || questionKeys.some((key) => !Object.hasOwn(answers, key))) return null
  return Object.fromEntries(orderedPolicyKeys.map((key, index) => [key, answers[`p${index}`].noul]))
}

export async function scoreDataset(input: {
  dataset: CalibrationDataset
  evaluate: EvaluateGatewayGovernance
  apiKey: string
  concurrency?: number
  timeoutMs?: number
  onProgress?: (done: number, total: number, failures: number) => void
  sleep?: (ms: number) => Promise<void>
}): Promise<{ items: ScoredItem[]; failures: ScoringFailure[] }> {
  const concurrency = Math.max(1, Math.min(CALIBRATION_MAX_CONCURRENCY, Math.floor(input.concurrency ?? CALIBRATION_MAX_CONCURRENCY)))
  const timeoutMs = Math.min(CALIBRATION_TIMEOUT_MS, input.timeoutMs ?? CALIBRATION_TIMEOUT_MS)
  const sleep = input.sleep ?? ((ms: number) => delay(ms))
  const orderedKeys = calibrationPolicies(input.dataset).map((policy) => policy.id)
  const questions = buildGovernanceQuestions(calibrationPolicies(input.dataset))
  const contributions = input.dataset.contributions
  type Outcome = { item: ScoredItem } | { failure: ScoringFailure }

  const scoreOne = async (contribution: CalibrationDataset["contributions"][number]): Promise<Outcome> => {
    const request: GovernanceEvaluationRequest = { model: governanceModel, state: calibrationState(contribution.text), questions }
    for (let attempt = 0; attempt < 2; attempt++) {
      const signal = AbortSignal.timeout(timeoutMs)
      let result: unknown
      try {
        result = await input.evaluate(request, { organizationId: "calibration", memberId: "calibration", apiKey: input.apiKey, signal, timeoutMs })
      } catch (error) {
        const transient = error instanceof GovernanceEvaluatorFailure && error.transient
        const wait = error instanceof GovernanceEvaluatorFailure ? error.retryAfterMs ?? 500 : Infinity
        if (attempt === 0 && transient && Number.isFinite(wait) && wait <= timeoutMs) {
          await sleep(wait)
          continue
        }
        const reason: ScoringFailure["reason"] = signal.aborted ? "timeout" : transient ? "transient" : error instanceof GovernanceEvaluatorFailure ? "rejected" : "error"
        return { failure: { id: contribution.id, reason } }
      }
      const scores = parseCalibrationAnswers(result, orderedKeys)
      if (!scores) return { failure: { id: contribution.id, reason: "invalid_answer" } }
      return { item: { id: contribution.id, tags: contribution.tags, labels: contribution.labels, scores } }
    }
    return { failure: { id: contribution.id, reason: "transient" } }
  }

  const outcomes: Outcome[] = new Array(contributions.length)
  let next = 0
  let done = 0
  let failures = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, contributions.length) }, async () => {
    while (next < contributions.length) {
      const index = next++
      const outcome = await scoreOne(contributions[index])
      outcomes[index] = outcome
      done++
      if ("failure" in outcome) failures++
      input.onProgress?.(done, contributions.length, failures)
    }
  }))
  return {
    items: outcomes.flatMap((outcome) => "item" in outcome ? [outcome.item] : []),
    failures: outcomes.flatMap((outcome) => "failure" in outcome ? [outcome.failure] : []),
  }
}

function fraction(seed: string) {
  return createHash("sha256").update(seed).digest().readUInt32BE(0) / 0x1_0000_0000
}

/** Deterministic, offline score model used by --fake and tests. It never touches the network. */
export function fakeCalibrationScore(contribution: Pick<CalibrationDataset["contributions"][number], "id" | "labels" | "tags">, policyKey: string) {
  const h = fraction(`${contribution.id}:${policyKey}`)
  const has = (tag: string) => contribution.tags.includes(tag)
  let score: number
  if (contribution.labels[policyKey]) score = has("injection") ? 0.45 + 0.5 * h : has("multilingual") ? 0.65 + 0.35 * h : 0.8 + 0.2 * h
  else score = has("boundary") ? 0.05 + 0.6 * h : has("multilingual") ? 0.25 * h : 0.12 * h
  return Math.round(score * 1000) / 1000
}

const fakeRequestSchema = z.object({
  model: z.string(),
  state: z.object({ contributions: z.array(z.object({ text: z.array(z.string()) })) }),
  questions: z.record(z.string(), z.object({ type: z.literal("noul"), instructions: z.string() })),
})

export function createFakeTransport(dataset: CalibrationDataset): typeof fetch {
  const byText = new Map(dataset.contributions.map((contribution) => [contribution.text, contribution]))
  return async (_url, init) => {
    const request = fakeRequestSchema.safeParse(JSON.parse(typeof init?.body === "string" ? init.body : "null"))
    if (!request.success) return Response.json({ error: "invalid request" }, { status: 400 })
    const contribution = byText.get(request.data.state.contributions.flatMap((entry) => entry.text).join("\n"))
    const answers = Object.fromEntries(Object.entries(request.data.questions).map(([questionKey, question]) => {
      const policy = dataset.policies.find((candidate) => question.instructions.endsWith(candidate.guidance))
      return [questionKey, { type: "noul", noul: contribution && policy ? fakeCalibrationScore(contribution, policy.key) : 0 }]
    }))
    return Response.json({ model: governanceModel, answers })
  }
}

type Observation = { score: number; positive: boolean }
export type BlockPoint = { blockMin: number; blocked: number; truePositives: number; falsePositives: number; precision: number | null; recall: number | null; falseBlockRate: number | null }
export type PassPoint = { passMax: number; passedViolations: number; passedAllowed: number; missRate: number | null; allowedPassRate: number | null }
export type ThresholdCurve = { positives: number; negatives: number; block: BlockPoint[]; pass: PassPoint[] }
export type PairMetrics = {
  passMax: number
  blockMin: number
  total: number
  blocked: number
  falseBlocks: number
  missed: number
  uncertain: number
  precision: number | null
  recall: number | null
  falseBlockRate: number | null
  missRate: number | null
  uncertainRate: number | null
  allowedUncertainRate: number | null
  violationUncertainRate: number | null
}
export type Recommendation =
  | { feasible: true; pair: PairMetrics }
  | { feasible: false; reasons: string[]; closest: Array<PairMetrics & { shortfall: number }> }
export type TagBreakdown = { tag: string; items: number; violating: number; allowed: number; blockedViolations: number; falseBlocks: number; missed: number; uncertain: number; allowedPassed: number }
export type CalibrationReport = {
  meta: { synthetic: true; mode: ScoresFile["mode"]; model: string; scoredAt: string; analyzedAt: string; datasetSize: number; datasetSha256: string; scored: number; failures: ScoringFailure[]; violating: number; allowed: number; policies: ScoresFile["policies"] }
  targets: CalibrationTargets
  overall: ThresholdCurve
  perPolicy: Record<string, ThresholdCurve>
  recommendation: Recommendation
  evaluatedPair: PairMetrics | null
  perPolicyAtPair: Record<string, PairMetrics>
  perTag: TagBreakdown[]
}

const threshold = (index: number) => index / 100
const rate = (numerator: number, denominator: number) => denominator > 0 ? numerator / denominator : null

type Counts = { positives: number; negatives: number; posAtLeast: number[]; negAtLeast: number[]; posAtMost: number[]; negAtMost: number[] }

function counts(observations: readonly Observation[]): Counts {
  const result: Counts = { positives: 0, negatives: 0, posAtLeast: GRID.map(() => 0), negAtLeast: GRID.map(() => 0), posAtMost: GRID.map(() => 0), negAtMost: GRID.map(() => 0) }
  for (const observation of observations) {
    if (observation.positive) result.positives++
    else result.negatives++
    for (const index of GRID) {
      const t = threshold(index)
      if (observation.score >= t) (observation.positive ? result.posAtLeast : result.negAtLeast)[index]++
      if (observation.score <= t) (observation.positive ? result.posAtMost : result.negAtMost)[index]++
    }
  }
  return result
}

function curveFrom(c: Counts): ThresholdCurve {
  return {
    positives: c.positives,
    negatives: c.negatives,
    block: GRID.slice(1).map((index) => {
      const blocked = c.posAtLeast[index] + c.negAtLeast[index]
      return { blockMin: threshold(index), blocked, truePositives: c.posAtLeast[index], falsePositives: c.negAtLeast[index],
        precision: rate(c.posAtLeast[index], blocked), recall: rate(c.posAtLeast[index], c.positives), falseBlockRate: rate(c.negAtLeast[index], c.negatives) }
    }),
    pass: GRID.slice(0, -1).map((index) => ({ passMax: threshold(index), passedViolations: c.posAtMost[index], passedAllowed: c.negAtMost[index],
      missRate: rate(c.posAtMost[index], c.positives), allowedPassRate: rate(c.negAtMost[index], c.negatives) })),
  }
}

function pairFrom(c: Counts, passIndex: number, blockIndex: number): PairMetrics {
  const total = c.positives + c.negatives
  const blocked = c.posAtLeast[blockIndex] + c.negAtLeast[blockIndex]
  const allowedUncertain = c.negatives - c.negAtMost[passIndex] - c.negAtLeast[blockIndex]
  const violationUncertain = c.positives - c.posAtMost[passIndex] - c.posAtLeast[blockIndex]
  return {
    passMax: threshold(passIndex),
    blockMin: threshold(blockIndex),
    total,
    blocked,
    falseBlocks: c.negAtLeast[blockIndex],
    missed: c.posAtMost[passIndex],
    uncertain: allowedUncertain + violationUncertain,
    precision: rate(c.posAtLeast[blockIndex], blocked),
    recall: rate(c.posAtLeast[blockIndex], c.positives),
    falseBlockRate: rate(c.negAtLeast[blockIndex], c.negatives),
    missRate: rate(c.posAtMost[passIndex], c.positives),
    uncertainRate: rate(allowedUncertain + violationUncertain, total),
    allowedUncertainRate: rate(allowedUncertain, c.negatives),
    violationUncertainRate: rate(violationUncertain, c.positives),
  }
}

function blockMeets(c: Counts, blockIndex: number, targets: CalibrationTargets) {
  const blocked = c.posAtLeast[blockIndex] + c.negAtLeast[blockIndex]
  const precision = rate(c.posAtLeast[blockIndex], blocked)
  return precision !== null && precision + EPSILON >= targets.minPrecision && (rate(c.negAtLeast[blockIndex], c.negatives) ?? 0) <= targets.maxFalseBlockRate + EPSILON
}

function passMeets(c: Counts, passIndex: number, targets: CalibrationTargets) {
  return (rate(c.posAtMost[passIndex], c.positives) ?? 0) <= targets.maxMissRate + EPSILON
}

/**
 * Widest pass band first (largest passMax whose violation pass-through meets the target), then the blockMin above it
 * with the highest block precision; ties go to the lowest blockMin, which maximizes recall and narrows the uncertain band.
 */
function recommendThresholds(c: Counts, targets: CalibrationTargets): Recommendation {
  for (let passIndex = 99; passIndex >= 0; passIndex--) {
    if (!passMeets(c, passIndex, targets)) continue
    let best: PairMetrics | undefined
    for (let blockIndex = passIndex + 1; blockIndex <= 100; blockIndex++) {
      if (!blockMeets(c, blockIndex, targets)) continue
      const candidate = pairFrom(c, passIndex, blockIndex)
      if (!best || (candidate.precision ?? 0) > (best.precision ?? 0) + EPSILON) best = candidate
    }
    if (best) return { feasible: true, pair: best }
  }
  const reasons: string[] = []
  if (!GRID.slice(0, -1).some((index) => passMeets(c, index, targets))) reasons.push(`No passMax keeps violation pass-through at or below ${percent(targets.maxMissRate)}.`)
  if (!GRID.slice(1).some((index) => blockMeets(c, index, targets))) reasons.push(`No blockMin reaches block precision of at least ${percent(targets.minPrecision)} with false blocks at or below ${percent(targets.maxFalseBlockRate)} of allowed items.`)
  if (!reasons.length) reasons.push("Pass and block targets are each reachable, but only with passMax at or above blockMin.")
  const scored: Array<PairMetrics & { shortfall: number }> = []
  for (let passIndex = 0; passIndex <= 99; passIndex++) {
    for (let blockIndex = passIndex + 1; blockIndex <= 100; blockIndex++) {
      const pair = pairFrom(c, passIndex, blockIndex)
      const shortfall = Math.max(0, (pair.falseBlockRate ?? 0) - targets.maxFalseBlockRate)
        + Math.max(0, targets.minPrecision - (pair.precision ?? 0))
        + Math.max(0, (pair.missRate ?? 0) - targets.maxMissRate)
      scored.push({ ...pair, shortfall })
    }
  }
  scored.sort((a, b) => a.shortfall - b.shortfall || (a.uncertainRate ?? 0) - (b.uncertainRate ?? 0) || b.passMax - a.passMax || a.blockMin - b.blockMin)
  return { feasible: false, reasons, closest: scored.slice(0, 3) }
}

function itemObservations(file: ScoresFile): Observation[] {
  const keys = file.policies.map((policy) => policy.key)
  return file.items.map((item) => ({ score: Math.max(...keys.map((key) => item.scores[key])), positive: keys.some((key) => item.labels[key]) }))
}

export function analyzeScores(file: ScoresFile, targets: CalibrationTargets = DEFAULT_TARGETS, now: Date = new Date()): CalibrationReport {
  const keys = file.policies.map((policy) => policy.key)
  const itemCounts = counts(itemObservations(file))
  const policyCounts = Object.fromEntries(keys.map((key) => [key, counts(file.items.map((item) => ({ score: item.scores[key], positive: item.labels[key] })))]))
  const recommendation = recommendThresholds(itemCounts, targets)
  const evaluatedPair = recommendation.feasible ? recommendation.pair : recommendation.closest[0] ?? null
  const passIndex = evaluatedPair ? Math.round(evaluatedPair.passMax * 100) : 0
  const blockIndex = evaluatedPair ? Math.round(evaluatedPair.blockMin * 100) : 100
  const tags = [...new Set(file.items.flatMap((item) => item.tags))].sort((a, b) => {
    const rank = (tag: string) => FOCUS_TAGS.includes(tag) ? FOCUS_TAGS.indexOf(tag) : FOCUS_TAGS.length
    return rank(a) - rank(b) || a.localeCompare(b)
  })
  const perTag = tags.map((tag) => {
    const breakdown: TagBreakdown = { tag, items: 0, violating: 0, allowed: 0, blockedViolations: 0, falseBlocks: 0, missed: 0, uncertain: 0, allowedPassed: 0 }
    for (const item of file.items.filter((candidate) => candidate.tags.includes(tag))) {
      const score = Math.max(...keys.map((key) => item.scores[key]))
      const violating = keys.some((key) => item.labels[key])
      const blocked = score >= threshold(blockIndex)
      const passed = score <= threshold(passIndex)
      breakdown.items++
      if (violating) breakdown.violating++
      else breakdown.allowed++
      if (violating && blocked) breakdown.blockedViolations++
      if (!violating && blocked) breakdown.falseBlocks++
      if (violating && passed) breakdown.missed++
      if (!violating && passed) breakdown.allowedPassed++
      if (!blocked && !passed) breakdown.uncertain++
    }
    return breakdown
  })
  return {
    meta: { synthetic: true, mode: file.mode, model: file.model, scoredAt: file.scoredAt, analyzedAt: now.toISOString(), datasetSize: file.dataset.size, datasetSha256: file.dataset.sha256,
      scored: file.items.length, failures: file.failures, violating: itemCounts.positives, allowed: itemCounts.negatives, policies: file.policies },
    targets,
    overall: curveFrom(itemCounts),
    perPolicy: Object.fromEntries(keys.map((key) => [key, curveFrom(policyCounts[key])])),
    recommendation,
    evaluatedPair,
    perPolicyAtPair: evaluatedPair ? Object.fromEntries(keys.map((key) => [key, pairFrom(policyCounts[key], passIndex, blockIndex)])) : {},
    perTag,
  }
}

function percent(value: number | null) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`
}

function fixed(value: number) {
  return value.toFixed(2)
}

function table(header: string[], rows: string[][]) {
  return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n")
}

function curveTables(curve: ThresholdCurve, step: number) {
  const keep = (value: number) => Math.round(value * 100) % step === 0
  const block = table(["blockMin", "blocked", "precision", "recall", "false-block rate (allowed)"],
    curve.block.filter((point) => keep(point.blockMin)).map((point) => [fixed(point.blockMin), String(point.blocked), percent(point.precision), percent(point.recall), percent(point.falseBlockRate)]))
  const pass = table(["passMax", "violations passed", "miss rate", "allowed pass rate"],
    curve.pass.filter((point) => keep(point.passMax)).map((point) => [fixed(point.passMax), String(point.passedViolations), percent(point.missRate), percent(point.allowedPassRate)]))
  return `${block}\n\n${pass}`
}

function pairRow(label: string, pair: PairMetrics) {
  return [label, fixed(pair.passMax), fixed(pair.blockMin), percent(pair.precision), percent(pair.recall), percent(pair.falseBlockRate), percent(pair.missRate), percent(pair.uncertainRate)]
}

const pairHeader = ["scope", "passMax", "blockMin", "block precision", "block recall", "false-block rate", "violation pass-through", "uncertain band"]

export function renderMarkdown(report: CalibrationReport) {
  const { meta, targets, recommendation } = report
  const lines: string[] = []
  lines.push("# Gateway governance threshold calibration", "")
  lines.push("> **Synthetic calibration only.** Every contribution in this run is fictional, business-oriented test text written for calibration. These numbers describe how the evaluator scored this small synthetic set; they are **not** a claim about production accuracy or quality, and should be re-checked against reviewed, representative traffic before enforcing.", "")
  lines.push(`- Mode: ${meta.mode === "live" ? "live TypeSafe evaluator" : "deterministic fake evaluator (offline, no network)"}`)
  lines.push(`- Evaluator model: \`${meta.model}\``)
  lines.push(`- Scored at: ${meta.scoredAt}`)
  lines.push(`- Analyzed at: ${meta.analyzedAt}`)
  lines.push(`- Dataset: ${meta.datasetSize} synthetic contributions, ${meta.policies.length} policies (sha256 \`${meta.datasetSha256.slice(0, 16)}\`)`)
  lines.push(`- Scored: ${meta.scored} (${meta.violating} violating, ${meta.allowed} allowed); failed and excluded: ${meta.failures.length}`)
  if (meta.failures.length) lines.push(`- Failure reasons: ${Object.entries(meta.failures.reduce<Record<string, number>>((all, failure) => ({ ...all, [failure.reason]: (all[failure.reason] ?? 0) + 1 }), {})).map(([reason, count]) => `${reason} ${count}`).join(", ")}`)
  lines.push("", "## Method", "")
  lines.push("Each contribution is sent exactly as the runtime would: state `{ contributions: [{ text: [contribution] }] }` with one `noul` question per policy built by `buildGovernanceQuestions`, policies sorted by id like the runtime resolver. Every answer must be a finite number in 0..1, one per policy.", "")
  lines.push("Runtime uses one global pair: a request is **blocked** when any policy score is ≥ blockMin, **passed** when every score is ≤ passMax, and **uncertain** otherwise. Item-level metrics below use that rule (an item is a violation when any policy label is true). Per-policy metrics treat each item/policy score independently. Thresholds are searched on a 0.01 grid.", "")
  lines.push("- block precision = violating items blocked / items blocked")
  lines.push("- false-block rate = allowed items blocked / allowed items")
  lines.push("- violation pass-through (miss rate) = violating items with max score ≤ passMax / violating items")
  lines.push("- uncertain band = items neither passed nor blocked / items")
  lines.push("", "## Targets", "")
  lines.push(`- False blocks ≤ ${percent(targets.maxFalseBlockRate)} of allowed items`)
  lines.push(`- Block precision ≥ ${percent(targets.minPrecision)}`)
  lines.push(`- Violation pass-through ≤ ${percent(targets.maxMissRate)}`)
  lines.push("", "## Recommendation", "")
  if (recommendation.feasible) {
    lines.push("Targets are **met** on this synthetic set. Selected as the widest pass band that meets the pass-through target, then the blockMin above it with the highest precision (lowest such blockMin on ties).", "")
    lines.push("```sh", `GATEWAY_GOVERNANCE_PASS_MAX=${fixed(recommendation.pair.passMax)}`, `GATEWAY_GOVERNANCE_BLOCK_MIN=${fixed(recommendation.pair.blockMin)}`, "```", "")
    lines.push(table(pairHeader, [pairRow("all items", recommendation.pair)]))
  } else {
    lines.push("**Infeasible:** no single passMax/blockMin pair meets every target on this synthetic set.", "")
    for (const reason of recommendation.reasons) lines.push(`- ${reason}`)
    lines.push("", "Closest options (smallest total shortfall against the targets):", "")
    lines.push(table([...pairHeader, "shortfall"], recommendation.closest.map((pair, index) => [...pairRow(`option ${index + 1}`, pair), fixed(pair.shortfall)])))
  }
  if (report.evaluatedPair) {
    const pair = report.evaluatedPair
    lines.push("", `## Per-policy metrics at passMax ${fixed(pair.passMax)} / blockMin ${fixed(pair.blockMin)}`, "")
    lines.push(table(pairHeader, meta.policies.map((policy) => pairRow(policy.name, report.perPolicyAtPair[policy.key]))))
    lines.push("", "## Per-tag breakdown at the same pair", "")
    lines.push(table(["tag", "items", "violating", "allowed", "violations blocked", "false blocks", "violations passed", "uncertain", "allowed passed"],
      report.perTag.map((tag) => [FOCUS_TAGS.includes(tag.tag) ? `**${tag.tag}**` : tag.tag, String(tag.items), String(tag.violating), String(tag.allowed),
        String(tag.blockedViolations), String(tag.falseBlocks), String(tag.missed), String(tag.uncertain), String(tag.allowedPassed)])))
  }
  lines.push("", "## Threshold grid (item-level, runtime rule)", "")
  lines.push(curveTables(report.overall, 5))
  lines.push("", "<details><summary>Full 0.01 grid (item-level)</summary>", "", curveTables(report.overall, 1), "", "</details>")
  for (const policy of meta.policies) {
    const curve = report.perPolicy[policy.key]
    lines.push("", `### ${policy.name} (\`${policy.key}\`): ${curve.positives} violating, ${curve.negatives} allowed`, "")
    lines.push(curveTables(curve, 10))
    lines.push("", "<details><summary>Full 0.01 grid</summary>", "", curveTables(curve, 1), "", "</details>")
  }
  return `${lines.join("\n")}\n`
}

export function summarize(report: CalibrationReport) {
  return report.recommendation.feasible
    ? { feasible: true, passMax: report.recommendation.pair.passMax, blockMin: report.recommendation.pair.blockMin }
    : { feasible: false, closest: report.recommendation.closest.map((pair) => ({ passMax: pair.passMax, blockMin: pair.blockMin, shortfall: pair.shortfall })) }
}

function writeOutput(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

export type CalibrationIo = {
  env: Record<string, string | undefined>
  stdout: (line: string) => void
  stderr: (line: string) => void
  transport?: typeof fetch
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}

type Args = { mode: "live" | "fake" | "scores"; scoresPath?: string; outMd: string; outJson: string; outJsonExplicit: boolean; dataset: string; concurrency: number }

const usage = "Usage: governance-calibration (--live | --fake | --scores <scores.json>) [--out-md <path>] [--out-json <path>] [--dataset <path>] [--concurrency <1-4>]"

function parseArgs(argv: string[]): Args | string {
  const modes: Args["mode"][] = []
  let scoresPath: string | undefined
  let outMd = DEFAULT_OUT_MD
  let outJson = DEFAULT_OUT_JSON
  let outJsonExplicit = false
  let dataset = DEFAULT_DATASET_PATH
  let concurrency = CALIBRATION_MAX_CONCURRENCY
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith("--")) return undefined
      index++
      return next
    }
    if (arg === "--live") modes.push("live")
    else if (arg === "--fake") modes.push("fake")
    else if (arg === "--scores") { modes.push("scores"); scoresPath = value(); if (!scoresPath) return "--scores requires a path" }
    else if (arg === "--out-md") { const next = value(); if (!next) return "--out-md requires a path"; outMd = resolve(next) }
    else if (arg === "--out-json") { const next = value(); if (!next) return "--out-json requires a path"; outJson = resolve(next); outJsonExplicit = true }
    else if (arg === "--dataset") { const next = value(); if (!next) return "--dataset requires a path"; dataset = resolve(next) }
    else if (arg === "--concurrency") {
      const next = Number(value())
      if (!Number.isInteger(next) || next < 1 || next > CALIBRATION_MAX_CONCURRENCY) return `--concurrency must be an integer from 1 to ${CALIBRATION_MAX_CONCURRENCY}`
      concurrency = next
    } else return `Unknown argument: ${arg}`
  }
  if (modes.length !== 1) return "Choose exactly one of --live, --fake or --scores <path>"
  return { mode: modes[0], scoresPath: scoresPath ? resolve(scoresPath) : undefined, outMd, outJson, outJsonExplicit, dataset, concurrency }
}

export async function main(argv: string[], io: CalibrationIo): Promise<number> {
  const args = parseArgs(argv)
  if (typeof args === "string") {
    io.stderr(args)
    io.stderr(usage)
    return 2
  }
  const now = io.now ?? (() => new Date())
  let file: ScoresFile
  try {
    if (args.mode === "scores") {
      file = parseScoresFile(JSON.parse(readFileSync(args.scoresPath ?? "", "utf8")))
      io.stdout(`Loaded ${file.items.length} scored contributions (${file.failures.length} failures) from ${args.scoresPath}`)
    } else {
      let apiKey = FAKE_EVALUATOR_KEY
      if (args.mode === "live") {
        const key = io.env.TYPESAFE_API_KEY?.trim()
        if (!key) {
          io.stderr("Refusing --live: TYPESAFE_API_KEY is not set. No requests were sent.")
          return 2
        }
        apiKey = key
      }
      const { dataset, sha256 } = loadDataset(args.dataset)
      const evaluate = createTypeSafeGovernanceEvaluator(args.mode === "live" ? io.transport ?? globalThis.fetch : createFakeTransport(dataset))
      io.stdout(`Scoring ${dataset.contributions.length} synthetic contributions against ${dataset.policies.length} policies (mode ${args.mode}, model ${governanceModel}, concurrency ${args.concurrency})`)
      const scoredAt = now().toISOString()
      const result = await scoreDataset({
        dataset, evaluate, apiKey, concurrency: args.concurrency, sleep: io.sleep,
        onProgress: (done, total, failures) => { if (done % 10 === 0 || done === total) io.stdout(`Scored ${done}/${total} (failures ${failures})`) },
      })
      file = {
        schemaVersion: 1, synthetic: true, mode: args.mode, model: governanceModel, scoredAt,
        dataset: { size: dataset.contributions.length, sha256 },
        policies: calibrationPolicies(dataset).map((policy) => ({ key: policy.id, name: policy.name })),
        items: result.items, failures: result.failures,
      }
      if (!file.items.length) {
        io.stderr(`No contributions were scored (${file.failures.length} failures). No report written.`)
        return 1
      }
    }
  } catch (error) {
    io.stderr(error instanceof CalibrationInputError ? error.message : "Calibration input could not be read.")
    return 1
  }
  const report = analyzeScores(file, DEFAULT_TARGETS, now())
  if (args.mode !== "scores" || args.outJsonExplicit) {
    writeOutput(args.outJson, `${JSON.stringify({ ...file, summary: summarize(report) }, null, 2)}\n`)
    io.stdout(`Wrote scores: ${args.outJson}`)
  }
  writeOutput(args.outMd, renderMarkdown(report))
  io.stdout(`Wrote report: ${args.outMd}`)
  io.stdout(report.recommendation.feasible
    ? `Recommendation: passMax ${fixed(report.recommendation.pair.passMax)}, blockMin ${fixed(report.recommendation.pair.blockMin)} (targets met)`
    : `Recommendation: infeasible; closest passMax ${fixed(report.recommendation.closest[0]?.passMax ?? 0)}, blockMin ${fixed(report.recommendation.closest[0]?.blockMin ?? 1)}`)
  if (file.failures.length) io.stderr(`Warning: ${file.failures.length} contributions failed and were excluded from the analysis.`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2), {
    env: process.env,
    stdout: (line) => { process.stdout.write(`${line}\n`) },
    stderr: (line) => { process.stderr.write(`${line}\n`) },
  }).then((code) => { process.exitCode = code }, () => {
    process.stderr.write("Calibration failed unexpectedly.\n")
    process.exitCode = 1
  })
}
