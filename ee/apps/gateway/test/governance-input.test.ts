import assert from "node:assert/strict"
import { test } from "node:test"
import type { GatewayRequestProtocol } from "@openwork/types/den/gateway"
import { assertGovernanceInputBudget, classifyGovernanceContribution, extractGovernanceContribution, GovernanceInputError, governanceLargestInputBytes, governanceTotalInputBytes, governanceFirstTitleWrapper, governanceTitleInstruction } from "../src/governance-input.js"

test("OpenAI chat selects the entire latest contiguous user batch, not old history or instructions", () => {
  const result = extractGovernanceContribution("openai_chat", { messages: [
    { role: "system", content: "PRIVATE_SYSTEM" }, { role: "user", content: "OLD_HISTORY".repeat(100_000) },
    { role: "assistant", content: "old assistant" }, { role: "user", content: "new one" },
    { role: "user", content: [{ type: "text", text: "new two" }, { type: "text", text: "direct text attachment" }] },
  ] })
  assert.deepEqual(result, { contributions: [{ text: ["new one"] }, { text: ["new two", "direct text attachment"] }] })
  assertGovernanceInputBudget(result, { p0: { type: "noul", instructions: "policy" } })
})

test("OpenAI Responses supports string and message input and excludes tool outputs, calls, reasoning and old responses", () => {
  assert.deepEqual(extractGovernanceContribution("openai_responses", { input: "new text" }), { contributions: [{ text: ["new text"] }] })
  const result = extractGovernanceContribution("openai_responses", { input: [
    { role: "user", content: "old" }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "old answer" }] },
    { role: "user", content: [{ type: "input_text", text: "new text" }] },
    { type: "reasoning", encrypted_content: "PRIVATE_REASONING" },
    { type: "function_call", name: "synthetic", call_id: "a", arguments: "PRIVATE_ARGUMENTS" },
    { type: "function_call_output", call_id: "a", output: "PRIVATE_TOOL" },
    { type: "function_call_output", call_id: "b", output: "PRIVATE_PARALLEL_TOOL" },
  ] })
  assert.deepEqual(result, { contributions: [{ text: ["new text"] }] })
})

test("Anthropic user envelopes exclude parallel tool results and include direct user text and plain text documents", () => {
  const result = extractGovernanceContribution("anthropic_messages", { messages: [
    { role: "user", content: "old turn" }, { role: "assistant", content: [{ type: "text", text: "old response" }] },
    { role: "user", content: "current user" }, { role: "assistant", content: [{ type: "tool_use", id: "a", input: { private: "NEVER_EVALUATE" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: [{ type: "image", source: { data: "PRIVATE_BINARY_TOOL" } }] }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: "PRIVATE_RESULT" }] },
  ] })
  assert.deepEqual(result, { contributions: [{ text: ["current user"] }] })
  const mixed = extractGovernanceContribution("anthropic_messages", { messages: [
    { role: "user", content: "previous" }, { role: "assistant", content: [{ type: "tool_use", id: "a", input: {} }] },
    { role: "user", content: [{ type: "tool_result", content: "private tool" }, { type: "text", text: "steering user" },
      { type: "document", title: "filename.txt", context: "document note", source: { type: "text", media_type: "text/plain", data: "document text" } }] },
  ] })
  assert.deepEqual(mixed, { contributions: [{ text: ["steering user", "filename.txt", "document note", "document text"] }] })
})

test("Google and Bedrock conversational tool wrappers are not human contributions", () => {
  assert.deepEqual(extractGovernanceContribution("google_generate_content", { contents: [
    { role: "user", parts: [{ text: "new Google input" }] },
    { role: "model", parts: [{ functionCall: { name: "read", args: { content: "PRIVATE_ARGS" } } }] },
    { role: "user", parts: [{ functionResponse: { name: "read", response: { text: "PRIVATE_TOOL" } } }] },
  ] }), { contributions: [{ text: ["new Google input"] }] })
  assert.deepEqual(extractGovernanceContribution("bedrock_converse", { messages: [
    { role: "user", content: [{ text: "new Bedrock input" }, { document: { format: "txt", name: "note", source: { content: [{ text: "attached text" }] } } }] },
    { role: "assistant", content: [{ toolUse: { toolUseId: "a", name: "read", input: {} } }] },
    { role: "user", content: [{ toolResult: { toolUseId: "a", content: [{ json: { text: "PRIVATE_TOOL" } }] } }] },
  ] }), { contributions: [{ text: ["new Bedrock input", "note", "attached text"] }] })
})

