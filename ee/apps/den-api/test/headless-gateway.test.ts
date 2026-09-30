import { afterAll, beforeEach, expect, mock, test } from "bun:test";
process.env.DATABASE_URL = "mysql://fixture:fixture@127.0.0.1:1/not_connected";
process.env.GATEWAY_ENABLED = "false";
process.env.DEN_DB_ENCRYPTION_KEY = "x".repeat(32);
process.env.BETTER_AUTH_SECRET = "y".repeat(32);
process.env.BETTER_AUTH_URL = "http://127.0.0.1:8790";
const { GatewayProviderTable, MemberTable } =
  await import("@openwork-ee/den-db/schema");
const { createDenTypeId } = await import("@openwork-ee/utils/typeid");
const actor = {
  organizationId: createDenTypeId("organization"),
  memberId: createDenTypeId("member"),
};
const userId = createDenTypeId("user");
const providerId = createDenTypeId("inferenceProvider");
let metadata: Record<string, unknown> = {};
let gatewayRows: Array<{ id: string }> = [];
let summaries: Record<
  string,
  {
    providerConfig: Record<string, unknown>;
    models: Array<{
      id: string;
      upstreamModelId: string;
      config: Record<string, unknown>;
    }>;
  }
> = {};
let minted = 0;
const tables: unknown[] = [];
function query(table: unknown) {
  tables.push(table);
  const values = () =>
    table === MemberTable
      ? [{ member: { ...actor, id: actor.memberId, userId }, metadata }]
      : table === GatewayProviderTable
        ? gatewayRows
        : [];
  const builder = {
    innerJoin: () => builder,
    where: () => builder,
    limit: async () => values(),
    then: (
      resolve: (value: unknown[]) => unknown,
      reject: (reason: unknown) => unknown,
    ) => Promise.resolve(values()).then(resolve, reject),
  };
  return builder;
}
mock.module("../src/db.js", () => ({
  db: { select: () => ({ from: query }) },
}));
mock.module("../src/auth.js", () => ({
  DEN_MCP_FIRST_PARTY_CLIENT_ID: "fixture-client",
  DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX: "fixture_",
  DEN_MCP_RESOURCE: "https://tools.example.test/mcp",
}));
mock.module("../src/mcp/auth.js", () => ({
  hashOpaqueMcpSecret: () => "fixture-digest",
}));
mock.module("../src/gateway-keys.js", () => ({
  ensureMemberGatewayKey: async () => {
    minted++;
    return "fixture-key";
  },
}));
mock.module("../src/llm/gateway-matrix.js", () => ({
  gatewaySummary: async (provider: { id: string }) => summaries[provider.id],
}));
const { selectHeadlessModel, denHeadlessAuthority } =
  await import("../src/headless/authority.js");
function models(packageName = "@ai-sdk/openai-compatible") {
  gatewayRows = [{ id: providerId }];
  summaries[providerId] = {
    providerConfig: {
      npm: packageName,
      options: {
        baseURL: `https://gateway.example.test/api/v1/providers/${providerId}`,
      },
    },
    models: [
      {
        id: "alias-expensive",
        upstreamModelId: "large",
        config: {
          cost: { input: 10, output: 10 },
          limit: { context: 64000, output: 8000 },
        },
      },
      {
        id: "alias-cheap",
        upstreamModelId: "small",
        config: {
          cost: { input: 1, output: 2 },
          limit: { context: 32000, output: 4000 },
        },
      },
      {
        id: "alias-no-tools",
        upstreamModelId: "text-only",
        config: { tool_call: false, cost: { input: 0, output: 0 } },
      },
    ],
  };
}
beforeEach(() => {
  metadata = {};
  gatewayRows = [];
  summaries = {};
  minted = 0;
  tables.length = 0;
});
afterAll(() => mock.restore());
test("legacy providers never substitute for an unavailable Gateway grant", async () => {
  await expect(selectHeadlessModel(actor)).rejects.toMatchObject({
    code: "model_unavailable",
  });
  expect(
    tables.every(
      (table) => table === MemberTable || table === GatewayProviderTable,
    ),
  ).toBe(true);
  expect(minted).toBe(0);
});
test("selects the cheapest usable granted model and bounds its output", async () => {
  models();
  expect(await selectHeadlessModel(actor)).toMatchObject({
    providerId,
    modelId: "alias-cheap",
    apiKey: "fixture-key",
    limits: { context: 32000, output: 2048 },
  });
  expect(minted).toBe(1);
});
test("availability reads never mint or rotate member Gateway credentials", async () => {
  models();
  await denHeadlessAuthority.ready?.(actor);
  expect(minted).toBe(0);
});
test("an administrator model preference must still have a usable member grant", async () => {
  models();
  metadata = { headlessModel: { providerId, modelId: "large" } };
  expect(await selectHeadlessModel(actor, false)).toMatchObject({
    modelId: "alias-expensive",
  });
  metadata = { headlessModel: { providerId, modelId: "not-granted" } };
  await expect(selectHeadlessModel(actor)).rejects.toMatchObject({
    code: "model_unavailable",
  });
  expect(minted).toBe(0);
});
test("uses the four native adapters already supported by the desktop", async () => {
  for (const [sdk, native] of [
    ["@ai-sdk/openai", "openai"],
    ["@ai-sdk/openai-compatible", "openai-compatible"],
    ["@ai-sdk/anthropic", "anthropic"],
    ["@openrouter/ai-sdk-provider", "openrouter"],
  ]) {
    models(sdk);
    expect((await selectHeadlessModel(actor, false)).package).toBe(
      `@opencode-ai/ai/providers/${native}`,
    );
  }
  models("unsupported-adapter");
  await expect(selectHeadlessModel(actor)).rejects.toMatchObject({
    code: "model_unavailable",
  });
});
