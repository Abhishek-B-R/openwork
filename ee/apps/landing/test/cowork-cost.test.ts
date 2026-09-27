import { describe, expect, test } from "bun:test";

import {
  cumulativeCosts,
  likelyExceedsTeamLimits,
  needsPremiumSeat,
  tokenCostPerUser,
  usageProfiles,
  type CumulativeInputs
} from "../lib/cowork-cost";
import { modelPrices, type ModelPrice } from "../lib/model-prices";

const model = (price: Partial<ModelPrice>): ModelPrice => ({
  id: "test",
  provider: "test",
  providerName: "Test",
  label: "Test",
  input: 2,
  output: 10,
  cacheRead: 0.2,
  claude: false,
  ...price
});

const sonnet = model({ id: "sonnet", label: "Sonnet", input: 2, output: 10, cacheRead: 0.2, claude: true });
const cheap = model({ id: "cheap", label: "Cheap", input: 0.4, output: 0.8, cacheRead: 0.004 });
const typical = usageProfiles.typical.usage;
// 25M × (0.3 × $2 + 0.7 × $0.2) + 1.2M × $10 = $18.50 + $12 = $30.50
const sonnetTypical = 30.5;

function inputs(overrides: Partial<CumulativeInputs> = {}): CumulativeInputs {
  return { users: 50, usage: typical, tier: "team", model: sonnet, openModel: null, months: 36, ...overrides };
}

describe("token cost", () => {
  test("bills cached input at the cache-read price and the rest at the input price", () => {
    expect(tokenCostPerUser(sonnet, typical)).toBeCloseTo(sonnetTypical, 6);
  });

  test("falls back to the input price when a provider publishes no cache price", () => {
    const noCache = model({ input: 1, output: 2, cacheRead: null });
    expect(tokenCostPerUser(noCache, { inputMillions: 10, outputMillions: 1, cacheReadShare: 0.7 })).toBeCloseTo(12, 6);
  });

  test("clamps invalid shares and negative token counts", () => {
    expect(tokenCostPerUser(sonnet, { inputMillions: -5, outputMillions: -1, cacheReadShare: 2 })).toBe(0);
    expect(tokenCostPerUser(sonnet, { inputMillions: 1, outputMillions: 0, cacheReadShare: Number.NaN })).toBeCloseTo(2, 6);
  });

  test("flags Team limit risk from typical and Premium seats only above typical", () => {
    expect(likelyExceedsTeamLimits(usageProfiles.light.usage)).toBe(false);
    expect(likelyExceedsTeamLimits(typical)).toBe(true);
    expect(needsPremiumSeat(usageProfiles.light.usage)).toBe(false);
    expect(needsPremiumSeat(typical)).toBe(false);
    expect(needsPremiumSeat(usageProfiles.heavy.usage)).toBe(true);
  });
});

