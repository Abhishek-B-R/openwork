import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { mcpAppOpenPerformance } from "../worlds/mcp-app-open-performance.ts";

const test = spec.world(mcpAppOpenPerformance, { resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, timeout: 420_000 });

test("seen Apps paint quickly in chat and Dashboard, with live actions and no error flash", async ({ world, user, step }) => {
  await user.see({ role: "button", label: "Open 0" }, { timeoutMs: 60_000 });
  await step("before: An App has not been opened on this device", async () => { await user.screenshot(); });
  for (const surface of ["chat", "dashboard"] as const) {
    for (let sample = 0; sample < 5; sample++) {
      const index = sample + (surface === "dashboard" ? 5 : 0);
      for (const temperature of ["cold", "warm"] as const) {
        await step(`${surface} ${temperature} open ${sample + 1}`, async () => {
          await world.begin();
          await user.click({ role: "button", label: `Open ${index}` });
          await user.see({ testId: "measurement" }, { text: /paintMs/, timeoutMs: 60_000 });
          const measured = await world.capture(surface, temperature);
          if (process.env.OPENWORK_MCP_APP_BASELINE !== "1") expect(measured.errors).toBe(0);
          if (process.env.OPENWORK_MCP_APP_BASELINE !== "1") expect(measured.paintMs).toBeLessThan(temperature === "warm" ? 1_000 : 2_500);
          if (process.env.OPENWORK_MCP_APP_BASELINE !== "1" && temperature === "warm") {
            expect(measured.stages.filter(stage => stage.stage.endsWith("desktop.resources-read"))).toHaveLength(0);
          }
          if (sample === 0 && temperature === "warm") await step(`after: ${surface} reopens from cache without an error flash`, async () => { await user.screenshot(); });
          await user.click({ role: "button", label: "Close App" });
        });
      }
    }
  }
  await world.save();
});
