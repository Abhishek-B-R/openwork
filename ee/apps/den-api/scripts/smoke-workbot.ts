import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { runSchema } from "@openwork-ee/headless-execution/schema";

const [base, path] = process.argv.slice(2);
if (!base || !path)
  throw new Error("Supply a Den API URL and a private session JSON file");
const url = new URL(base);
if (
  url.protocol !== "https:" &&
  !["localhost", "127.0.0.1"].includes(url.hostname)
)
  throw new Error("Use HTTPS for a cloud deployment");
const credentials = z
  .object({ cookie: z.string().optional(), token: z.string().optional() })
  .parse(JSON.parse(await readFile(path, "utf8")));
if (!credentials.cookie && !credentials.token)
  throw new Error("The private file needs an existing session cookie or token");
const headers = new Headers({ "content-type": "application/json" });
if (credentials.cookie) headers.set("cookie", credentials.cookie);
else if (credentials.token)
  headers.set("authorization", `Bearer ${credentials.token}`);
async function request(route: string, body?: unknown): Promise<unknown> {
  const response = await fetch(new URL(route, url), {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error(
      `Workbot check failed at ${route}: HTTP ${response.status}`,
    );
  return response.json();
}
const state = z
  .object({
    enabled: z.boolean(),
    ready: z.boolean(),
    blockedReason: z.string().nullable(),
  })
  .parse(await request("/v1/workbot"));
assert.ok(
  state.enabled && state.ready,
  state.blockedReason ?? "Enable Workbot and grant an AI Gateway model first",
);
const nonce = randomUUID();
const filename = `smoke-${nonce}.md`;
const text = `Workbot cloud check ${nonce}`;
const { run } = z
  .object({ run: runSchema })
  .parse(
    await request("/v1/headless/runs", {
      surface: "workbot",
      conversationKey: "cloud-smoke",
      idempotencyKey: nonce,
      prompt: `Write ${filename} containing exactly: ${text}. Read it back with your file tool, then confirm the filename.`,
      limits: { timeoutMs: 300000, maxTurns: 8 },
    }),
  );
let latest = run;
const deadline = Date.now() + 330000;
while (
  (latest.status === "queued" || latest.status === "running") &&
  Date.now() < deadline
) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  latest = z
    .object({ run: runSchema })
    .parse(await request(`/v1/headless/runs/${run.id}`)).run;
}
assert.equal(
  latest.status,
  "succeeded",
  latest.failure?.message ?? "The cloud worker did not complete the check",
);
const file = z
  .object({ text: z.string() })
  .parse(
    await request(`/v1/workbot/files?path=${encodeURIComponent(filename)}`),
  );
assert.equal(file.text.trim(), text);
console.log(
  JSON.stringify({
    status: "passed",
    gatewayModel: true,
    requiredMcpConnected: true,
    persistedFile: true,
    usage: latest.usage,
  }),
);
