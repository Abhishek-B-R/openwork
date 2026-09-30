import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createDenDb } from "@openwork-ee/den-db";
import { and, eq, inArray, sql } from "@openwork-ee/den-db/drizzle";
import {
  AuthUserTable,
  HeadlessEventTable,
  HeadlessFileTable,
  HeadlessRunTable,
  HeadlessScheduleTable,
  MemberTable,
  OrganizationTable,
} from "@openwork-ee/den-db/schema";
import { createDenTypeId } from "@openwork-ee/utils/typeid";
import {
  HeadlessError,
  HeadlessService,
  newRun,
  type HeadlessActor,
  type HeadlessAuthority,
  type HeadlessRun,
} from "@openwork-ee/headless-execution";

const url = process.env.DEN_HEADLESS_TEST_DATABASE_URL;
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    !/^\/headless_test(?:_[a-z0-9_]+)?$/.test(new URL(url).pathname))
)
  throw new Error(
    "Use an owned disposable loopback headless_test database only",
  );
process.env.DATABASE_URL =
  url ?? "mysql://fixture:fixture@127.0.0.1:1/not_connected";
process.env.DEN_DB_ENCRYPTION_KEY =
  "isolated-headless-test-encryption-key-1234567890";
process.env.BETTER_AUTH_SECRET =
  "isolated-headless-test-auth-secret-1234567890";
process.env.BETTER_AUTH_URL = "http://127.0.0.1:8790";
process.env.GATEWAY_ENABLED = "false";
const { db, client } = await import("../src/db.js");
const { DenHeadlessRepository } = await import("../src/headless/repository.js");
const second = url ? createDenDb({ databaseUrl: url, mode: "mysql" }) : null;
const firstStore = new DenHeadlessRepository(db);
const secondStore = second ? new DenHeadlessRepository(second.db) : firstStore;
const organizations: Array<typeof OrganizationTable.$inferSelect.id> = [];
const users: Array<typeof AuthUserTable.$inferSelect.id> = [];
const runIds: string[] = [];
const dbTest = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: !url }, fn);
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

