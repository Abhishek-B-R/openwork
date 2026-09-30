import { randomBytes } from "node:crypto";
import { and, eq, isNull, gt, desc } from "@openwork-ee/den-db/drizzle";
import {
  AuthSessionTable,
  GatewayProviderTable,
  GatewayKeyTable,
  MemberTable,
  OAuthAccessTokenTable,
  OrganizationTable,
} from "@openwork-ee/den-db/schema";
import {
  gatewayBearerKey,
  gatewayBearerKeyMatchesDigest,
} from "@openwork-ee/utils/gateway-bearer-key";
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid";
import type {
  HeadlessActor,
  HeadlessAuthority,
  HeadlessSurface,
} from "@openwork-ee/headless-execution/contract";
import { HeadlessError } from "@openwork-ee/headless-execution/schema";
import { db } from "../db.js";
import {
  DEN_MCP_FIRST_PARTY_CLIENT_ID,
  DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX,
  DEN_MCP_RESOURCE,
} from "../auth.js";
import { env } from "../env.js";
import { normalizeOrganizationCapabilities } from "../organization-capabilities.js";
import { ensureMemberGatewayKey } from "../gateway-keys.js";
import { hashOpaqueMcpSecret } from "../mcp/auth.js";
import { gatewaySummary } from "../llm/gateway-matrix.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function assertHeadlessFlags(
  metadata: Record<string, unknown> | string | null,
  surface: HeadlessSurface,
) {
  const flags = normalizeOrganizationCapabilities(metadata);
  let parsed: unknown = metadata;
  if (typeof metadata === "string") {
    try {
      parsed = JSON.parse(metadata);
    } catch {
      parsed = null;
    }
  }
  const raw =
    record(parsed) && record(parsed.capabilities) ? parsed.capabilities : {};
  if (
    !flags.headlessAutomation ||
    !(surface === "workbot" ? flags.workbot : raw.slackAssistant === true)
  )
    throw new HeadlessError(
      "headless_disabled",
      "Blocked by your team. A platform admin can enable this assistant.",
    );
}
async function member(actor: HeadlessActor) {
  const organizationId = normalizeDenTypeId(
    "organization",
    actor.organizationId,
  );
  const memberId = normalizeDenTypeId("member", actor.memberId);
  const [row] = await db
    .select({ member: MemberTable, metadata: OrganizationTable.metadata })
    .from(MemberTable)
    .innerJoin(
      OrganizationTable,
      eq(OrganizationTable.id, MemberTable.organizationId),
    )
    .where(
      and(
        eq(MemberTable.id, memberId),
        eq(MemberTable.organizationId, organizationId),
        isNull(MemberTable.removedAt),
      ),
    )
    .limit(1);
  if (!row?.member.userId)
    throw new HeadlessError(
      "membership_lost",
      "Your team membership is unavailable. Sign in again.",
    );
  return { ...row, member: { ...row.member, userId: row.member.userId } };
}
function nativePackage(config: Record<string, unknown>) {
  const packages: Record<string, string> = {
    "@ai-sdk/openai": "@opencode-ai/ai/providers/openai",
    "@ai-sdk/openai-compatible": "@opencode-ai/ai/providers/openai-compatible",
    "@ai-sdk/anthropic": "@opencode-ai/ai/providers/anthropic",
    "@openrouter/ai-sdk-provider": "@opencode-ai/ai/providers/openrouter",
  };
  return typeof config.npm === "string" ? packages[config.npm] : undefined;
}
export async function selectHeadlessModel(
  actor: HeadlessActor,
  withCredential = true,
) {
  const row = await member(actor);
  const candidates: Array<{
    providerId: string;
    modelId: string;
    upstreamModelId: string;
    cost: number;
    baseUrl: string;
    package: string;
    limits?: { context: number; output: number };
  }> = [];
  for (const provider of await db
    .select()
    .from(GatewayProviderTable)
    .where(
      and(
        eq(GatewayProviderTable.organization_id, row.member.organizationId),
        eq(GatewayProviderTable.status, "active"),
      ),
    )) {
    const summary = await gatewaySummary(
      provider,
      row.member.id,
      env.gatewayPublicBaseUrl,
      false,
    );
    const packageName = nativePackage(summary.providerConfig);
    const options = summary.providerConfig.options;
    if (!packageName || !record(options) || typeof options.baseURL !== "string")
      continue;
    for (const model of summary.models) {
      if (model.config.tool_call === false) continue;
      const prices = model.config.cost;
      const cost =
        record(prices) &&
        typeof prices.input === "number" &&
        typeof prices.output === "number"
          ? prices.input + prices.output
          : Infinity;
      const limit = model.config.limit;
      const limits =
        record(limit) &&
        typeof limit.context === "number" &&
        typeof limit.output === "number" &&
        limit.context > 0 &&
        limit.output > 0
          ? { context: limit.context, output: Math.min(2048, limit.output) }
          : undefined;
      candidates.push({
        providerId: provider.id,
        modelId: model.id,
        upstreamModelId: model.upstreamModelId,
        cost,
        baseUrl: options.baseURL,
        package: packageName,
        ...(limits ? { limits } : {}),
      });
    }
  }
  const preferred =
    record(row.metadata) && record(row.metadata.headlessModel)
      ? row.metadata.headlessModel
      : null;
  const selected = candidates
    .filter(
      (model) =>
        !preferred ||
        (model.providerId === preferred.providerId &&
          (model.modelId === preferred.modelId ||
            model.upstreamModelId === preferred.modelId)),
    )
    .sort(
      (a, b) =>
        a.cost - b.cost ||
        a.upstreamModelId.localeCompare(b.upstreamModelId) ||
        a.modelId.localeCompare(b.modelId),
    )[0];
  if (selected)
    return {
      providerId: selected.providerId,
      modelId: selected.modelId,
      baseUrl: selected.baseUrl,
      package: selected.package,
      ...(selected.limits ? { limits: selected.limits } : {}),
      apiKey: withCredential
        ? await ensureMemberGatewayKey({
            organizationId: row.member.organizationId,
            memberId: row.member.id,
          })
        : "",
    };
  throw new HeadlessError(
    "model_unavailable",
    "Connect a usable AI Gateway model for your team to chat with Workbot.",
  );
}
export const denHeadlessAuthority: HeadlessAuthority = {
  async authorize(actor, surface) {
    assertHeadlessFlags((await member(actor)).metadata, surface);
  },
  async ready(actor) {
    await selectHeadlessModel(actor, false);
  },
  async validateCredentials(actor, credentials) {
    const model = await selectHeadlessModel(actor, false);
    const row = await member(actor);
    const [session] = await db
      .select({ id: AuthSessionTable.id })
      .from(AuthSessionTable)
      .where(
        and(
          eq(AuthSessionTable.userId, row.member.userId),
          gt(AuthSessionTable.expiresAt, new Date()),
          credentials.mcpSessionId
            ? eq(AuthSessionTable.id, normalizeDenTypeId("session", credentials.mcpSessionId))
            : undefined,
        ),
      )
      .limit(1);
    if (!session)
      throw new HeadlessError(
        "sign_in_required",
        "Sign in to reconnect your team tools before running this assistant.",
      );
    const allowed =
      record(row.metadata) &&
      Array.isArray(row.metadata.headlessReadCapabilities)
        ? row.metadata.headlessReadCapabilities.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
    if (
      JSON.stringify(allowed) !==
      JSON.stringify(credentials.readCapabilities ?? [])
    )
      throw new HeadlessError(
        "read_access_changed",
        "Your team approved actions changed. Try again.",
      );
    const [key] = await db
      .select({ hash: GatewayKeyTable.key_hash })
      .from(GatewayKeyTable)
      .where(
        and(
          eq(GatewayKeyTable.organization_id, row.member.organizationId),
          eq(GatewayKeyTable.org_membership_id, row.member.id),
          eq(GatewayKeyTable.status, "active"),
          isNull(GatewayKeyTable.revoked_at),
        ),
      )
      .limit(1);
    if (
      !key ||
      !(await gatewayBearerKeyMatchesDigest(
        gatewayBearerKey(credentials.model.apiKey),
        key.hash,
      ))
    )
      throw new HeadlessError(
        "model_access_changed",
        "Your AI Gateway access changed. Try again.",
      );
    if (
      JSON.stringify(model) !==
      JSON.stringify({ ...credentials.model, apiKey: "" })
    )
      throw new HeadlessError(
        "model_access_changed",
        "Your team model access changed. Try again with the current model.",
      );
  },
  async credentials(actor) {
    const row = await member(actor);
    const model = await selectHeadlessModel(actor);
    // Existing first-party MCP grants stay session-coupled. Never invent a service identity.
    const [session] = await db
      .select()
      .from(AuthSessionTable)
      .where(
        and(
          eq(AuthSessionTable.userId, row.member.userId),
          gt(AuthSessionTable.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(AuthSessionTable.createdAt))
      .limit(1);
    if (!session)
      throw new HeadlessError(
        "sign_in_required",
        "Sign in to reconnect your team tools before running this assistant.",
      );
    const secret = randomBytes(32).toString("base64url");
    await db
      .insert(OAuthAccessTokenTable)
      .values({
        id: createDenTypeId("oauthAccessToken"),
        token: hashOpaqueMcpSecret(secret),
        clientId: DEN_MCP_FIRST_PARTY_CLIENT_ID,
        sessionId: session.id,
        userId: row.member.userId,
        referenceId: row.member.organizationId,
        expiresAt: new Date(Date.now() + 300000),
        scopes: JSON.stringify(["mcp:read", "mcp:write"]),
      });
    const readCapabilities =
      record(row.metadata) &&
      Array.isArray(row.metadata.headlessReadCapabilities)
        ? row.metadata.headlessReadCapabilities.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
    return {
      readCapabilities,
      mcpSessionId: session.id,
      mcpUrl: `${DEN_MCP_RESOURCE.replace(/\/$/, "")}/agent`,
      mcpToken: `${DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX}${secret}`,
      model,
    };
  },
};
