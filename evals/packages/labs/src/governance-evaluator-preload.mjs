// Test-owned TypeSafe transport: only the paid evaluator is replaced.
// The real Gateway still performs extraction, eligibility, thresholds and denial.
if (process.env.OPENWORK_EVAL_GOVERNANCE !== "1") throw new Error("Governance evaluator fixture requires explicit test activation");
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== "https://api.typesafe.ai") return originalFetch(input, init);
  if (url.pathname !== "/v1/systemone") throw new Error("Unexpected evaluator operation");
  const body = JSON.parse(typeof init?.body === "string" ? init.body : await new Request(input, init).text());
  if (body.model !== "jev-1.13.0" || !body.questions || typeof body.questions !== "object") throw new Error("Invalid evaluator fixture request");
  const blocked = JSON.stringify(body.state).includes("Review this synthetic credentials example.");
  return Response.json({ model: body.model, answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: blocked ? 0.99 : 0.01 }])), usage: { input_tokens: 1, output_tokens: 1 } });
};