test("pinned v1 first-turn title shapes evaluate exactly the same contribution as primary requests", () => {
  const content = "new user content 界"
  const cases: { protocol: GatewayRequestProtocol; primary: unknown; title: unknown }[] = [
    { protocol: "openai_chat", primary: { messages: [{ role: "user", content }] }, title: { messages: [
      { role: "system", content: governanceTitleInstruction }, { role: "user", content: governanceFirstTitleWrapper }, { role: "user", content },
    ] } },
    { protocol: "openai_responses", primary: { input: content }, title: { instructions: governanceTitleInstruction, input: [
      { role: "user", content: [{ type: "input_text", text: governanceFirstTitleWrapper }] }, { role: "user", content: [{ type: "input_text", text: content }] },
    ] } },
    { protocol: "anthropic_messages", primary: { messages: [{ role: "user", content }] }, title: { system: [{ type: "text", text: governanceTitleInstruction }], messages: [
      { role: "user", content: [{ type: "text", text: governanceFirstTitleWrapper }, { type: "text", text: content }] },
    ] } },
    { protocol: "google_generate_content", primary: { contents: [{ role: "user", parts: [{ text: content }] }] }, title: { systemInstruction: { parts: [{ text: governanceTitleInstruction }] }, contents: [
      { role: "user", parts: [{ text: governanceFirstTitleWrapper }] }, { role: "user", parts: [{ text: content }] },
    ] } },
    { protocol: "google_generate_content", primary: { contents: [{ role: "user", parts: [{ text: content }] }] }, title: { systemInstruction: { parts: [{ text: governanceTitleInstruction }] }, contents: [
      { role: "user", parts: [{ text: governanceFirstTitleWrapper }, { text: content }] },
    ] } },
    { protocol: "bedrock_converse", primary: { messages: [{ role: "user", content: [{ text: content }] }] }, title: { system: [{ text: governanceTitleInstruction }], messages: [
      { role: "user", content: [{ text: governanceFirstTitleWrapper }] }, { role: "user", content: [{ text: content }] },
    ] } },
  ]
  for (const input of cases) {
    const original = JSON.stringify(input.title)
    const expected = extractGovernanceContribution(input.protocol, input.primary)
    assert.deepEqual(extractGovernanceContribution(input.protocol, input.title), expected)
    assert.deepEqual(expected, { contributions: [{ text: [content] }] })
    assert.equal(JSON.stringify(input.title), original)
  }
})

test("first-turn title recognition cannot skip extra users, prior history, tools, media or modified wrapper text", () => {
  const wrapper = { role: "user", content: governanceFirstTitleWrapper }
  const user = { role: "user", content: "new text" }
  for (const messages of [
    [wrapper], [user], [wrapper, user, user], [user, wrapper, user],
    [wrapper, { role: "assistant", content: "old answer" }, user],
    [wrapper, { role: "tool", content: "PRIVATE_TOOL_RESULT" }],
    [{ role: "user", content: `${governanceFirstTitleWrapper}PRIVATE_OLD_CONTEXT` }, user],
    [{ role: "user", content: governanceFirstTitleWrapper, audio: { data: "PRIVATE_BINARY" } }, user],
    [wrapper, { role: "user", content: [{ type: "image_url", image_url: "PRIVATE_BINARY" }] }],
  ]) assert.throws(() => extractGovernanceContribution("openai_chat", { messages: [{ role: "system", content: governanceTitleInstruction }, ...messages] }), GovernanceInputError)
  for (const content of [
    [{ type: "text", text: governanceFirstTitleWrapper }, { type: "text", text: "old" }, { type: "text", text: "new" }],
    [{ type: "text", text: governanceFirstTitleWrapper }, { type: "tool_result", content: "PRIVATE_TOOL_RESULT" }],
  ]) assert.throws(() => extractGovernanceContribution("anthropic_messages", { system: governanceTitleInstruction, messages: [{ role: "user", content }] }), GovernanceInputError)
  assert.throws(() => extractGovernanceContribution("openai_chat", { purpose: "title", already_checked: true, messages: [wrapper, user] }), GovernanceInputError)
})

