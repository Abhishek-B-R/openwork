import { randomBytes } from "node:crypto"
import { and, eq, isNull, gt, desc } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable, GatewayProviderTable, LlmProviderTable, LlmProviderModelTable, LlmProviderMemberCredentialTable, MemberTable, OAuthAccessTokenTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { HeadlessActor, HeadlessAuthority, HeadlessSurface } from "@openwork-ee/headless-execution/contract"
import { HeadlessError } from "@openwork-ee/headless-execution/schema"
import { db } from "../db.js"
import { DEN_MCP_FIRST_PARTY_CLIENT_ID, DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX, DEN_MCP_RESOURCE } from "../auth.js"
import { env } from "../env.js"
import { normalizeOrganizationCapabilities } from "../organization-capabilities.js"
import { ensureMemberGatewayKey } from "../gateway-keys.js"
import { organizationAllowsManagedModels } from "../inference.js"
import { hashOpaqueMcpSecret } from "../mcp/auth.js"
import { gatewaySummary } from "../llm/gateway-matrix.js"
import { memberGatewayTeams } from "../llm/inference-provider-lifecycle.js"
import { decodeProviderCredential, readProviderEnvNames } from "../llm/provider-credentials.js"
import { listAccessibleLlmProviderAccess } from "../routes/org/llm-provider-access.js"

