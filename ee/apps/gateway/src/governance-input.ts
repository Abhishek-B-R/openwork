import type { GatewayRequestProtocol } from "@openwork/types/den/gateway"
import { GATEWAY_GOVERNANCE_LARGEST_INPUT_BYTES, GATEWAY_GOVERNANCE_TOTAL_INPUT_BYTES } from "@openwork-ee/utils/gateway-governance"

export const governanceExtractorVersion = "new-user-text-v2"
export const governanceFirstTitleWrapper = "Generate a title for this conversation:\n"
export const governanceTitleInstruction = "You are a title generator. You output ONLY a thread title. Nothing else."
export const governanceLargestInputBytes = GATEWAY_GOVERNANCE_LARGEST_INPUT_BYTES
export const governanceTotalInputBytes = GATEWAY_GOVERNANCE_TOTAL_INPUT_BYTES

type ObjectValue = Record<string, unknown>
type Contribution = { contributions: { text: string[] }[] }
export type GovernanceContributionState = Contribution
export type ClassifiedGovernanceContribution = { state: Contribution; continuation: boolean }
type Entry = { kind: "user"; content: unknown } | { kind: "tool" | "assistant" | "instruction"; continuation: boolean }

export class GovernanceInputError extends Error {
  constructor(readonly reason: "unsupported" | "ambiguous" | "too_large") {
    super(reason)
  }
}

function object(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function unsupported(): never { throw new GovernanceInputError("unsupported") }
function ambiguous(): never { throw new GovernanceInputError("ambiguous") }

function onlyKeys(value: ObjectValue, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key))) unsupported()
}

function auxiliaryText(value: string) {
  return /Generate a title for this conversation:|The following is the conversation history:|You are a title generator\.|You are an anchored context summarization assistant|You are a helpful AI assistant tasked with summarizing conversations/.test(value)
}

function instructionTexts(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap((part) => object(part) && typeof part.text === "string" ? [part.text] : [])
  return object(value) && Array.isArray(value.parts) ? instructionTexts(value.parts) : []
}

function text(value: unknown) {
  if (typeof value !== "string") return unsupported()
  if (Buffer.byteLength(value, "utf8") > governanceLargestInputBytes) throw new GovernanceInputError("too_large")
  if (auxiliaryText(value)) return ambiguous()
  return value
}

function optionalText(value: unknown): string[] {
  return value === undefined ? [] : [text(value)]
}

function parts(content: unknown, protocol: GatewayRequestProtocol): { texts: string[]; tools: boolean } {
  if (typeof content === "string" && protocol !== "google_generate_content" && protocol !== "bedrock_converse") {
    return { texts: [text(content)], tools: false }
  }
  if (!Array.isArray(content) || !content.length) return unsupported()
  const texts: string[] = []
  let tools = false
  for (const part of content) {
    if (!object(part)) return unsupported()
    if (protocol === "google_generate_content") {
      if (object(part.functionResponse) && Object.keys(part).length === 1) { tools = true; continue }
      onlyKeys(part, ["text"])
      texts.push(text(part.text))
    } else if (protocol === "bedrock_converse") {
      if (object(part.toolResult) && Object.keys(part).length === 1) { tools = true; continue }
      if (object(part.document) && Object.keys(part).length === 1) {
        const document = part.document
        onlyKeys(document, ["name", "format", "source", "context", "citations"])
        if (document.format !== "txt" || !object(document.source)) return unsupported()
        onlyKeys(document.source, ["content"])
        if (!Array.isArray(document.source.content) || !document.source.content.length) return unsupported()
        texts.push(text(document.name), ...optionalText(document.context))
        for (const block of document.source.content) {
          if (!object(block)) return unsupported()
          onlyKeys(block, ["text"])
          texts.push(text(block.text))
        }
        continue
      }
      onlyKeys(part, ["text"])
      texts.push(text(part.text))
    } else {
      if (protocol === "anthropic_messages" && part.type === "tool_result") { tools = true; continue }
      if (protocol === "anthropic_messages" && part.type === "document") {
        onlyKeys(part, ["type", "source", "title", "context", "citations", "cache_control"])
        if (!object(part.source) || part.source.type !== "text" || part.source.media_type !== "text/plain") return unsupported()
        onlyKeys(part.source, ["type", "media_type", "data"])
        texts.push(...optionalText(part.title), ...optionalText(part.context), text(part.source.data))
        continue
      }
      if (part.type !== (protocol === "openai_responses" ? "input_text" : "text")) return unsupported()
      onlyKeys(part, ["type", "text", "cache_control"])
      texts.push(text(part.text))
    }
  }
  return { texts, tools }
}

