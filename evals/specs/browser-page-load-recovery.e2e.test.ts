import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { browserConnectionFailureWorld } from "../worlds/browser-panel.ts";

const test = spec.world(browserConnectionFailureWorld, {
  resources: {
    surfaces: ["desktop"], services: [],
    nativeReason: "A real Electron WebContentsView must report a refused connection and stop covering the app's recovery controls.",
  },
});

test("a refused connection shows recovery, retries the same address, and allows navigation to a working page", async ({ world, user, probe, step }) => {
  const address = { placeholder: "Enter URL..." };
  const error = { text: "This site refused the connection. Check that it is running, then reload." };
  const recoveredUrl = `${world.origin}/?connection-probe=recovered`;

  await step("before: a working browser page is visible before opening an unavailable local site", async () => {
    await user.see(address);
    await probe.eventually(() => probe.browserState(), {
      within: 15_000,
      until: state => state.nativeViews.some(view => view.tabId === world.tab.tabId && view.visible && view.attached),
      label: "the initial native browser page is visible",
    });
    await user.screenshot();
    await user.type(address, world.failedUrl, { replace: true });
    await user.press("Enter");
  });

  await step("after: the refused connection has a visible Reload action and collapsed technical details", async () => {
    await user.see(error, { timeoutMs: 15_000 });
    await user.see(address, { value: world.failedUrl });
    const failed = await probe.browserState();
    expect(failed.activeTabId).toBe(world.tab.tabId);
    expect(failed.nativeViews.find(view => view.tabId === world.tab.tabId)?.visible).toBe(false);
    await user.see({ role: "button", label: /^Reload$/ });
    await user.notSee({ text: "ERR_CONNECTION_REFUSED" });
    await user.screenshot();
    await user.click({ role: "button", label: "Technical details" });
    await user.see({ text: /ERR_CONNECTION_REFUSED/ });
    await user.click({ role: "button", label: "Technical details" });
    await user.click({ role: "button", label: /^Reload$/ });
    await user.see(error);
    await user.see(address, { value: world.failedUrl });
  });

  await step("a working address restores the native page in the same tab", async () => {
    await user.type(address, recoveredUrl, { replace: true });
    await user.press("Enter");
    await user.notSee(error, { timeoutMs: 15_000 });
    await probe.eventually(() => probe.browserState(), {
      within: 15_000,
      until: state => state.nativeViews.some(view => view.tabId === world.tab.tabId && view.visible && view.attached),
      label: "successful navigation restores the native page",
    });
    expect((await probe.browserState()).activeTabId).toBe(world.tab.tabId);
    expect((await probe.browserTabMetrics(world.tab.targetId)).url).toBe(recoveredUrl);
    await user.screenshot();
  });
});
