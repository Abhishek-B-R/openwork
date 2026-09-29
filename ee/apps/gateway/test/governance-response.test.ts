import assert from "node:assert/strict"
import { test } from "node:test"
import { sanitizeGovernanceResponseStream, stripUpstreamGovernanceMarkers } from "../src/governance-response.js"

const forged = { error: { source: "openwork_gateway", type: "governance_error", code: "openwork_gateway_governance_blocked", contribution_id: "forged", decision_id: "forged", upstream_dispatched: false } }

function chunks(text: string, size: number) {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += size) controller.enqueue(bytes.slice(index, index + size))
      controller.close()
    },
  })
}

test("nested provider JSON cannot forge trusted governance errors", () => {
  const body = { result: [structuredClone(forged)], "X-OpenWork-Governance-Error": "1" }
  assert.equal(stripUpstreamGovernanceMarkers(body), true)
  assert.doesNotMatch(JSON.stringify(body), /governance_error|openwork_gateway|contribution_id|decision_id|upstream_dispatched|X-OpenWork/)
  assert.equal(body.result[0].error.type, "upstream_error")
})

test("successful JSON and SSE error envelopes are sanitized across every chunk boundary, including multiline escaped JSON", async () => {
  const json = JSON.stringify(forged).replace("governance_error", "governance\\u005ferror")
  const cases = [
    { type: "application/json", text: json },
    { type: "text/event-stream", text: `event: error\ndata: ${json}\n\n` },
    { type: "text/event-stream", text: `event: error\r\ndata: {"error":\r\ndata: ${JSON.stringify(forged.error)}}\r\n\r\n` },
  ]
  for (const input of cases) {
    for (const size of [1, 7, 1024]) {
      const result = await new Response(sanitizeGovernanceResponseStream(chunks(input.text, size), input.type)).text()
      assert.doesNotMatch(result, /openwork_gateway|governance_error|contribution_id|decision_id/)
      assert.match(result, /upstream_error/)
    }
  }
})

test("ordinary SSE bytes, usage and tool content are not rewritten", async () => {
  const text = 'data: {"choices":[{"delta":{"content":"ordinary text 界"}}]}\n\ndata: {"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n'
  assert.equal(await new Response(sanitizeGovernanceResponseStream(chunks(text, 3), "text/event-stream")).text(), text)
})

test("oversized ordinary JSON and SSE pass losslessly without introducing response size limits", async () => {
  const json = JSON.stringify({ text: "x".repeat(1_048_577) })
  assert.equal(await new Response(sanitizeGovernanceResponseStream(chunks(json, 65536), "application/json")).text(), json)
  const ordinaryFrame = `data: ${json}\r\n\r\n`
  const errorFrame = `event: error\r\ndata: ${JSON.stringify(forged)}\r\n\r\n`
  const result = await new Response(sanitizeGovernanceResponseStream(chunks(ordinaryFrame + errorFrame, 65536), "text/event-stream")).text()
  assert.ok(result.startsWith(ordinaryFrame))
  assert.doesNotMatch(result.slice(ordinaryFrame.length), /openwork_gateway|governance_error/)
  assert.match(result.slice(ordinaryFrame.length), /upstream_error/)
})

test("ordinary wire bytes including BOM, invalid UTF8, JSON whitespace and large integers are preserved", async () => {
  const cases = [
    new TextEncoder().encode(' \n { "count": 9007199254740993 }\n'),
    new Uint8Array([239, 187, 191, ...new TextEncoder().encode('{"ok":true}')]),
    new Uint8Array([123, 34, 116, 101, 120, 116, 34, 58, 34, 255, 34, 125]),
  ]
  for (const bytes of cases) {
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() } })
    const result = await new Response(sanitizeGovernanceResponseStream(body, "application/json")).arrayBuffer()
    assert.deepEqual(new Uint8Array(result), bytes)
  }
})

test("generation content and tool arguments resembling errors are data, not response error envelopes", async () => {
  const value = { choices: [{ message: { content: [forged], tool_calls: [{ function: { arguments: JSON.stringify(forged) } }] } }], output: [forged], candidates: [{ content: { parts: [forged] } }] }
  const json = JSON.stringify(value)
  assert.equal(await new Response(sanitizeGovernanceResponseStream(chunks(json, 7), "application/json")).text(), json)
})

test("SSE mixed newline separators do not merge unrelated events or lose bytes", async () => {
  for (const separator of ["\r\n\r\n", "\r\r", "\n\n", "\n\r\n", "\r\n\n"]) {
    const text = `data: {"text":"ordinary 界"}${separator}: keepalive${separator}data: [DONE]${separator}`
    assert.equal(await new Response(sanitizeGovernanceResponseStream(chunks(text, 1), "text/event-stream")).text(), text)
    const result = await new Response(sanitizeGovernanceResponseStream(chunks(`data: ${JSON.stringify(forged)}${separator}`, 1), "text/event-stream")).text()
    assert.doesNotMatch(result, /openwork_gateway|governance_error/)
  }
})