function entry(value: unknown, protocol: GatewayRequestProtocol): Entry {
  if (!object(value)) return unsupported()
  if (protocol === "openai_responses" && value.role === undefined) {
    if (value.type === "function_call_output") return { kind: "tool", continuation: true }
    if (value.type === "function_call" || value.type === "reasoning") return { kind: "assistant", continuation: true }
    return unsupported()
  }
  const role = value.role ?? (protocol === "google_generate_content" ? "user" : undefined)
  if (role === "system" || role === "developer") return { kind: "instruction", continuation: false }
  if ((role === "tool" || role === "function") && protocol === "openai_chat") return { kind: "tool", continuation: true }
  const content = protocol === "google_generate_content" ? value.parts : value.content
  if (role === "user") {
    if (value.audio !== undefined || value.images !== undefined || value.attachments !== undefined || value.files !== undefined) return unsupported()
    if (protocol === "openai_responses" && value.type !== undefined && value.type !== "message") return unsupported()
    return { kind: "user", content }
  }
  if (role !== "assistant" && !(protocol === "google_generate_content" && role === "model")) return unsupported()
  const continuation = (protocol === "openai_chat" && ((Array.isArray(value.tool_calls) && value.tool_calls.length > 0) || object(value.function_call)))
    || (Array.isArray(content) && content.some((part) => object(part) && (
      (protocol === "anthropic_messages" && part.type === "tool_use")
      || (protocol === "google_generate_content" && object(part.functionCall))
      || (protocol === "bedrock_converse" && object(part.toolUse))
    )))
  return { kind: "assistant", continuation }
}

function titleWrapperPart(value: unknown, protocol: GatewayRequestProtocol) {
  if (!object(value) || value.text !== governanceFirstTitleWrapper) return false
  if (protocol === "google_generate_content" || protocol === "bedrock_converse") {
    onlyKeys(value, ["text"])
  } else {
    if (value.type !== (protocol === "openai_responses" ? "input_text" : "text")) return false
    onlyKeys(value, ["type", "text", "cache_control"])
  }
  return true
}

function firstTitleContribution(protocol: GatewayRequestProtocol, messages: unknown[]): Contribution {
  let start = 0
  while (start < messages.length) {
    const message = messages[start]
    if (!object(message) || (message.role !== "system" && message.role !== "developer")) break
    start++
  }
  const conversation = messages.slice(start)
  const wrapper = conversation[0]
  if (!object(wrapper) || wrapper.role !== "user") return ambiguous()
  onlyKeys(wrapper, protocol === "google_generate_content" ? ["role", "parts"] : protocol === "openai_responses" ? ["role", "content", "type"] : ["role", "content"])
  if (wrapper.type !== undefined && !(protocol === "openai_responses" && wrapper.type === "message")) return ambiguous()
  const content = protocol === "google_generate_content" ? wrapper.parts : wrapper.content
  let userContent: unknown
  if (conversation.length === 2) {
    const isWrapper = content === governanceFirstTitleWrapper
      || (Array.isArray(content) && content.length === 1 && titleWrapperPart(content[0], protocol))
    if (!isWrapper) return ambiguous()
    const user = entry(conversation[1], protocol)
    if (user.kind !== "user") return ambiguous()
    userContent = user.content
  } else if (conversation.length === 1 && Array.isArray(content) && content.length === 2 && titleWrapperPart(content[0], protocol)) {
    userContent = content.slice(1)
  } else return ambiguous()
  const extracted = parts(userContent, protocol)
  if (extracted.tools || !extracted.texts.some((value) => value.trim())) return ambiguous()
  return { contributions: [{ text: extracted.texts }] }
}

