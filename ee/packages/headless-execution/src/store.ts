import { DatabaseSync } from "node:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { runSchema, eventSchema, scheduleSchema, HeadlessError, type HeadlessSchedule } from "./schema.js"
import type { HeadlessActor, HeadlessRun, HeadlessEvent } from "./contract.js"

export function actorKey(actor: HeadlessActor): string {
  return createHash("sha256").update(JSON.stringify([actor.organizationId, actor.memberId])).digest("hex")
}
export class HeadlessStore {
  readonly database: DatabaseSync
  readonly root: string
  constructor(root: string) {
    this.root = resolve(root)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    this.database = new DatabaseSync(join(this.root, "jobs.sqlite"))
    this.database.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, actor TEXT NOT NULL, surface TEXT NOT NULL, conversation TEXT NOT NULL, idempotency TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, lease_owner TEXT, lease_until INTEGER, data TEXT NOT NULL, UNIQUE(actor,surface,idempotency));
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id,sequence);
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, actor TEXT NOT NULL, next_at INTEGER NOT NULL, paused INTEGER NOT NULL, data TEXT NOT NULL);`)
  }
  close() { this.database.close() }
  transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE")
    try { const result = operation(); this.database.exec("COMMIT"); return result }
    catch (error) { this.database.exec("ROLLBACK"); throw error }
  }
  decode(row: Record<string, unknown> | undefined): HeadlessRun | null {
    return typeof row?.data === "string" ? runSchema.parse(JSON.parse(row.data)) : null
  }
  get(id: string) { return this.decode(this.database.prepare("SELECT data FROM runs WHERE id=?").get(id)) }
  scoped(actor: HeadlessActor, id: string) {
    return this.decode(this.database.prepare("SELECT data FROM runs WHERE id=? AND actor=?").get(id, actorKey(actor)))
  }
  conversation(actor: HeadlessActor, surface: string, key: string) {
    return this.database.prepare("SELECT data FROM runs WHERE actor=? AND surface=? AND conversation=? ORDER BY rowid DESC LIMIT 100")
      .all(actorKey(actor), surface, key).map(row => this.decode(row)).filter((row): row is HeadlessRun => row !== null).reverse()
  }
  insert(run: HeadlessRun): HeadlessRun {
    const fingerprint = createHash("sha256").update(JSON.stringify([run.prompt, run.conversationKey, run.limits ?? {}, run.scheduleId ?? null])).digest("hex")
    const previous = this.database.prepare("SELECT data,fingerprint FROM runs WHERE actor=? AND surface=? AND idempotency=?").get(actorKey(run.actor), run.surface, run.idempotencyKey)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new HeadlessError("idempotency_conflict", "This request key already belongs to a different message.", 409)
      const parsed = this.decode(previous)
      if (parsed) return parsed
    }
    this.database.prepare("INSERT INTO runs(id,actor,surface,conversation,idempotency,fingerprint,status,data) VALUES(?,?,?,?,?,?,?,?)")
      .run(run.id, actorKey(run.actor), run.surface, run.conversationKey, run.idempotencyKey, fingerprint, run.status, JSON.stringify(run))
    this.event(run.id, "status", "Queued")
    return run
  }
  update(run: HeadlessRun) {
    this.database.prepare("UPDATE runs SET status=?,data=? WHERE id=?").run(run.status, JSON.stringify(run), run.id)
  }
  event(id: string, kind: HeadlessEvent["kind"], text: string) {
    this.database.prepare("INSERT INTO events(run_id,data) VALUES(?,?)").run(id, JSON.stringify({runId:id, createdAt:new Date().toISOString(), kind, text:text.slice(0,20000)}))
  }
  events(id: string, after: number): HeadlessEvent[] {
    return this.database.prepare("SELECT sequence,data FROM events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT 200").all(id, after)
      .map(row => eventSchema.parse({ ...JSON.parse(String(row.data)), sequence: Number(row.sequence) }))
  }
  claim(owner: string, now: number, leaseMs: number): HeadlessRun | null {
    return this.transaction(() => {
      // Uncertain interrupted runs are never automatically replayed: a tool may have had effects.
      for (const row of this.database.prepare("SELECT data FROM runs WHERE status='running' AND lease_until<?").all(now)) {
        const run = this.decode(row)
        if (run) {
          run.status = "failed"; run.finishedAt = new Date(now).toISOString()
          run.failure = { code: "worker_interrupted", message: "The worker stopped during this run. Review the files before trying again." }
          this.update(run); this.event(run.id, "status", run.failure.message)
        }
      }
      const row = this.database.prepare(`SELECT data FROM runs candidate WHERE status='queued' AND NOT EXISTS (
        SELECT 1 FROM runs active WHERE active.actor=candidate.actor AND active.status='running') ORDER BY rowid LIMIT 1`).get()
      const run = this.decode(row)
      if (!run) return null
      run.status = "running"; run.startedAt = new Date(now).toISOString()
      this.update(run)
      this.database.prepare("UPDATE runs SET lease_owner=?,lease_until=? WHERE id=?").run(owner, now+leaseMs, run.id)
      this.event(run.id, "status", "Working")
      return run
    })
  }
  owns(id:string,owner:string,now=Date.now()):boolean {
    const row=this.database.prepare("SELECT status,lease_owner,lease_until FROM runs WHERE id=?").get(id)
    return row?.status==="running" && row.lease_owner===owner && Number(row.lease_until)>=now
  }
  heartbeat(id: string, owner: string, now: number, leaseMs: number): boolean {
    return this.database.prepare("UPDATE runs SET lease_until=? WHERE id=? AND lease_owner=? AND status='running' AND lease_until>=?")
      .run(now+leaseMs,id,owner,now).changes === 1
  }
  finish(run: HeadlessRun, owner: string): boolean {
    return this.transaction(() => {
      const row = this.database.prepare("SELECT status,lease_owner,lease_until FROM runs WHERE id=?").get(run.id)
      if (row?.lease_owner !== owner || row.status !== "running" || Number(row.lease_until) < Date.now()) return false
      this.update(run)
      this.event(run.id, run.status === "succeeded" ? "result" : "status", run.result ?? run.failure?.message ?? run.status)
      return true
    })
  }
  directory(actor: HeadlessActor) {
    const path = join(this.root, "actors", actorKey(actor), "files")
    mkdirSync(path, {recursive:true, mode:0o700})
    return path
  }
  schedule(actor: HeadlessActor, id: string): HeadlessSchedule | null {
    const row = this.database.prepare("SELECT data FROM schedules WHERE id=? AND actor=?").get(id, actorKey(actor))
    return typeof row?.data === "string" ? scheduleSchema.parse(JSON.parse(row.data)) : null
  }
  schedules(actor: HeadlessActor): HeadlessSchedule[] {
    return this.database.prepare("SELECT data FROM schedules WHERE actor=? ORDER BY next_at").all(actorKey(actor)).map(row=>scheduleSchema.parse(JSON.parse(String(row.data))))
  }
  saveSchedule(schedule: HeadlessSchedule) {
    this.database.prepare("INSERT INTO schedules(id,actor,next_at,paused,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET next_at=excluded.next_at,paused=excluded.paused,data=excluded.data")
      .run(schedule.id,actorKey(schedule.actor),Date.parse(schedule.nextRunAt),Number(schedule.paused),JSON.stringify(schedule))
  }
  due(now: number): HeadlessSchedule[] {
    return this.database.prepare("SELECT data FROM schedules WHERE paused=0 AND next_at<=? ORDER BY next_at LIMIT 50").all(now).map(row=>scheduleSchema.parse(JSON.parse(String(row.data))))
  }
}
export function newRun(actor: HeadlessActor, input: import("./contract.js").HeadlessRunInput): HeadlessRun {
  return {...input,id:randomUUID(),actor,status:"queued",createdAt:new Date().toISOString(),startedAt:null,finishedAt:null,result:null,failure:null,usage:null}
}
