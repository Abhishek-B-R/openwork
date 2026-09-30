import { createServer } from "node:http";
import { z } from "zod";
import {
  HeadlessWorker,
  OpenCodeHeadlessEngine,
} from "@openwork-ee/headless-execution";
import { headlessService } from "./runtime.js";
const service = headlessService();
const engine = new OpenCodeHeadlessEngine(
  process.env.DEN_HEADLESS_OPENCODE_BIN ?? "opencode2",
  {
    history: async (input) =>
      (
        await service.store.conversation(
          input.actor,
          input.run.surface,
          input.run.conversationKey,
        )
      )
        .filter((run) => run.id !== input.run.id && run.status === "succeeded")
        .slice(-12)
        .map((run) => `Member: ${run.prompt}\nAssistant: ${run.result}`)
        .join("\n")
        .slice(-24000),
  },
);
const worker = new HeadlessWorker(service, engine);
const port = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .parse(process.env.DEN_HEADLESS_HEALTH_PORT ?? 9091);
let stopped = false;
const health = createServer((req, res) => {
  if (req.url !== "/health") {
    res.writeHead(404).end();
    return;
  }
  const ready = !stopped && Date.now() - worker.lastHealthyAt < 30000;
  res
    .writeHead(ready ? 200 : 503, { "content-type": "application/json" })
    .end(JSON.stringify({ ready }));
});
health.listen(port, "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"] satisfies NodeJS.Signals[])
  process.on(signal, () => {
    stopped = true;
    worker.stop();
  });
console.info("Cloud assistant worker ready");
let idleMs = 500;
while (!stopped) {
  try {
    const worked = await worker.once();
    idleMs = worked ? 500 : Math.min(idleMs * 2, 5000);
  } catch {
    // A temporary database outage must not drop the durable queue or expose private diagnostics.
    console.warn(
      "Cloud assistant worker is waiting for its database connection",
    );
    idleMs = 5000;
  }
  if (!stopped) await new Promise((resolve) => setTimeout(resolve, idleMs));
}
health.close();
// Agent cleanup and fenced completion finish before exiting. No durable local volume is used.
process.exit(0);
