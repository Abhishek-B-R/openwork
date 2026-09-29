import { fileURLToPath } from "node:url";
import { resolveEvalEngine, queryDenDatabase, SkipError, type Seed, type Place } from "@openwork/env";
import { governanceReplacementPrompt, governanceReplacementReply } from "@openwork/labs";
import { gatewayGovernanceOverviewSchema, gatewayGovernancePolicySchema } from "@openwork/types/den/gateway-governance";
import { engineGatewayParity, parityRecord } from "./engine-gateway-parity.ts";
export { governanceBlockedPrompt, governanceReplacementPrompt, governanceReplacementReply } from "@openwork/labs";

export async function governanceRecovery(seed: Seed, context: { place: Place }) {
  if (resolveEvalEngine() !== "v1") throw new SkipError("native v1 individual-message deletion; native v2 recovery is intentionally non-destructive");
  await using setup = new AsyncDisposableStack();
  const base = setup.use(await engineGatewayParity(seed, context, {
    governanceEnv: {
      OPENWORK_EVAL_GOVERNANCE: "1", GATEWAY_GOVERNANCE_MODE: "self_hosted_module",
      TYPESAFE_API_KEY: "synthetic-test-only", GATEWAY_GOVERNANCE_PROCESSING_APPROVED: "true",
      GATEWAY_GOVERNANCE_PASS_MAX: "0.1", GATEWAY_GOVERNANCE_BLOCK_MIN: "0.9",
    },
    gatewayImports: [fileURLToPath(new URL("../packages/labs/src/governance-evaluator-preload.mjs", import.meta.url))],
  }));
  const providerId = await base.publish();
  await base.refreshLegacyCatalog();
  const model = (await base.inventory())[0];
  if (!model) throw new Error("Missing assigned fixture model");
  await base.selectModel(model.id);
  const overview = () => seed.api(base.den.admin, "/v1/gateway-governance");
  for (const name of ["Credentials", "Personal data"]) {
    const result = await seed.api(base.den.admin, "/v1/gateway-governance/policies", { method: "POST", body: JSON.stringify({ name, guidance: `Reject the synthetic example for ${name}.` }) });
    if (result.response.status !== 201) throw new Error(`Create fixture policy: HTTP ${result.response.status}`);
    const policy = gatewayGovernancePolicySchema.parse(parityRecord(result.body).policy);
    const published = await seed.api(base.den.admin, `/v1/gateway-governance/policies/${policy.id}`, { method: "PATCH", body: JSON.stringify({ expectedRevision: policy.revision, status: "active" }) });
    if (!published.response.ok) throw new Error(`Publish fixture policy: HTTP ${published.response.status}`);
  }
  const current = gatewayGovernanceOverviewSchema.parse((await overview()).body);
  const enabled = await seed.api(base.den.admin, "/v1/gateway-governance/settings", { method: "PATCH", body: JSON.stringify({ expectedRevision: current.settings.revision, enabled: true, processingAcknowledged: true }) });
  if (!enabled.response.ok) throw new Error(`Enable fixture governance: HTTP ${enabled.response.status}`);
  await base.prepareTurn(governanceReplacementPrompt, governanceReplacementReply);
  const databaseUrl = base.den.database?.url;
  if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/openwork_eval_")) throw new Error("Expected disposable governance database");
  const sessionPath = async () => {
    const route = await base.route();
    const match = /\/workspace\/([^/]+)\/session\/([^/?#]+)/.exec(route);
    if (!match) throw new Error("Expected a native conversation route");
    return `/workspace/${match[1]}/opencode/session/${match[2]}`;
  };
  const resources = setup.move();
  return {
    app: base.app, modelName: model.name,
    requests: () => base.mock.agentRequests(),
    rejected: () => queryDenDatabase(databaseUrl, "SELECT status, error_code FROM gateway_request_logs WHERE gateway_provider_id = ? AND error_code = 'openwork_gateway_governance_blocked' AND completed_at IS NOT NULL", [providerId]),
    async messages() {
      const response = await base.request(`${await sessionPath()}/message`);
      if (response.status !== 200 || !Array.isArray(response.body)) throw new Error("Expected native messages");
      return response.body;
    },
    recovery: async () => base.request(`${await sessionPath()}/governance`),
    /** Primary model attempts the host saw for each blocked contribution. The
     * engine must never retry a governance decision, so each should be 1. */
    async primaryAttempts() {
      const response = await base.request(`${await sessionPath()}/governance`);
      const entries = parityRecord(response.body).entries;
      if (response.status !== 200 || !Array.isArray(entries)) throw new Error("Expected governance recovery entries");
      return entries.map((entry) => Object.values(parityRecord(parityRecord(entry).requestRoles)).filter((role) => role === "primary").length);
    },
    serverErrors: () => base.serverErrors(),
    decisions: async () => (await queryDenDatabase(databaseUrl, "SELECT * FROM gateway_governance_decision WHERE route = 'provider' ORDER BY created_at", [])).map((row) => {
      const record = parityRecord(row);
      return { ...record, outcome: String(record.outcome) };
    }),
    async nativeState() {
      const path = await sessionPath();
      const statuses = await base.request(`${path.slice(0, path.lastIndexOf("/session/"))}/session/status`);
      const response = await base.request(`${path}/message`);
      const messages = Array.isArray(response.body) ? response.body.map((message) => {
        const row = parityRecord(message), info = parityRecord(row.info);
        return { id: info.id, role: info.role, parentID: info.parentID, errorName: info.error ? parityRecord(info.error).name : undefined, parts: Array.isArray(row.parts) ? row.parts.map((part) => parityRecord(part).type) : [] };
      }) : [];
      return { statuses, messages };
    },
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  };
}
