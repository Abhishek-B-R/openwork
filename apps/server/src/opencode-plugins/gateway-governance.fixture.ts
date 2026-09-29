import { GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER, GATEWAY_GOVERNANCE_SESSION_HEADER, GATEWAY_GOVERNANCE_ERROR_HEADER, type GatewayGovernanceError } from "@openwork/types/den/gateway-governance";
import { GATEWAY_GOVERNANCE_REQUEST_KIND_HEADER } from "../gateway-governance.js";
import { record } from "../gateway-quota.js";

export const nativeTitleDelimiter = "Generate a title for this conversation:\n";
export const nativeTitleSystem = `You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- ≤50 characters
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
- If the user message is short or conversational (e.g. "hello", "lol", "what's up", "hey"):
  → create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, Intro message, etc.)
</rules>

<examples>
"debug 500 errors in production" → Debugging production 500 errors
"refactor user service" → Refactoring user service
"why is app.js failing" → app.js failure investigation
"implement rate limiting" → Rate limiting implementation
"how do I connect postgres to my API" → Postgres API connection
"best practices for React hooks" → React hooks best practices
"@src/auth.ts can you add refresh token support" → Auth refresh token support
"@utils/parser.ts this is broken" → Parser bug fix
"look at @config.json" → Config review
"@App.tsx add dark mode toggle" → Dark mode toggle in App
</examples>
`;
export const syntheticContribution = "Review the synthetic credentials fixture.";

export function syntheticNativeRequest(kind: "title" | "primary", text = syntheticContribution) {
  return { model: "fixture", stream: false, messages: [
    { role: "system", content: kind === "title" ? nativeTitleSystem : "Synthetic assistant instructions." },
    ...(kind === "title" ? [{ role: "user", content: nativeTitleDelimiter }] : []),
    { role: "user", content: [{ type: "text", text }] },
  ] };
}

type Decision = "blocked" | "allowed" | "unsupported" | "unavailable";
export function createGovernanceGatewayFixture(decide: (kind: "title" | "primary", text: string) => Decision | Promise<Decision> = () => "blocked") {
  const requests: { kind: "title" | "primary"; text: string | null }[] = [];
  const evaluationInputs: string[] = [];
  const forwarded: string[] = [];
  const text = (value: unknown): string | null => {
    if (typeof value === "string") return value;
    if (!Array.isArray(value) || value.length !== 1) return null;
    const part: unknown = value[0];
    return record(part) && part.type === "text" && typeof part.text === "string" ? part.text : null;
  };
  return { requests, evaluationInputs, forwarded, fetch: async (request: Request): Promise<Response> => {
    if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response(null, { status: 404 });
    const body: unknown = await request.json();
    const kind = request.headers.get(GATEWAY_GOVERNANCE_REQUEST_KIND_HEADER) === "title" ? "title" : "primary";
    const messages: unknown[] = record(body) && Array.isArray(body.messages) ? body.messages : [];
    const user = messages.filter((message) => record(message) && message.role === "user");
    const safeRoles = messages.every((message) => record(message) && ["user", "system", "developer"].includes(String(message.role)));
    const first = user[0]; const second = user[1];
    const contribution = !safeRoles ? null : kind === "title"
      ? user.length === 2 && record(first) && text(first.content) === nativeTitleDelimiter && record(second) ? text(second.content) : null
      : user.length === 1 && record(first) ? text(first.content) : null;
    requests.push({ kind, text: contribution });
    const decision = contribution === null ? "unsupported" : await decide(kind, contribution);
    if (contribution !== null && (decision === "allowed" || decision === "blocked")) evaluationInputs.push(contribution);
    if (decision === "allowed" && contribution !== null) {
      forwarded.push(contribution);
      const content = kind === "title" ? "Synthetic title" : "Allowed synthetic response";
      if (record(body) && body.stream === true) {
        const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        return new Response(chunk({ role: "assistant", content }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ id: "chatcmpl_fixture", object: "chat.completion", created: 0, model: "fixture", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    const contributionID = request.headers.get(GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER);
    const sessionID = request.headers.get(GATEWAY_GOVERNANCE_SESSION_HEADER);
    const validID = (id: string | null) => id !== null && /^[A-Za-z0-9_-]{1,128}$/.test(id);
    const error: GatewayGovernanceError = { error: { source: "openwork_gateway", type: "governance_error",
      code: decision === "blocked" ? "openwork_gateway_governance_blocked" : decision === "unsupported" ? "openwork_gateway_governance_unsupported_input" : "openwork_gateway_governance_unavailable",
      message: decision === "blocked" ? "Blocked by Synthetic credentials" : "Synthetic check unavailable",
      schema_version: 1, request_id: `request_${requests.length}`, decision_id: `decision_${requests.length}`,
      ...(validID(contributionID) && contributionID ? { contribution_id: contributionID } : {}),
      input_scope: "new_user_contribution", upstream_dispatched: false, retryable: false,
      evaluation_complete: decision === "blocked", violations: decision === "blocked" ? [{ policy_id: "policy_fixture", policy_name: "Synthetic credentials", policy_revision: 1 }] : [],
    } };
    const headers = new Headers({ [GATEWAY_GOVERNANCE_ERROR_HEADER]: "1", "x-should-retry": "false" });
    if (validID(contributionID) && contributionID) headers.set(GATEWAY_GOVERNANCE_CONTRIBUTION_HEADER, contributionID);
    if (validID(sessionID) && sessionID) headers.set(GATEWAY_GOVERNANCE_SESSION_HEADER, sessionID);
    return Response.json(error, { status: decision === "blocked" ? 403 : decision === "unsupported" ? 422 : 503, headers });
  } };
}