describe("cumulative costs", () => {
  test("compares Claude Team with OpenWork Team on the same model, annual seat price", () => {
    const result = cumulativeCosts(inputs());
    expect(result.claude.id).toBe("claude-team");
    expect(result.claudeTeamSeat).toBe("standard");
    expect(result.claude.seatsMonthly).toBe(50 * 20);
    expect(result.claude.tokensMonthly).toBe(0);
    expect(result.claude.tokensIncluded).toBe(true);
    expect(result.openwork.id).toBe("openwork-team");
    expect(result.openwork.modelLabel).toBe("Sonnet");
    expect(result.openwork.seatsBilled).toBe(45);
    expect(result.openwork.monthly).toBeCloseTo(45 * 10 + 50 * sonnetTypical, 6);
    expect(result.claude.total).toBeCloseTo(36 * 1000, 6);
  });

  test("builds cumulative points from zero, one per month", () => {
    const result = cumulativeCosts(inputs({ months: 12 }));
    expect(result.months).toBe(12);
    for (const line of [result.claude, result.openwork, result.claude3p]) {
      expect(line.points).toHaveLength(13);
      expect(line.points[0]).toBe(0);
      expect(line.points[12]).toBeCloseTo(line.total, 6);
      expect(line.points[6]).toBeCloseTo(line.monthly * 6, 6);
    }
    expect(cumulativeCosts(inputs({ months: 36 })).claude.total).toBeCloseTo(result.claude.total * 3, 6);
  });

  test("reports when OpenWork costs more instead of hiding it", () => {
    const result = cumulativeCosts(inputs());
    // Claude Team includes usage within limits; OpenWork pays tokens at API rates.
    expect(result.savings).toBeCloseTo(36 * (1000 - (450 + 50 * sonnetTypical)), 6);
    expect(result.savings).toBeLessThan(0);
    const enterprise = cumulativeCosts(inputs({ users: 200, tier: "enterprise" }));
    expect(enterprise.savings).toBeCloseTo(36 * 200 * (20 - 40), 6);
  });

  test("first 5 seats are free on OpenWork Team", () => {
    expect(cumulativeCosts(inputs({ users: 3 })).openwork.seatsMonthly).toBe(0);
    expect(cumulativeCosts(inputs({ users: 5 })).openwork.seatsMonthly).toBe(0);
    expect(cumulativeCosts(inputs({ users: 6 })).openwork.seatsMonthly).toBe(10);
    expect(cumulativeCosts(inputs({ users: 6, tier: "enterprise" })).openwork.seatsMonthly).toBe(6 * 40);
  });

  test("applies Claude seat minimums", () => {
    expect(cumulativeCosts(inputs({ users: 1 })).claude.seatsMonthly).toBe(2 * 20);
    const enterprise = cumulativeCosts(inputs({ users: 5, tier: "enterprise" }));
    expect(enterprise.claude.id).toBe("claude-enterprise");
    expect(enterprise.claude.seatsBilled).toBe(20);
    expect(enterprise.claude.monthly).toBeCloseTo(20 * 20 + 5 * sonnetTypical, 6);
  });

  test("falls back to Claude Enterprise when the team is too big for Claude Team", () => {
    const atCap = cumulativeCosts(inputs({ users: 150 }));
    expect(atCap.claude.id).toBe("claude-team");
    expect(atCap.claudeTeamUnavailable).toBe(false);
    const over = cumulativeCosts(inputs({ users: 151 }));
    expect(over.claudeTeamUnavailable).toBe(true);
    expect(over.claudeTeamSeat).toBeNull();
    expect(over.claude.id).toBe("claude-enterprise");
    expect(over.openwork.id).toBe("openwork-team");
    expect(cumulativeCosts(inputs({ users: 1000, tier: "enterprise" })).claudeTeamUnavailable).toBe(false);
  });

  test("uses Premium seats for heavy usage", () => {
    const result = cumulativeCosts(inputs({ usage: usageProfiles.heavy.usage }));
    expect(result.claudeTeamSeat).toBe("premium");
    expect(result.claude.seatsMonthly).toBe(50 * 100);
  });

  test("prices Claude Desktop on 3P as tokens only", () => {
    const result = cumulativeCosts(inputs({ users: 500, tier: "enterprise" }));
    expect(result.claude3p.seatsMonthly).toBe(0);
    expect(result.claude3p.monthly).toBeCloseTo(500 * sonnetTypical, 6);
    expect(result.claude3p.monthly).toBeLessThan(result.openwork.monthly);
  });

  test("adds an open-model line with the same seats and cheaper tokens", () => {
    expect(cumulativeCosts(inputs()).openModel).toBeNull();
    const result = cumulativeCosts(inputs({ openModel: cheap }));
    const open = result.openModel;
    if (!open) throw new Error("missing open model line");
    expect(open.modelLabel).toBe("Cheap");
    expect(open.seatsMonthly).toBe(result.openwork.seatsMonthly);
    expect(open.tokensMonthly).toBeCloseTo(50 * tokenCostPerUser(cheap, typical), 6);
    expect(result.openModelSavings).toBeCloseTo(result.claude.total - open.total, 6);
    expect(result.openModelSavings ?? 0).toBeGreaterThan(0);
  });
});

describe("model price snapshot", () => {
  test("contains the curated models with numeric prices", () => {
    const ids = modelPrices.map((entry) => entry.id);
    for (const id of ["claude-sonnet-5", "claude-opus-5-5", "deepseek-v4-pro", "glm-5.3", "gpt-6-sol", "kimi-k3"]) {
      expect(ids).toContain(id);
    }
    for (const entry of modelPrices) {
      expect(entry.input).toBeGreaterThanOrEqual(0);
      expect(entry.output).toBeGreaterThanOrEqual(0);
      expect(entry.claude).toBe(entry.provider === "anthropic");
    }
  });
});
