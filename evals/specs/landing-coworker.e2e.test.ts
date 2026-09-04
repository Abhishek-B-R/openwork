import { expect } from "vitest";
import { chrome } from "@openwork/hosts";
import { freezeMotion, setViewport } from "@openwork/cdp";
import { spec } from "@openwork/testkit";

// A new visitor journey: an actual announcement page, its native links, and
// the Models handoff. No live account or checkout is created by this spec.
for (const width of [1280, 375]) {
  const test = spec.world(async () => {
    const origin = process.env.OPENWORK_EVAL_LANDING_URL;
    if (!origin) throw new Error("OPENWORK_EVAL_LANDING_URL is required");
    const web = await chrome({ name: "coworker-announcement-" + width, startUrl: origin + "/coworker", headless: true });
    try {
      await setViewport(web, { width, height: 900, deviceScaleFactor: 1 });
      // Use the standard motion fixture so pointer targeting cannot race an
      // in-flight smooth scroll and click a neighboring FAQ.
      await freezeMotion(web);
      return { web, origin, async [Symbol.asyncDispose]() { await web.stop(); } };
    } catch (error) {
      await web.stop();
      throw error;
    }
  }, { needs: { env: ["OPENWORK_EVAL_LANDING_URL"] }, timeout: 90_000 });

  test("Coworker announcement offers early access and an intentional Models handoff at " + width + "px", async ({ world, user, probe, step, evidence }) => {
    await step("Understand the product and its availability", async () => {
      await user.see({ text: "Introducing Open Coworker" });
      const text = await probe.text();
      expect(text).toContain("remembers.");
      expect(text).toContain("Signed downloads are in preparation.");
      expect(text).not.toMatch(/\$100|first 50|24 hours|unlimited/i);
      evidence.recordAssertionEvidence("The announcement leads with memory and accurately labels early access", "The browser shows the coworker value and pending signed downloads, with no unapproved offer or unlimited usage claim.", true);
    });
    await step("Follow the explanation and read the execution limits", async () => {
      await user.click({ role: "link", text: "See how it works" });
      expect(await probe.hash()).toBe("#how");
      await user.see({ text: "Give it something real." });
      await user.click({ text: "Does it work while my computer is off?" });
      await user.see({ text: /Those Cloud runs cannot read your coworker's local files or memory today\./ });
      expect(await probe.text()).toContain("Those Cloud runs cannot read your coworker's local files or memory today.");
      evidence.recordAssertionEvidence("Visitors can follow the product explanation and expand the local-versus-Cloud answer", "The native explanation link reaches #how and the FAQ opens to explain execution limits.", true);
    });
    await step("Get early access without an unintended purchase", async () => {
      await user.click({ role: "link", text: "Get early access", nth: 0 });
      expect(await probe.hash()).toBe("#get-started");
      await user.see({ role: "link", text: "Email for early access" });
      expect(await probe.text()).toContain("Opens your email app");
      const response = await fetch(world.origin + "/coworker", { signal: AbortSignal.timeout(30_000) });
      expect(response.status).toBe(200);
      const html = await response.text();
      const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!.replaceAll("&amp;", "&"));
      expect(hrefs).toContain("mailto:team@openworklabs.com?subject=Open%20Coworker%20early%20access");
      for (const mode of ["sign-up", "sign-in"]) {
        const href = hrefs.find((value) => value.includes("intent=models") && value.includes("mode=" + mode));
        expect(href).toBeTruthy();
        const url = new URL(href!);
        expect(url.origin).toBe("https://app.openworklabs.com");
        expect(url.searchParams.get("intent")).toBe("models");
        expect(url.searchParams.get("utm_campaign")).toBe("coworker");
        expect(url.searchParams.has("token")).toBe(false);
      }
      expect(html).toContain("It does not grant early access to Open Coworker.");
      evidence.recordAssertionEvidence("Early access and Models have separate, truthful destinations", "Email opens a real early-access request; signup and member sign-in links preserve Models intent and campaign attribution without tokens. Membership explicitly does not grant early access.", true);
    });
  });
}