const unsupportedCases: { protocol: GatewayRequestProtocol; body: unknown }[] = [
  { protocol: "passthrough", body: { prompt: "legacy input" } },
  { protocol: "openai_chat", body: { messages: [] } },
  { protocol: "openai_chat", body: { messages: [{ role: "tool", content: "result with no user" }] } },
  { protocol: "openai_chat", body: { messages: [{ role: "user", content: "old" }, { role: "assistant", content: "completed answer" }] } },
  { protocol: "openai_chat", body: { messages: [{ role: "user", content: "text" }], purpose: "title" } },
  { protocol: "openai_chat", body: { messages: [{ role: "user", content: "text" }], metadata: { task: "compaction" } } },
  { protocol: "openai_responses", body: { input: "text", previous_response_id: "provider-history" } },
  { protocol: "openai_responses", body: { input: [{ type: "item_reference", id: "old-user" }] } },
  { protocol: "openai_responses", body: { input: [{ role: "user", content: [{ type: "input_file", file_data: "BASE64" }] }] } },
  { protocol: "openai_chat", body: { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://synthetic.test/image" } }] }] } },
  { protocol: "anthropic_messages", body: { messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "BASE64" } }] }] } },
  { protocol: "google_generate_content", body: { contents: [{ role: "user", parts: [{ inlineData: { data: "BASE64" } }] }] } },
  { protocol: "google_generate_content", body: { contents: [{ role: "user", parts: [{ text: "valid", inlineData: { data: "HIDDEN" } }] }] } },
  { protocol: "bedrock_converse", body: { messages: [{ role: "user", content: [{ image: { source: { bytes: "BASE64" } } }] }] } },
  { protocol: "bedrock_converse", body: { messages: [{ role: "user", content: [{ document: { format: "txt", name: "file", source: { bytes: "BASE64" } } }] }] } },
  { protocol: "openai_chat", body: { messages: [{ role: "user", content: "", audio: { data: "BASE64" } }] } },
  { protocol: "openai_chat", body: { messages: [{ role: "user", content: "   " }] } },
  { protocol: "openai_chat", body: { messages: [{ role: "other", content: "unknown role" }] } },
  { protocol: "openai_chat", body: { messages: [{ role: "user", content: "Generate a title for this conversation:\n" }, { role: "user", content: "actual new message" }] } },
  { protocol: "anthropic_messages", body: { system: [{ type: "text", text: "You are a title generator. You output ONLY a thread title." }], messages: [{ role: "user", content: "actual new message" }] } },
  { protocol: "google_generate_content", body: { systemInstruction: { parts: [{ text: "You are an anchored context summarization assistant for coding sessions." }] }, contents: [{ role: "user", parts: [{ text: "synthetic summary request" }] }] } },
  { protocol: "openai_responses", body: { input: "Summarize.\n\nThe following is the conversation history:\n\nOLD_HISTORY" } },
]

test("unsupported media and ambiguous title/compaction/history requests fail rather than falling back to old transcript", () => {
  for (const input of unsupportedCases) assert.throws(() => extractGovernanceContribution(input.protocol, input.body), GovernanceInputError)
})

