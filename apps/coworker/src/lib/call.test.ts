import assert from "node:assert/strict";
import test from "node:test";
import { callUpdates, confirmsStop, shortCallText, EMPTY_CALL_OBSERVATION } from "./call.ts";
import { parseTurnsFile, serializeTurnsFile, type TurnsFile } from "./thread-queue.ts";
import { callConnectPolicy } from "./call-connect-policy.ts";

test("call updates announce observed completion once and never call streamed prose a result", () => {
  const writing = { ...EMPTY_CALL_OBSERVATION, working: true, phase: "Writing", reply: { id: "reply-1", text: "Unfinished" } };
  assert.equal(callUpdates(EMPTY_CALL_OBSERVATION, writing).some((update) => update.id.startsWith("reply:")), false);
  const ended = { ...writing, working: false, reply: { id: "reply-1", text: "The report is ready. Open it on screen. " + "More detail. ".repeat(500) } };
  const updates = callUpdates(writing, ended);
  // The same streamed ID becomes completed; completion still needs announcing.
  assert.equal(updates.length, 1);
  assert.ok(updates[0]?.text.includes("The report is ready."));
  assert.ok((updates[0]?.text.length ?? 1000) < 400);
  assert.equal(callUpdates(ended, ended).length, 0);
});

test("call summaries bound prose and keep permissions on the human card", () => {
  assert.equal(shortCallText("```js\nprivate code\n```\n[Report](https://example.com/private) is ready. Read it on screen. Extra."), "Report is ready.  Read it on screen.");
  const updates = callUpdates(EMPTY_CALL_OBSERVATION, { ...EMPTY_CALL_OBSERVATION, attention: "Delete files?" });
  assert.match(updates[0]?.text ?? "", /on-screen card/);
});

test("spoken message identity survives the normal composer queue store", () => {
  const file: TurnsFile = { schemaVersion: 1, threads: { discussion: { pending: null, next: [{ id: "next-1", messageId: "msg_spoken-1", text: "Research this", queuedAt: 1 }] } } };
  assert.equal(parseTurnsFile(serializeTurnsFile(file)).threads.discussion?.next[0]?.messageId, "msg_spoken-1");
});
test("stopping work needs an unambiguous confirmation, not a negated or qualified yes", () => {
  for (const answer of ["Yes.", "Yes, please stop the work.", "Stop it", "Go ahead."]) assert.equal(confirmsStop(answer), true);
  for (const answer of ["yes but don't stop", "yes keep working", "no", "stop talking", "stop after the report", ""]) assert.equal(confirmsStop(answer), false);
});
test("call CSP allows only the GA call endpoint and configured service origins", () => {
  const policy = callConnectPolicy(["https://den.example/api/den?token=private", "javascript:alert(1)"]);
  assert.ok(policy.includes("https://api.openai.com/v1/realtime/calls"));
  assert.ok(policy.includes("https://den.example "));
  assert.equal(policy.includes("private"), false);
  assert.equal(policy.includes("javascript:"), false);
  assert.equal(policy.includes("https: "), false);
});
