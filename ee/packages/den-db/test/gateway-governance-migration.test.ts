import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { generateMySQLDrizzleJson, generateMySQLMigration } from "drizzle-kit/api"
import { loadMigrationPlan, snapshotShape } from "../scripts/migration-baseline"
import * as schema from "../src/schema"

const plan = loadMigrationPlan(fileURLToPath(new URL("../drizzle", import.meta.url)))
test("governance schema matches the complete migration snapshot", async () => {
  const saved = plan.at(-1)?.snapshot
  assert.ok(saved)
  const generated = await generateMySQLDrizzleJson(schema, saved.prevId)
  assert.deepEqual(await generateMySQLMigration(saved, generated), [])
  for (const table of Object.values(saved.tables).filter((item) => item.name.startsWith("gateway_governance_"))) {
    for (const name of [...Object.keys(table.compositePrimaryKeys), ...Object.keys(table.indexes), ...Object.keys(table.uniqueConstraints)]) assert.ok(name.length <= 64, name)
  }
})

test("governance migration explicitly backfills settings and the initial immutable set", () => {
  const sql = readFileSync(new URL("../drizzle/0111_gateway_governance.sql", import.meta.url), "utf8")
  assert.match(sql, /INSERT INTO `gateway_governance_policy_set`[\s\S]+SELECT `id`, 1, JSON_ARRAY\(\) FROM `organization`/)
  assert.match(sql, /INSERT INTO `gateway_governance_settings`[\s\S]+SELECT `id`, false, 1, 1 FROM `organization`/)
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM|UPDATE `organization`/)
})

test("MySQL revision constraint serialization normalizes without accepting weaker checks", () => {
  const saved = plan.at(-1)?.snapshot
  assert.ok(saved)
  const mysql = structuredClone(saved)
  mysql.tables.gateway_governance_settings.checkConstraint.gateway_governance_settings_revisions.value = "((`revision` >= 1) and (`policy_set_revision` >= 1))"
  mysql.tables.gateway_governance_policy.checkConstraint.gateway_governance_policy_revision.value = "(`revision` >= 1)"
  assert.deepEqual(snapshotShape(mysql), snapshotShape(saved))
  mysql.tables.gateway_governance_settings.checkConstraint.gateway_governance_settings_revisions.value = "revision >= 1 or policy_set_revision >= 1"
  assert.notDeepEqual(snapshotShape(mysql), snapshotShape(saved))
})

test("decision migration stores metadata only and indexes tenant history, retention, and admission scope", () => {
  const sql = readFileSync(new URL("../drizzle/0112_gateway_governance_decisions.sql", import.meta.url), "utf8")
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM|ALTER TABLE `gateway_governance_(?:settings|policy|audit)/)
  const saved = plan.at(-1)?.snapshot
  assert.ok(saved)
  const decision = saved.tables.gateway_governance_decision
  const admission = saved.tables.gateway_governance_admission
  assert.ok(decision && admission)
  assert.deepEqual(Object.keys(decision.columns).sort(), [
    "created_at", "decision_id", "decision_version", "evaluator_attempts", "evaluator_input_tokens", "evaluator_model",
    "evaluator_output_tokens", "extractor_version", "failed_policies", "id", "latency_ms", "org_membership_id",
    "organization_id", "outcome", "policies", "policy_set_revision", "request_id", "route",
  ])
  assert.doesNotMatch(Object.keys(decision.columns).join(","), /prompt|content|guidance|probab|score|text/)
  const shape = (indexes: typeof decision.indexes) => Object.values(indexes).map((item) => `${item.isUnique ? "unique:" : ""}${item.columns.join(",")}`).sort()
  assert.deepEqual(shape(decision.indexes), ["created_at", "organization_id,created_at,id", "unique:decision_id"])
  assert.equal(decision.columns.org_membership_id.notNull, false)
  assert.equal(admission.columns.contribution_digest.type, "char(64)")
  assert.deepEqual(shape(admission.indexes), ["expires_at", "unique:organization_id,org_membership_id,contribution_digest"])
})