test("byte budgets enforce state+largest and state+all questions with reserve; unicode/code/escaping are not four chars per token", () => {
  const questions = { p0: { type: "noul", instructions: "q" } }
  assert.throws(() => assertGovernanceInputBudget("a".repeat(governanceLargestInputBytes), questions), GovernanceInputError)
  assert.throws(() => assertGovernanceInputBudget("界".repeat(10_000), questions), GovernanceInputError)
  assert.throws(() => assertGovernanceInputBudget("\\".repeat(15_000), questions), GovernanceInputError)
  const manyQuestions = Object.fromEntries(Array.from({ length: 20 }, (_value, index) => [`p${index}`, { type: "noul", instructions: "q".repeat(3200) }]))
  assert.ok(Buffer.byteLength(JSON.stringify(manyQuestions)) > governanceTotalInputBytes)
  assert.throws(() => assertGovernanceInputBudget("tiny contribution", manyQuestions), GovernanceInputError)
  assert.doesNotThrow(() => assertGovernanceInputBudget("x".repeat(100), questions))
})

test("classification marks tool continuations after the latest genuine user batch, never new submissions or steering text", () => {
  const user = { role: "user", content: "same user text" }
  const cases: { protocol: GatewayRequestProtocol; body: unknown; continuation: boolean }[] = [
    { protocol: "openai_chat", body: { messages: [user] }, continuation: false },
    { protocol: "openai_chat", body: { messages: [{ role: "user", content: "old" }, { role: "assistant", content: "answer" }, user] }, continuation: false },
    { protocol: "openai_chat", body: { messages: [user, { role: "assistant", tool_calls: [{ type: "function" }] }, { role: "tool", content: "PRIVATE_TOOL" }] }, continuation: true },
    { protocol: "openai_chat", body: { messages: [user, { role: "assistant", tool_calls: [{ type: "function" }] }, { role: "tool", content: "a" },
      { role: "assistant", tool_calls: [{ type: "function" }] }, { role: "tool", content: "b" }] }, continuation: true },
    { protocol: "openai_chat", body: { messages: [user, { role: "assistant", tool_calls: [{ type: "function" }] }, { role: "tool", content: "a" }, { role: "user", content: "steer" }] }, continuation: false },
    { protocol: "openai_responses", body: { input: "same user text" }, continuation: false },
    { protocol: "openai_responses", body: { input: [{ role: "user", content: [{ type: "input_text", text: "same user text" }] },
      { type: "function_call", call_id: "a", name: "x", arguments: "{}" }, { type: "function_call_output", call_id: "a", output: "PRIVATE" }] }, continuation: true },
    { protocol: "anthropic_messages", body: { messages: [user, { role: "assistant", content: [{ type: "tool_use", id: "a", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "PRIVATE" }] }] }, continuation: true },
    { protocol: "anthropic_messages", body: { messages: [user, { role: "assistant", content: [{ type: "tool_use", id: "a", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "PRIVATE" }, { type: "text", text: "steer" }] }] }, continuation: false },
    { protocol: "google_generate_content", body: { contents: [{ role: "user", parts: [{ text: "same user text" }] },
      { role: "model", parts: [{ functionCall: { name: "x", args: {} } }] }, { role: "user", parts: [{ functionResponse: { name: "x", response: {} } }] }] }, continuation: true },
    { protocol: "bedrock_converse", body: { messages: [{ role: "user", content: [{ text: "same user text" }] },
      { role: "assistant", content: [{ toolUse: { toolUseId: "a", name: "x", input: {} } }] }, { role: "user", content: [{ toolResult: { toolUseId: "a", content: [] } }] }] }, continuation: true },
  ]
  for (const input of cases) {
    const result = classifyGovernanceContribution(input.protocol, input.body)
    assert.equal(result.continuation, input.continuation, JSON.stringify(input.body))
    assert.deepEqual(result.state, extractGovernanceContribution(input.protocol, input.body))
  }
  const submission = classifyGovernanceContribution("openai_chat", cases[0].body)
  const continuation = classifyGovernanceContribution("openai_chat", cases[2].body)
  assert.deepEqual(continuation.state, submission.state)
  assert.equal(classifyGovernanceContribution("openai_chat", { messages: [user], governance_continuation: true, tool_continuation: true }).continuation, false)
})
