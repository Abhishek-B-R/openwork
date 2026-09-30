import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  isNull,
  lte,
  sql,
} from "@openwork-ee/den-db/drizzle";
import {
  HeadlessEventTable,
  HeadlessFileTable,
  HeadlessRunTable,
  HeadlessScheduleTable,
  MemberTable,
} from "@openwork-ee/den-db/schema";
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid";
import {
  eventSchema,
  HeadlessError,
  newRun,
  runSchema,
  scheduleSchema,
  type HeadlessActor,
  type HeadlessEvent,
  type HeadlessFiles,
  type HeadlessRepository,
  type HeadlessRun,
  type HeadlessSchedule,
  type HeadlessSurface,
  type RunFence,
} from "@openwork-ee/headless-execution";
import { validateFilePath } from "@openwork-ee/headless-execution/files";
import { db } from "../db.js";
import { automationUpdateChangedRows } from "../automations/update-result.js";

type Database = typeof db;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Connection = Database | Transaction;
const databaseClock = sql<number>`ROUND(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000)`;
function scope(actor: HeadlessActor) {
  return {
    organization_id: normalizeDenTypeId("organization", actor.organizationId),
    member_id: normalizeDenTypeId("member", actor.memberId),
  };
}
function runScope(actor: HeadlessActor) {
  const ids = scope(actor);
  return and(
    eq(HeadlessRunTable.organization_id, ids.organization_id),
    eq(HeadlessRunTable.member_id, ids.member_id),
  );
}
function scheduleScope(actor: HeadlessActor) {
  const ids = scope(actor);
  return and(
    eq(HeadlessScheduleTable.organization_id, ids.organization_id),
    eq(HeadlessScheduleTable.member_id, ids.member_id),
  );
}
function fileScope(actor: HeadlessActor) {
  const ids = scope(actor);
  return and(
    eq(HeadlessFileTable.organization_id, ids.organization_id),
    eq(HeadlessFileTable.member_id, ids.member_id),
  );
}
function decode(row: { content: string } | undefined) {
  return row ? runSchema.parse(JSON.parse(row.content)) : null;
}
function fingerprint(run: HeadlessRun) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        run.prompt,
        run.conversationKey,
        run.limits ?? {},
        run.scheduleId ?? null,
      ]),
    )
    .digest("hex");
}
/** Member rows fence admission/claims/writes against each other and against offboarding. */
async function lockMember(
  tx: Transaction,
  actor: HeadlessActor,
  active = true,
) {
  const ids = scope(actor);
  const [member] = await tx
    .select({ userId: MemberTable.userId })
    .from(MemberTable)
    .where(
      and(
        eq(MemberTable.id, ids.member_id),
        eq(MemberTable.organizationId, ids.organization_id),
        active ? isNull(MemberTable.removedAt) : undefined,
      ),
    )
    .limit(1)
    .for("update");
  if (!member?.userId)
    throw new HeadlessError(
      "membership_lost",
      "Your team membership is unavailable. Sign in again.",
    );
}
async function appendEvent(
  conn: Connection,
  id: string,
  kind: HeadlessEvent["kind"],
  text: string,
) {
  await conn
    .insert(HeadlessEventTable)
    .values({
      run_id: id,
      content: JSON.stringify({
        runId: id,
        createdAt: new Date().toISOString(),
        kind,
        text: text.slice(0, 20000),
      }),
    });
}
function lease(fence: RunFence) {
  return and(
    eq(HeadlessRunTable.id, fence.runId),
    eq(HeadlessRunTable.lease_owner, fence.owner),
    eq(HeadlessRunTable.status, "running"),
    gte(HeadlessRunTable.lease_until, databaseClock),
  );
}
async function owns(conn: Connection, fence: RunFence) {
  const [row] = await conn
    .select({ id: HeadlessRunTable.id })
    .from(HeadlessRunTable)
    .where(lease(fence))
    .limit(1);
  return Boolean(row);
}
async function assertFileFence(
  tx: Transaction,
  actor: HeadlessActor,
  fence: RunFence,
) {
  await tx
    .select({ id: HeadlessRunTable.id })
    .from(HeadlessRunTable)
    .where(and(runScope(actor), eq(HeadlessRunTable.id, fence.runId)))
    .limit(1)
    .for("update");
  if (!(await owns(tx, fence)))
    throw new HeadlessError(
      "lease_lost",
      "This assistant message was stopped. Try again.",
    );
}
async function insertRun(tx: Transaction, run: HeadlessRun) {
  const digest = fingerprint(run);
  const [previous] = await tx
    .select()
    .from(HeadlessRunTable)
    .where(
      and(
        runScope(run.actor),
        eq(HeadlessRunTable.surface, run.surface),
        eq(HeadlessRunTable.idempotency_key, run.idempotencyKey),
      ),
    )
    .limit(1);
  if (previous) {
    if (previous.fingerprint !== digest)
      throw new HeadlessError(
        "idempotency_conflict",
        "This request key already belongs to a different message.",
        409,
      );
    return runSchema.parse(JSON.parse(previous.content));
  }
  const pending = await tx
    .select({ id: HeadlessRunTable.id })
    .from(HeadlessRunTable)
    .where(and(runScope(run.actor), eq(HeadlessRunTable.status, "queued")))
    .limit(20);
  if (pending.length >= 20)
    throw new HeadlessError(
      "queue_full",
      "Let your current messages finish before sending more.",
      409,
    );
  await tx
    .insert(HeadlessRunTable)
    .values({
      ...scope(run.actor),
      id: run.id,
      surface: run.surface,
      conversation_key: run.conversationKey,
      idempotency_key: run.idempotencyKey,
      fingerprint: digest,
      status: run.status,
      created_ms: Date.parse(run.createdAt),
      content: JSON.stringify(run),
    });
  await appendEvent(tx, run.id, "status", "Queued");
  return run;
}
export class DenHeadlessRepository implements HeadlessRepository {
  constructor(readonly database: Database = db) {}
  insert(run: HeadlessRun) {
    return this.database.transaction(async (tx) => {
      await lockMember(tx, run.actor);
      return insertRun(tx, run);
    });
  }
  async scoped(actor: HeadlessActor, id: string) {
    const [row] = await this.database
      .select({ content: HeadlessRunTable.content })
      .from(HeadlessRunTable)
      .where(and(runScope(actor), eq(HeadlessRunTable.id, id)))
      .limit(1);
    return decode(row);
  }
  async conversation(
    actor: HeadlessActor,
    surface: HeadlessSurface,
    key: string,
  ) {
    const rows = await this.database
      .select({ content: HeadlessRunTable.content })
      .from(HeadlessRunTable)
      .where(
        and(
          runScope(actor),
          eq(HeadlessRunTable.surface, surface),
          eq(HeadlessRunTable.conversation_key, key),
        ),
      )
      .orderBy(desc(HeadlessRunTable.created_ms), desc(HeadlessRunTable.id))
      .limit(100);
    return rows
      .map((row) => runSchema.parse(JSON.parse(row.content)))
      .reverse();
  }
  async cancel(actor: HeadlessActor, id: string) {
    return this.database.transaction(async (tx) => {
      await lockMember(tx, actor);
      const [row] = await tx
        .select()
        .from(HeadlessRunTable)
        .where(and(runScope(actor), eq(HeadlessRunTable.id, id)))
        .limit(1)
        .for("update");
      const run = decode(row);
      if (run && (run.status === "queued" || run.status === "running")) {
        run.status = "cancelled";
        run.finishedAt = new Date().toISOString();
        run.result = null;
        await tx
          .update(HeadlessRunTable)
          .set({
            status: run.status,
            content: JSON.stringify(run),
            lease_owner: null,
            lease_until: null,
          })
          .where(eq(HeadlessRunTable.id, id));
        await appendEvent(tx, id, "status", "Stopped");
      }
      return run;
    });
  }
  async event(id: string, kind: HeadlessEvent["kind"], text: string) {
    await appendEvent(this.database, id, kind, text);
  }
  async events(id: string, after: number) {
    const rows = await this.database
      .select()
      .from(HeadlessEventTable)
      .where(
        and(
          eq(HeadlessEventTable.run_id, id),
          gt(HeadlessEventTable.sequence, after),
        ),
      )
      .orderBy(asc(HeadlessEventTable.sequence))
      .limit(200);
    return rows.map((row) =>
      eventSchema.parse({ ...JSON.parse(row.content), sequence: row.sequence }),
    );
  }
  async claim(owner: string, _now: number, leaseMs: number) {
    // Use database time so replicas with different clocks cannot steal live leases.
    const expired = await this.database
      .select()
      .from(HeadlessRunTable)
      .where(
        and(
          eq(HeadlessRunTable.status, "running"),
          lte(HeadlessRunTable.lease_until, databaseClock),
        ),
      )
      .limit(50);
    for (const candidate of expired) {
      await this.database.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(HeadlessRunTable)
          .where(
            and(
              eq(HeadlessRunTable.id, candidate.id),
              eq(HeadlessRunTable.status, "running"),
              lte(HeadlessRunTable.lease_until, databaseClock),
            ),
          )
          .limit(1)
          .for("update");
        const run = decode(row);
        if (!run) return;
        run.status = "failed";
        run.finishedAt = new Date().toISOString();
        run.result = null;
        run.failure = {
          code: "worker_interrupted",
          message:
            "The worker stopped during this message. Review the draft before trying again.",
        };
        await tx
          .update(HeadlessRunTable)
          .set({
            status: run.status,
            content: JSON.stringify(run),
            lease_owner: null,
            lease_until: null,
          })
          .where(eq(HeadlessRunTable.id, run.id));
        await appendEvent(tx, run.id, "status", run.failure.message);
      });
    }
    const candidates = await this.database
      .select()
      .from(HeadlessRunTable)
      .where(
        and(
          eq(HeadlessRunTable.status, "queued"),
          sql`NOT EXISTS (SELECT 1 FROM headless_run active WHERE active.organization_id = ${HeadlessRunTable.organization_id} AND active.member_id = ${HeadlessRunTable.member_id} AND active.status = 'running')`,
        ),
      )
      .orderBy(asc(HeadlessRunTable.created_ms), asc(HeadlessRunTable.id))
      .limit(50);
    for (const candidate of candidates) {
      const admitted = await this.database.transaction(async (tx) => {
        const actor = {
          organizationId: candidate.organization_id,
          memberId: candidate.member_id,
        };
        // Removed members must still have their queued messages terminalized, not starve the queue.
        await tx
          .select({ id: MemberTable.id })
          .from(MemberTable)
          .where(
            and(
              eq(MemberTable.id, candidate.member_id),
              eq(MemberTable.organizationId, candidate.organization_id),
            ),
          )
          .limit(1)
          .for("update");
        const [row] = await tx
          .select()
          .from(HeadlessRunTable)
          .where(eq(HeadlessRunTable.id, candidate.id))
          .limit(1)
          .for("update");
        if (!row || row.status !== "queued") return null;
        const [active] = await tx
          .select({ id: HeadlessRunTable.id })
          .from(HeadlessRunTable)
          .where(and(runScope(actor), eq(HeadlessRunTable.status, "running")))
          .limit(1);
        if (active) return null;
        const run = runSchema.parse(JSON.parse(row.content));
        run.status = "running";
        run.startedAt = new Date().toISOString();
        await tx
          .update(HeadlessRunTable)
          .set({
            status: run.status,
            content: JSON.stringify(run),
            lease_owner: owner,
            lease_until: sql`${databaseClock}+${leaseMs}`,
          })
          .where(eq(HeadlessRunTable.id, run.id));
        await appendEvent(tx, run.id, "status", "Working");
        return run;
      });
      if (admitted) return admitted;
    }
    return null;
  }
  owns(id: string, owner: string) {
    return owns(this.database, { runId: id, owner });
  }
  async heartbeat(id: string, owner: string, _now: number, leaseMs: number) {
    const changed = await this.database
      .update(HeadlessRunTable)
      .set({ lease_until: sql`${databaseClock}+${leaseMs}` })
      .where(lease({ runId: id, owner }));
    return automationUpdateChangedRows(changed);
  }
  finish(run: HeadlessRun, owner: string) {
    return this.database.transaction(async (tx) => {
      await tx
        .select({ id: HeadlessRunTable.id })
        .from(HeadlessRunTable)
        .where(eq(HeadlessRunTable.id, run.id))
        .limit(1)
        .for("update");
      const changed = await tx
        .update(HeadlessRunTable)
        .set({
          status: run.status,
          content: JSON.stringify(run),
          lease_owner: null,
          lease_until: null,
        })
        .where(lease({ runId: run.id, owner }));
      if (!automationUpdateChangedRows(changed)) return false;
      await appendEvent(
        tx,
        run.id,
        run.status === "succeeded" ? "result" : "status",
        run.result ?? run.failure?.message ?? run.status,
      );
      return true;
    });
  }
  files(actor: HeadlessActor, fence?: RunFence): HeadlessFiles {
    return {
      read: async (path) => {
        validateFilePath(path);
        const [row] = await this.database
          .select({ content: HeadlessFileTable.content })
          .from(HeadlessFileTable)
          .where(and(fileScope(actor), eq(HeadlessFileTable.path, path)))
          .limit(1);
        if (!row) throw new Error("This file is unavailable.");
        return row.content;
      },
      list: async () =>
        (
          await this.database
            .select({ path: HeadlessFileTable.path })
            .from(HeadlessFileTable)
            .where(fileScope(actor))
            .orderBy(asc(HeadlessFileTable.path))
            .limit(200)
        ).map((row) => row.path),
      write: async (path, text) => {
        validateFilePath(path);
        if (Buffer.byteLength(text, "utf8") > 100000)
          throw new Error("Keep files smaller than 100 KB.");
        return this.database.transaction(async (tx) => {
          await lockMember(tx, actor);
          if (fence) await assertFileFence(tx, actor, fence);
          const [previous] = await tx
            .select({ path: HeadlessFileTable.path })
            .from(HeadlessFileTable)
            .where(and(fileScope(actor), eq(HeadlessFileTable.path, path)))
            .limit(1);
          if (!previous) {
            const entries = await tx
              .select({ path: HeadlessFileTable.path })
              .from(HeadlessFileTable)
              .where(fileScope(actor))
              .limit(200);
            if (entries.length >= 200)
              throw new Error(
                "Your files folder is full. Edit an existing draft.",
              );
          }
          await tx
            .insert(HeadlessFileTable)
            .values({ ...scope(actor), path, content: text })
            .onDuplicateKeyUpdate({ set: { content: text } });
          if (fence && !(await owns(tx, fence)))
            throw new HeadlessError(
              "lease_lost",
              "This assistant message was stopped. Try again.",
            );
          return `Saved ${path}`;
        });
      },
    };
  }
  async schedule(actor: HeadlessActor, id: string) {
    const [row] = await this.database
      .select()
      .from(HeadlessScheduleTable)
      .where(and(scheduleScope(actor), eq(HeadlessScheduleTable.id, id)))
      .limit(1);
    return row ? scheduleSchema.parse(JSON.parse(row.content)) : null;
  }
  async schedules(actor: HeadlessActor) {
    return (
      await this.database
        .select()
        .from(HeadlessScheduleTable)
        .where(scheduleScope(actor))
        .orderBy(asc(HeadlessScheduleTable.next_ms))
    ).map((row) => scheduleSchema.parse(JSON.parse(row.content)));
  }
  async saveSchedule(schedule: HeadlessSchedule) {
    await this.database.transaction(async (tx) => {
      await lockMember(tx, schedule.actor, !schedule.paused);
      const [previous] = await tx
        .select({ id: HeadlessScheduleTable.id })
        .from(HeadlessScheduleTable)
        .where(
          and(
            scheduleScope(schedule.actor),
            eq(HeadlessScheduleTable.id, schedule.id),
          ),
        )
        .limit(1);
      if (!previous) {
        const saved = await tx
          .select({ id: HeadlessScheduleTable.id })
          .from(HeadlessScheduleTable)
          .where(scheduleScope(schedule.actor))
          .limit(20);
        if (saved.length >= 20)
          throw new HeadlessError(
            "schedules_full",
            "Keep at most 20 scheduled drafts. Edit an existing one.",
            409,
          );
      }
      const values = {
        ...scope(schedule.actor),
        id: schedule.id,
        next_ms: Date.parse(schedule.nextRunAt),
        paused: Number(schedule.paused),
        content: JSON.stringify(schedule),
      };
      await tx
        .insert(HeadlessScheduleTable)
        .values(values)
        .onDuplicateKeyUpdate({
          set: {
            next_ms: values.next_ms,
            paused: values.paused,
            content: values.content,
          },
        });
    });
  }
  async due(now: number) {
    return (
      await this.database
        .select()
        .from(HeadlessScheduleTable)
        .where(
          and(
            eq(HeadlessScheduleTable.paused, 0),
            lte(HeadlessScheduleTable.next_ms, now),
          ),
        )
        .orderBy(asc(HeadlessScheduleTable.next_ms))
        .limit(50)
    ).map((row) => scheduleSchema.parse(JSON.parse(row.content)));
  }
  async enqueueSchedule(schedule: HeadlessSchedule, now: number) {
    await this.database.transaction(async (tx) => {
      await lockMember(tx, schedule.actor);
      const [row] = await tx
        .select()
        .from(HeadlessScheduleTable)
        .where(
          and(
            scheduleScope(schedule.actor),
            eq(HeadlessScheduleTable.id, schedule.id),
          ),
        )
        .limit(1)
        .for("update");
      if (!row || row.paused || row.next_ms > now) return;
      const current = scheduleSchema.parse(JSON.parse(row.content));
      await insertRun(
        tx,
        newRun(current.actor, {
          surface: current.surface,
          conversationKey: current.conversationKey,
          idempotencyKey: `schedule:${current.id}:${current.nextRunAt}`,
          prompt: current.prompt,
          scheduleId: current.id,
        }),
      );
      current.nextRunAt = new Date(
        now + current.intervalMinutes * 60000,
      ).toISOString();
      await tx
        .update(HeadlessScheduleTable)
        .set({
          next_ms: Date.parse(current.nextRunAt),
          content: JSON.stringify(current),
        })
        .where(eq(HeadlessScheduleTable.id, current.id));
    });
  }
}