before(async () => {
  if (!url || !("query" in client)) return;
  // Build exports current schema; create only the seven tables this suite owns.
  const source = await readFile(
    new URL(
      "../../../packages/den-db/dist/current-schema.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const tables = new Set([
    "organization",
    "member",
    "user",
    "headless_run",
    "headless_event",
    "headless_schedule",
    "headless_file",
  ]);
  for (const statement of source.split(";")) {
    const name = statement.match(/CREATE TABLE `([^`]+)`/)?.[1];
    if (name && tables.has(name)) {
      const [rows] = await client.query("SHOW TABLES LIKE ?", [name]);
      if (Array.isArray(rows) && !rows.length) await client.query(statement);
    }
  }
});
after(async () => {
  if (url) {
    if (runIds.length)
      await db
        .delete(HeadlessEventTable)
        .where(inArray(HeadlessEventTable.run_id, runIds));
    for (const org of organizations) {
      await db
        .delete(HeadlessRunTable)
        .where(eq(HeadlessRunTable.organization_id, org));
      await db
        .delete(HeadlessFileTable)
        .where(eq(HeadlessFileTable.organization_id, org));
      await db
        .delete(HeadlessScheduleTable)
        .where(eq(HeadlessScheduleTable.organization_id, org));
      await db.delete(MemberTable).where(eq(MemberTable.organizationId, org));
      await db.delete(OrganizationTable).where(eq(OrganizationTable.id, org));
    }
    if (users.length)
      await db.delete(AuthUserTable).where(inArray(AuthUserTable.id, users));
  }
  if ("end" in client) await client.end();
  if (second && "end" in second.client) await second.client.end();
});
async function fixture() {
  const organizationId = createDenTypeId("organization");
  organizations.push(organizationId);
  await db
    .insert(OrganizationTable)
    .values({
      id: organizationId,
      name: "Headless test workspace",
      slug: randomUUID(),
    });
  const addMember = async () => {
    const userId = createDenTypeId("user"),
      memberId = createDenTypeId("member");
    users.push(userId);
    await db
      .insert(AuthUserTable)
      .values({
        id: userId,
        name: "Test member",
        email: `${userId}@example.test`,
      });
    await db
      .insert(MemberTable)
      .values({ id: memberId, organizationId, userId });
    return { organizationId, memberId };
  };
  return { actor: await addMember(), other: await addMember() };
}
function message(actor: HeadlessActor, key = randomUUID()): HeadlessRun {
  const run = newRun(actor, {
    surface: "workbot",
    conversationKey: "main",
    idempotencyKey: key,
    prompt: "Save a short private draft",
  });
  runIds.push(run.id);
  return run;
}
async function terminal(run: HeadlessRun, owner: string) {
  run.status = "succeeded";
  run.result = "A private draft";
  run.finishedAt = new Date().toISOString();
  assert.equal(await firstStore.finish(run, owner), true);
}
dbTest(
  "independent API connections deduplicate concurrent requests and reject changed payloads",
  async () => {
    const { actor } = await fixture();
    const run = message(actor);
    const rows = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 ? firstStore : secondStore).insert(run),
      ),
    );
    assert.equal(new Set(rows.map((row) => row.id)).size, 1);
    await assert.rejects(
      () => secondStore.insert({ ...run, prompt: "Different draft" }),
      { code: "idempotency_conflict" },
    );
    assert.equal(
      (await secondStore.conversation(actor, "workbot", "main")).length,
      1,
    );
    assert.equal((await secondStore.events(run.id, 0)).length, 1);
    const stopped = await secondStore.cancel(actor, run.id);
    assert.equal(stopped?.status, "cancelled");
  },
);
dbTest(
  "organization/member isolation survives fresh repository instances without shared disk",
  async () => {
    const { actor, other } = await fixture(),
      outsider = (await fixture()).actor;
    const run = await firstStore.insert(message(actor));
    await firstStore.files(actor).write("memory.md", "Prefer short drafts");
    assert.equal(await secondStore.scoped(other, run.id), null);
    assert.equal(await secondStore.scoped(outsider, run.id), null);
    assert.deepEqual(await secondStore.files(other).list(), []);
    assert.deepEqual(await secondStore.files(outsider).list(), []);
    const restarted = new DenHeadlessRepository(second?.db ?? db);
    assert.equal((await restarted.scoped(actor, run.id))?.status, "queued");
    assert.equal(
      await restarted.files(actor).read("memory.md"),
      "Prefer short drafts",
    );
    await firstStore.cancel(actor, run.id);
  },
);
dbTest(
  "replicas claim different actors, serialize surfaces, and use database lease time",
  async () => {
    const { actor, other } = await fixture();
    await firstStore.insert(message(actor));
    await firstStore.insert({ ...message(actor), surface: "slack" });
    await firstStore.insert(message(other));
    const [one, two] = await Promise.all([
      firstStore.claim("replica-one", Date.now() + 86400000, 15000),
      secondStore.claim("replica-two", Date.now() - 86400000, 15000),
    ]);
    assert.ok(one);
    assert.ok(two);
    assert.notEqual(one.actor.memberId, two.actor.memberId);
    assert.equal(
      await firstStore.claim("replica-three", Date.now(), 15000),
      null,
    );
    assert.equal(
      await secondStore.heartbeat(
        one.id,
        "replica-one",
        Date.now() + 86400000,
        15000,
      ),
      true,
    );
    await terminal(one, "replica-one");
    await terminal(two, "replica-two");
    const next = await secondStore.claim("replica-three", Date.now(), 15000);
    assert.ok(next);
    await terminal(next, "replica-three");
  },
);
dbTest(
  "cancellation fences draft writes and late completion inside database transactions",
  async () => {
    const { actor } = await fixture();
    const initial = await firstStore.insert(message(actor)),
      claimed = await secondStore.claim("writer", Date.now(), 15000);
    assert.equal(claimed?.id, initial.id);
    assert.ok(claimed);
    const files = secondStore.files(actor, {
      runId: initial.id,
      owner: "writer",
    });
    await files.write("draft.md", "Before stopping");
    await firstStore.cancel(actor, initial.id);
    await assert.rejects(() => files.write("draft.md", "Late write"), {
      code: "lease_lost",
    });
    assert.equal(await files.read("draft.md"), "Before stopping");
    assert.equal(
      await secondStore.finish(
        { ...claimed, status: "succeeded", result: "Late result" },
        "writer",
      ),
      false,
    );
    assert.equal((await firstStore.scoped(actor, initial.id))?.result, null);
  },
);
dbTest(
  "expired workers never replay uncertain messages or resurrect cancelled output",
  async () => {
    const { actor } = await fixture(),
      run = await firstStore.insert(message(actor));
    const claimed = await firstStore.claim("expired", Date.now(), 15000);
    assert.equal(claimed?.id, run.id);
    assert.ok(claimed);
    await db
      .update(HeadlessRunTable)
      .set({ lease_until: 0 })
      .where(eq(HeadlessRunTable.id, run.id));
    assert.equal(
      await secondStore.heartbeat(run.id, "expired", Date.now(), 15000),
      false,
    );
    assert.equal(
      await secondStore.claim("replacement", Date.now(), 15000),
      null,
    );
    assert.equal(
      (await secondStore.scoped(actor, run.id))?.failure?.code,
      "worker_interrupted",
    );
    assert.equal(
      await firstStore.finish(
        { ...claimed, status: "succeeded", result: "Late" },
        "expired",
      ),
      false,
    );
    await assert.rejects(
      () =>
        firstStore
          .files(actor, { runId: run.id, owner: "expired" })
          .write("late.md", "Must be rejected"),
      { code: "lease_lost" },
    );
  },
);
dbTest(
  "cloud files enforce path/byte bounds and encrypt stored contents",
  async () => {
    const { actor } = await fixture(),
      files = firstStore.files(actor);
    for (const path of [
      "../private",
      "/etc/passwd",
      ".config/key",
      "a/../b",
      "folder\\file",
      "a/b/c/d/e/f/g.md",
    ])
      await assert.rejects(() => files.write(path, "No"));
    await assert.rejects(() => files.write("large.md", "é".repeat(50001)));
    await files.write("notes/draft.md", "Private test sentence");
    assert.equal(
      await secondStore.files(actor).read("notes/draft.md"),
      "Private test sentence",
    );
    const [row] = await db
      .select({ raw: sql<string>`${HeadlessFileTable.content}` })
      .from(HeadlessFileTable)
      .where(
        and(
          eq(HeadlessFileTable.organization_id, actor.organizationId),
          eq(HeadlessFileTable.member_id, actor.memberId),
        ),
      );
    assert.ok(row.raw.startsWith("enc:v1:"));
    assert.ok(!row.raw.includes("Private test sentence"));
  },
);
dbTest(
  "two schedulers enqueue a single durable occurrence and preserve pause/resume",
  async () => {
    const { actor } = await fixture();
    const authority: HeadlessAuthority = {
      authorize: async () => {},
      credentials: async () => {
        throw new Error("No inference used by schedule test");
      },
    };
    const one = new HeadlessService(firstStore, authority),
      two = new HeadlessService(secondStore, authority);
    const schedule = await one.createSchedule(actor, {
      title: "Daily draft",
      prompt: "Draft a plan",
      surface: "workbot",
      conversationKey: "main",
      intervalMinutes: 1440,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    await Promise.all([one.tickSchedules(), two.tickSchedules()]);
    const history = await two.conversation(actor, "workbot", "main");
    assert.equal(history.length, 1);
    runIds.push(history[0].id);
    await one.updateSchedule(actor, schedule.id, {
      paused: true,
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
    });
    await two.tickSchedules();
    assert.equal((await one.conversation(actor, "workbot", "main")).length, 1);
    await one.cancel(actor, history[0].id);
  },
);
dbTest(
  "member removal blocks cloud file commits even while a worker still owns the lease",
  async () => {
    const { actor } = await fixture(),
      run = await firstStore.insert(message(actor));
    assert.equal(
      (await firstStore.claim("member-fence", Date.now(), 15000))?.id,
      run.id,
    );
    await db
      .update(MemberTable)
      .set({ removedAt: new Date() })
      .where(eq(MemberTable.id, actor.memberId));
    await assert.rejects(
      () =>
        secondStore
          .files(actor, { runId: run.id, owner: "member-fence" })
          .write("draft.md", "No"),
      { code: "membership_lost" },
    );
    await db
      .update(MemberTable)
      .set({ removedAt: null })
      .where(eq(MemberTable.id, actor.memberId));
    await firstStore.cancel(actor, run.id);
  },
);
