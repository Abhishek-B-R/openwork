import { isEventStreamContentType, isJsonContentType } from "./relay.js"

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function stripUpstreamGovernanceMarkers(body: unknown): boolean {
  const pending: unknown[] = [body]
  let changed = false
  while (pending.length) {
    const value = pending.pop()
    if (Array.isArray(value)) { for (const child of value) pending.push(child); continue }
    if (!object(value)) continue
    if (value.source === "openwork_gateway" && (value.type === "governance_error" || (typeof value.code === "string" && value.code.startsWith("openwork_gateway_governance_")))) {
      delete value.source
      value.type = "upstream_error"
      value.code = "upstream_error"
      delete value.upstream_dispatched
      delete value.contribution_id
      delete value.decision_id
      changed = true
    }
    for (const [key, child] of Object.entries(value)) {
      if (key.toLowerCase().startsWith("x-openwork-governance-")) { delete value[key]; changed = true }
      else if (!["choices", "content", "parts", "arguments", "output", "input", "text", "delta", "tools"].includes(key) && typeof child === "object" && child !== null) pending.push(child)
    }
  }
  return changed
}

function sanitizeJson(text: string) {
  try {
    const value: unknown = JSON.parse(text)
    return stripUpstreamGovernanceMarkers(value) ? JSON.stringify(value) : text
  } catch { return text }
}

export function sanitizeGovernanceResponseStream(body: ReadableStream<Uint8Array>, contentType: string | null) {
  const sse = isEventStreamContentType(contentType)
  if (!sse && !isJsonContentType(contentType)) return body
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  let pending = ""
  let passing = false
  const limit = 65_536
  const sanitize = (bytes: string) => {
    try {
      const value = decoder.decode(Buffer.from(bytes, "latin1"))
      if (!sse) {
        const sanitized = sanitizeJson(value)
        return sanitized === value ? bytes : Buffer.from(sanitized, "utf8").toString("latin1")
      }
      const lines = value.split(/\r\n|\r|\n/)
      const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n")
      const sanitized = sanitizeJson(data)
      if (data === sanitized) return bytes
      const frame = [...lines.filter((line) => !line.startsWith("data:")), `data: ${sanitized}`].join("\n")
      return Buffer.from(frame, "utf8").toString("latin1")
    } catch { return bytes }
  }
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!sse && passing) { controller.enqueue(chunk); return }
      pending += Buffer.from(chunk).toString("latin1")
      if (sse) {
        let boundary: RegExpExecArray | null
        while ((boundary = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r(?!\n)|\n)/.exec(pending)) !== null) {
          const frame = pending.slice(0, boundary.index)
          controller.enqueue(new Uint8Array(Buffer.from(`${passing || frame.length > limit ? frame : sanitize(frame)}${boundary[0]}`, "latin1")))
          pending = pending.slice(boundary.index + boundary[0].length)
          passing = false
        }
      }
      if (pending.length > limit) {
        const end = pending.length - (sse ? 3 : 0)
        controller.enqueue(new Uint8Array(Buffer.from(pending.slice(0, end), "latin1")))
        pending = pending.slice(end)
        passing = true
      }
    },
    flush(controller) {
      if (pending) controller.enqueue(new Uint8Array(Buffer.from(passing ? pending : sanitize(pending), "latin1")))
    },
  }))
}