export function extractGovernanceContribution(protocol: GatewayRequestProtocol, body: unknown): Contribution {
  return classifyGovernanceContribution(protocol, body).state
}

export function classifyGovernanceContribution(protocol: GatewayRequestProtocol, body: unknown): ClassifiedGovernanceContribution {
  if (!object(body) || protocol === "passthrough") return unsupported()
  if (["previous_response_id", "conversation", "cachedContent", "cached_content", "prompt", "context_management"].some((key) => body[key] !== undefined)) return ambiguous()
  if (body.purpose !== undefined && body.purpose !== "inference" && body.purpose !== "title") return ambiguous()
  const messages = protocol === "openai_responses" ? body.input : protocol === "google_generate_content" ? body.contents : body.messages
  const instructions = [body.system, body.instructions, body.systemInstruction, body.system_instruction,
    ...(Array.isArray(messages) ? messages.flatMap((message) => object(message) && (message.role === "system" || message.role === "developer") ? [message.content] : []) : []),
  ].flatMap(instructionTexts)
  const title = instructions.some((value) => value.startsWith(governanceTitleInstruction))
  const metadata = body.metadata
  const purposes = object(metadata) ? [metadata.purpose, metadata.task, metadata.agent] : []
  if (purposes.some((value) => typeof value === "string" && /compact|summary/i.test(value))) return ambiguous()
  if (instructions.some((value) => /The following is the conversation history:|You are an anchored context summarization assistant|You are a helpful AI assistant tasked with summarizing conversations/.test(value))) return ambiguous()
  if (title) {
    if (!Array.isArray(messages)) return ambiguous()
    return { state: firstTitleContribution(protocol, messages), continuation: false }
  }
  if (instructions.some(auxiliaryText) || body.purpose === "title" || purposes.some((value) => typeof value === "string" && /title/i.test(value))) return ambiguous()
  if (protocol === "openai_responses" && typeof body.input === "string") {
    if (!body.input.trim()) return ambiguous()
    return { state: { contributions: [{ text: [text(body.input)] }] }, continuation: false }
  }
  if (!Array.isArray(messages) || !messages.length) return ambiguous()
  const contributions: Contribution["contributions"] = []
  let toolContinuation = false
  let continuation = false
  for (let index = messages.length - 1; index >= 0; index--) {
    const current = entry(messages[index], protocol)
    if (current.kind === "instruction") {
      if (contributions.length) break
      return ambiguous()
    }
    if (current.kind === "assistant") {
      if (contributions.length) break
      if (!toolContinuation || !current.continuation) return ambiguous()
      continue
    }
    if (current.kind === "tool") { toolContinuation = true; continue }
    if (current.kind !== "user") return ambiguous()
    const extracted = parts(current.content, protocol)
    if (!contributions.length && extracted.texts.length) continuation = toolContinuation
    if (extracted.texts.length) contributions.push({ text: extracted.texts })
    if (extracted.tools) toolContinuation = true
  }
  if (!contributions.length || !contributions.some((contribution) => contribution.text.some((value) => value.trim()))) return ambiguous()
  return { state: { contributions: contributions.reverse() }, continuation }
}

export function assertGovernanceInputBudget(state: unknown, questions: Record<string, unknown>) {
  const stateBytes = Buffer.byteLength(JSON.stringify(state), "utf8")
  const questionBytes = Object.entries(questions).map(([key, question]) => Buffer.byteLength(JSON.stringify({ [key]: question }), "utf8"))
  const largest = Math.max(0, ...questionBytes)
  const total = Buffer.byteLength(JSON.stringify(questions), "utf8")
  if (stateBytes + largest > governanceLargestInputBytes || stateBytes + total > governanceTotalInputBytes) {
    throw new GovernanceInputError("too_large")
  }
}
