import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

// Auth initializes OAuth resource seeds even when only its organization hooks are
// used. Represent already-seeded resources without opening an ambient database.
const rows = { from: () => rows, where: async () => [{ id: "fixture-resource" }] }
let existingMembers: { id: string }[] = []
const governanceTransaction = mock(async () => { throw new Error("fixture_governance_initialization_failed") })
mock.module("../src/db.js", () => ({ db: {
  select: () => ({ from: (table: unknown) => table === MemberTable ? { where: () => ({ limit: async () => existingMembers }) } : rows }),
  transaction: governanceTransaction,
} }))

let auth: typeof import("../src/auth.js")["auth"]

beforeAll(async () => {
  process.env.DATABASE_URL = "mysql://fixture:fixture@127.0.0.1:1/not_connected"
  process.env.DB_MODE = "mysql"
  process.env.GATEWAY_ENABLED = "false"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
  auth = (await import("../src/auth.js")).auth
  await auth.$context
})

afterAll(() => mock.restore())

async function beforeCreate(metadata: unknown): Promise<{ data: { metadata: unknown } } | undefined> {
  // Invoke the registered hook, not the DB-backed organization creation endpoint.
  for (const plugin of auth.options.plugins ?? []) {
    if (plugin.id === "organization") {
      return plugin.options.organizationHooks.beforeCreateOrganization({
        // Better Auth types only objects; the runtime boundary also needs malformed/string coverage.
        organization: { name: "Test Workspace", slug: "test-workspace", metadata: metadata as Record<string, unknown> },
        user: { id: "test-user", name: "Member", email: "member@example.test", emailVerified: true, createdAt: new Date(0), updatedAt: new Date(0) },
      })
    }
  }
  throw new Error("Organization hook not registered")
}

test.each([true, false, null, "true", 1, {}, []].map((value) => ({ value })))("public creation strips obsolete gatewayDashboard value %s without retaining enable semantics", async ({ value }) => {
  const metadata = { label: "preserved", capabilities: { gatewayDashboard: value, installLinks: false, otherCapability: "preserved" } }
  for (const input of [metadata, JSON.stringify(metadata)]) {
    const result = await beforeCreate(input)
    const organization = { name: "Test Workspace", slug: "test-workspace", metadata: input, ...result?.data }
    expect(organization).toEqual({
      name: "Test Workspace",
      slug: "test-workspace",
      metadata: { label: "preserved", capabilities: { installLinks: false, otherCapability: "preserved" } },
    })
    expect(metadata.capabilities).toHaveProperty("gatewayDashboard", value)
  }
})

test("public creation drops gateway-only metadata through the hook data replacement", async () => {
  const metadata = { capabilities: { gatewayDashboard: false } }
  for (const input of [metadata, JSON.stringify(metadata)]) {
    await expect(beforeCreate(input)).resolves.toEqual({ data: { metadata: { capabilities: {} } } })
  }
})

test("ordinary metadata and other capability overrides retain their existing behavior", async () => {
  for (const metadata of [undefined, null, {}, { label: "test" }, { capabilities: {} }, { capabilities: { inference: false, desktop: true } }]) {
    await expect(beforeCreate(metadata)).resolves.toBeUndefined()
    if (metadata !== undefined) await expect(beforeCreate(JSON.stringify(metadata === null ? {} : metadata))).resolves.toBeUndefined()
  }
})

test("existing malformed metadata and dpaSigned denials are preserved", async () => {
  for (const metadata of ["not-json", "[]", "true", 42, []]) {
    await expect(beforeCreate(metadata)).rejects.toMatchObject({ status: "BAD_REQUEST" })
  }
  for (const metadata of [{ dpaSigned: true }, JSON.stringify({ dpaSigned: false }), { dpaSigned: true, capabilities: { gatewayDashboard: true } }]) {
    await expect(beforeCreate(metadata)).rejects.toMatchObject({
      status: "FORBIDDEN", body: { message: "dpaSigned is reserved for internal platform administration." },
    })
  }
})

test("public organization creation cannot self-grant a hosted governance plan", async () => {
  for (const metadata of [{ plan: { tier: "enterprise" } }, JSON.stringify({ plan: { tier: "enterprise", source: "manual" } }), { plan: null }]) {
    await expect(beforeCreate(metadata)).rejects.toMatchObject({ status: "FORBIDDEN" })
  }
})

test("first-owner creation waits for governance provisioning and propagates its failure before membership creation", async () => {
  const organizationId = createDenTypeId("organization")
  const userId = createDenTypeId("user")
  for (const plugin of auth.options.plugins ?? []) {
    if (plugin.id !== "organization") continue
    const input = {
      member: { userId, organizationId, role: "owner" },
      user: { id: userId, name: "Fixture", email: "fixture@example.test", emailVerified: true, createdAt: new Date(0), updatedAt: new Date(0) },
      organization: { id: organizationId, name: "Fixture", slug: "fixture", createdAt: new Date(0) },
    }
    existingMembers = []
    governanceTransaction.mockClear()
    await expect(plugin.options.organizationHooks.beforeAddMember(input)).rejects.toThrow("fixture_governance_initialization_failed")
    expect(governanceTransaction).toHaveBeenCalledTimes(1)
    existingMembers = [{ id: createDenTypeId("member") }]
    await expect(plugin.options.organizationHooks.beforeAddMember(input)).rejects.toMatchObject({ status: "FORBIDDEN" })
    expect(governanceTransaction).toHaveBeenCalledTimes(1)
    existingMembers = []
    await expect(plugin.options.organizationHooks.beforeAddMember({ ...input, member: { ...input.member, role: "member" } })).resolves.toBeUndefined()
    expect(governanceTransaction).toHaveBeenCalledTimes(1)
    return
  }
  throw new Error("Organization hook not registered")
})

test("public organization updates cannot replace capability metadata", async () => {
  for (const plugin of auth.options.plugins ?? []) {
    if (plugin.id !== "organization") continue
    for (const metadata of [{}, { capabilities: { gatewayDashboard: true } }, { capabilities: { gatewayDashboard: false } }]) {
      await expect(plugin.options.organizationHooks.beforeUpdateOrganization({
        organization: { metadata },
        user: { id: "test-user", name: "Member", email: "member@example.test", emailVerified: true, createdAt: new Date(0), updatedAt: new Date(0) },
        member: { id: "test-member", organizationId: "test-org", userId: "test-user", role: "owner", createdAt: new Date(0) },
      })).rejects.toMatchObject({ status: "FORBIDDEN" })
    }
    return
  }
  throw new Error("Organization hook not registered")
})