function record(value:unknown):value is Record<string,unknown> {return typeof value==="object" && value!==null && !Array.isArray(value)}
export function assertHeadlessFlags(metadata:Record<string,unknown>|string|null, surface:HeadlessSurface) {
  const flags=normalizeOrganizationCapabilities(metadata)
  let parsed:unknown=metadata
  if(typeof metadata==="string") {try{parsed=JSON.parse(metadata)}catch{parsed=null}}
  const raw=record(parsed) && record(parsed.capabilities)?parsed.capabilities:{}
  if(!flags.headlessAutomation || !(surface==="workbot"?flags.workbot:raw.slackAssistant===true)) throw new HeadlessError("headless_disabled", "Blocked by your team. A platform admin can enable this assistant.")
}
async function member(actor:HeadlessActor) {
  const organizationId=normalizeDenTypeId("organization",actor.organizationId)
  const memberId=normalizeDenTypeId("member",actor.memberId)
  const [row]=await db.select({member:MemberTable,metadata:OrganizationTable.metadata}).from(MemberTable)
    .innerJoin(OrganizationTable,eq(OrganizationTable.id,MemberTable.organizationId))
    .where(and(eq(MemberTable.id,memberId),eq(MemberTable.organizationId,organizationId),isNull(MemberTable.removedAt))).limit(1)
  if(!row?.member.userId) throw new HeadlessError("membership_lost","Your team membership is unavailable. Sign in again.")
  return {...row, member:{...row.member,userId:row.member.userId}}
}
function nativePackage(config:Record<string,unknown>) {
  const packages:Record<string,string>={"@ai-sdk/openai":"@opencode-ai/ai/providers/openai","@ai-sdk/openai-compatible":"@opencode-ai/ai/providers/openai-compatible","@ai-sdk/anthropic":"@opencode-ai/ai/providers/anthropic"}
  return typeof config.npm==="string"?packages[config.npm]:undefined
}
async function selectModel(actor:HeadlessActor) {
  const row=await member(actor)
  const teams=await memberGatewayTeams(db,row.member.organizationId,row.member.id)
  // Gateway summaries are the same granted model/group/credential choices used by Den.
  for(const provider of await db.select().from(GatewayProviderTable).where(and(eq(GatewayProviderTable.organization_id,row.member.organizationId),eq(GatewayProviderTable.status,"active")))) {
    const summary=await gatewaySummary(provider,row.member.id,env.betterAuthUrl,false)
    const packageName=nativePackage(summary.providerConfig)
    const model=summary.models[0]
    const options=summary.providerConfig.options
    if(packageName && model && record(options) && typeof options.baseURL==="string") return {providerId:provider.id,modelId:model.id,baseUrl:options.baseURL,apiKey:await ensureMemberGatewayKey({organizationId:row.member.organizationId,memberId:row.member.id}),package:packageName}
  }
  const grants=await listAccessibleLlmProviderAccess({organizationId:row.member.organizationId,currentMemberId:row.member.id,teamIds:teams.map(team=>team.id)})
  for(const grant of grants) {
    const [provider]=await db.select().from(LlmProviderTable).where(and(eq(LlmProviderTable.id,grant.llmProviderId),eq(LlmProviderTable.organizationId,row.member.organizationId))).limit(1)
    if(!provider || provider.source==="openwork" && !await organizationAllowsManagedModels(row.member.organizationId)) continue
    const packageName=nativePackage(provider.providerConfig)
    const options=provider.providerConfig.options
    const baseUrl=record(options) && typeof options.baseURL==="string"?options.baseURL:typeof provider.providerConfig.api==="string"?provider.providerConfig.api:null
    if(!packageName || !baseUrl) continue
    const [model]=await db.select().from(LlmProviderModelTable).where(eq(LlmProviderModelTable.llmProviderId,provider.id)).limit(1)
    if(!model) continue
    let secret=provider.apiKey
    if(provider.credentialMode==="per_member") {
      const [credential]=await db.select().from(LlmProviderMemberCredentialTable).where(and(eq(LlmProviderMemberCredentialTable.llmProviderId,provider.id),eq(LlmProviderMemberCredentialTable.orgMembershipId,row.member.id),eq(LlmProviderMemberCredentialTable.organizationId,row.member.organizationId),eq(LlmProviderMemberCredentialTable.state,"active"))).limit(1)
      secret=credential?.secret ?? null
    }
    const decoded=decodeProviderCredential(secret)
    const apiKey=decoded.apiKey ?? readProviderEnvNames(provider.providerConfig).map(key=>decoded.apiKeys?.[key]).find(Boolean)
    if(apiKey) return {providerId:provider.providerId,modelId:model.modelId,baseUrl,apiKey,package:packageName}
  }
  throw new HeadlessError("model_unavailable","No usable team model is connected. Ask your workspace admin to connect a model.")
}
export const denHeadlessAuthority:HeadlessAuthority={
  async authorize(actor,surface) {assertHeadlessFlags((await member(actor)).metadata,surface)},
  async validateCredentials(actor, credentials) {
    const model = await selectModel(actor)
    const row=await member(actor)
    const [session]=await db.select({id:AuthSessionTable.id}).from(AuthSessionTable).where(and(eq(AuthSessionTable.userId,row.member.userId),gt(AuthSessionTable.expiresAt,new Date()))).limit(1)
    if(!session) throw new HeadlessError("sign_in_required","Sign in to reconnect your team tools before running this assistant.")
    const allowed=record(row.metadata) && Array.isArray(row.metadata.headlessReadCapabilities) ? row.metadata.headlessReadCapabilities.filter((value):value is string=>typeof value==="string") : []
    if(JSON.stringify(allowed)!==JSON.stringify(credentials.readCapabilities ?? [])) throw new HeadlessError("read_access_changed","Your team approved actions changed. Try again.")
    if (JSON.stringify(model) !== JSON.stringify(credentials.model)) throw new HeadlessError("model_access_changed", "Your team model access changed. Try again with the current model.")
  },
  async credentials(actor) {
    const row=await member(actor)
    const model=await selectModel(actor)
    // Existing first-party MCP grants stay session-coupled. Never invent a service identity.
    const [session]=await db.select().from(AuthSessionTable).where(and(eq(AuthSessionTable.userId,row.member.userId),gt(AuthSessionTable.expiresAt,new Date()))).orderBy(desc(AuthSessionTable.createdAt)).limit(1)
    if(!session) throw new HeadlessError("sign_in_required","Sign in to reconnect your team tools before running this assistant.")
    const secret=randomBytes(32).toString("base64url")
    await db.insert(OAuthAccessTokenTable).values({id:createDenTypeId("oauthAccessToken"),token:hashOpaqueMcpSecret(secret),clientId:DEN_MCP_FIRST_PARTY_CLIENT_ID,sessionId:session.id,userId:row.member.userId,referenceId:row.member.organizationId,expiresAt:new Date(Date.now()+300000),scopes:JSON.stringify(["mcp:read","mcp:write"])})
    const readCapabilities=record(row.metadata) && Array.isArray(row.metadata.headlessReadCapabilities) ? row.metadata.headlessReadCapabilities.filter((value):value is string=>typeof value==="string") : []
    return {readCapabilities,mcpUrl:`${DEN_MCP_RESOURCE.replace(/\/$/,"")}/agent`,mcpToken:`${DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX}${secret}`,model}
  },
}
