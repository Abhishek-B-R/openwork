import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { Target } from "@openwork/cdp";
import { memberActivity } from "../worlds/member-activity.ts";

const test = spec.world(memberActivity, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  timeout: 900_000,
});

const bell: Target = { role: "button", label: "Activity" };
const retry: Target = { role: "button", label: "Retry" };
const inventoryPaths = [
  "/v1/llm-providers",
  "/v1/inference-providers?scope=usable",
  "/v1/resources/marketplace-capabilities",
  "/v1/me/library",
  "/v1/mcp-connections?scope=usable",
];

type ActivityEntry = {
  id: string;
  change: string;
  observedAt: number;
  resource: { id: string; kind: string; label: string; href: string };
};
type Activity = { entries: ActivityEntry[]; verifiedAt: number | null; refreshState: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function activity(value: unknown): Activity {
  if (!record(value) || !Array.isArray(value.entries) || typeof value.refreshState !== "string"
    || (value.verifiedAt !== null && typeof value.verifiedAt !== "number")) throw new Error("Activity query returned an invalid status");
  const entries = value.entries.map((entry): ActivityEntry => {
    if (!record(entry) || !record(entry.resource) || typeof entry.id !== "string"
      || typeof entry.change !== "string" || typeof entry.observedAt !== "number"
      || typeof entry.resource.id !== "string" || typeof entry.resource.kind !== "string"
      || typeof entry.resource.label !== "string" || typeof entry.resource.href !== "string") {
      throw new Error("Activity query returned an invalid entry");
    }
    return {
      id: entry.id, change: entry.change, observedAt: entry.observedAt,
      resource: { id: entry.resource.id, kind: entry.resource.kind, label: entry.resource.label, href: entry.resource.href },
    };
  });
  return { entries, verifiedAt: value.verifiedAt, refreshState: value.refreshState };
}

function signedInAs(value: unknown, email: string): boolean {
  return record(value) && value.status === "signed_in" && record(value.user) && value.user.email === email;
}

function successfulInventoryReads(requests: Array<{ method: string; path: string; status: number }>): string[] {
  return inventoryPaths.filter((path) => requests.some((request) => request.method === "GET" && request.path.endsWith(path) && request.status === 200));
}

test("a member discovers newly shared tools in Activity without seeing another member's history", async ({ world, user, agent, probe, step, evidence }) => {
  const feed = async () => activity(await agent.run("activity.list"));
  const available = (name: string): Target => ({ text: `${name} is now available` });
  const baseline = () => probe.eventually(feed, {
    within: 60_000, label: "member inventory has been verified", until: (value) => value.verifiedAt !== null && value.refreshState === "idle",
  });
  // Navigation can finish before Base UI's exit animation unmounts the panel.
  // Observe removal without sending another close action that could hide a bug.
  const waitForPopoverClosed = () => probe.eventually(() => probe.dom("[data-notification-panel]"), {
    within: 10_000, label: "Activity popover closes", until: (value) => value.elements.length === 0,
  });
  const closePopover = async () => {
    await user.press("Escape");
    await waitForPopoverClosed();
  };
  const noReadControls = async () => {
    await user.see(bell);
    expect((await probe.dom("[data-notification-bell][aria-label='Activity']")).elements).toHaveLength(1);
    expect((await probe.dom("[data-notification-unread]")).elements).toHaveLength(0);
    await user.notSee({ role: "button", label: /Mark all.*read/i });
  };
  let observed: ActivityEntry[] = [];
  let connectionId = "";
  let providerId = "";
  let pluginId = "";

  await step("before: existing access is a quiet baseline with an invitation to browse the Library", async () => {
    const state = await baseline();
    const remote = await world.inventory("recipient");
    expect(remote.connections).toContain(world.baselineId);
    expect(state.entries).toEqual([]);
    const reads = successfulInventoryReads(await world.requests());
    expect(reads).toHaveLength(inventoryPaths.length);
    await user.click(bell);
    await user.see({ text: "Nothing new" });
    await user.see({ text: "When something is shared with you or changes, it shows here." });
    await noReadControls();
    evidence.recordAssertionEvidence("The first successful inventory is silent", `5 member inventory endpoints returned 200; ${remote.connections.length} existing connections; 0 Activity entries; no unread indicator`, true);
    await user.screenshot();
    await closePopover();
  });

  await step("Browse Library takes the member from empty Activity to their available tools", async () => {
    await user.click(bell);
    await user.click({ role: "button", label: "View all" });
    await waitForPopoverClosed();
    await user.click({ role: "button", label: "Browse Library" });
    await probe.eventually(() => world.location(), {
      within: 10_000, label: "Library opens from empty Activity", until: (path) => path.endsWith("/extensions"),
    });
    await user.see({ text: "Library" });
    expect((await feed()).entries).toEqual([]);
    evidence.recordAssertionEvidence("The empty-state action has a useful destination", `Browse Library opens ${await world.location()}; initial access still creates 0 Activity entries`, true);
    await user.screenshot();
    await user.navigate(`${world.app.webUrl}/workspace/${world.workspace.workspaceId}/session`);
  });

  await step("a temporary Cloud outage offers Retry while the member's new tools are being shared", async () => {
    await world.failInventory();
    const publication = await world.publishForRecipient();
    connectionId = publication.connectionId;
    providerId = publication.providerId;
    pluginId = publication.pluginId;
    await user.reload();
    await user.click(bell);
    await user.see(retry, { timeoutMs: 60_000 });
    const failed = await probe.eventually(feed, {
      within: 30_000, label: "inventory failure reaches Activity", until: (value) => value.refreshState === "error",
    });
    const rejected = (await world.requests()).filter((request) => request.path.endsWith("/v1/llm-providers") && request.status === 503);
    expect(rejected.length).toBeGreaterThan(0);
    expect(failed.entries).toEqual([]);
    expect(failed.verifiedAt).not.toBeNull();
    evidence.recordAssertionEvidence("The failed refresh is witnessed at the service boundary", `${rejected.length} inventory requests returned 503; ${publication.statuses.length} administrative writes succeeded; the verified baseline remains and Retry is visible`, true);
    await user.screenshot();
  });

  await step("after: Retry fetches newly shared models, skills, plugins, and connections into compact Activity rows", async () => {
    const beforeRequests = (await world.requests()).length;
    await world.recoverInventory();
    await user.click(retry);
    const synced = await probe.eventually(feed, {
      within: 60_000, label: "real member inventory produces Activity", until: (value) => value.refreshState === "idle"
        && ["provider", "skill", "plugin", "connection"].every((kind) => value.entries.some((entry) => entry.resource.kind === kind)),
    });
    observed = synced.entries;
    expect(observed.map((entry) => entry.resource.label).sort()).toEqual([
      world.names.connection, world.names.plugin, world.names.provider, world.names.skill,
    ].sort());
    expect(observed.every((entry) => entry.change === "available")).toBe(true);
    const remote = await world.inventory("recipient");
    expect(remote.providers).toContain(providerId);
    expect(remote.connections).toContain(connectionId);
    expect(JSON.stringify(remote.library)).toContain(pluginId);
    const requests = (await world.requests()).slice(beforeRequests);
    const reads = successfulInventoryReads(requests);
    expect(reads).toHaveLength(inventoryPaths.length);
    expect(requests.some((request) => request.path.endsWith(`/v1/plugins/${pluginId}/resolved`) && request.status === 200)).toBe(true);
    for (const name of [world.names.provider, world.names.skill, world.names.plugin, world.names.connection]) await user.see(available(name));
    await user.notSee(retry);
    await noReadControls();
    expect((await probe.dom("[data-notification-panel] [data-activity-row] a")).elements).toHaveLength(4);
    expect((await probe.dom("[data-notification-panel] [data-activity-row] a button")).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Real sync, not injected history, adds the four changes", `${reads.length} inventory endpoints and the shared plugin detail returned 200 after Retry; ${observed.length} compact rows match the member's Den grants; 4 whole-row links with no nested action buttons`, true);
    await user.screenshot();
  });

  await step("a compact resource row opens its existing Library destination and closes Activity", async () => {
    await user.click({ role: "link", label: `Open ${world.names.plugin}` });
    const expected = `/extensions/${encodeURIComponent(`plugin:${pluginId}`)}`;
    await probe.eventually(() => world.location(), {
      within: 10_000, label: "the shared plugin opens from Activity", until: (path) => path.endsWith(expected),
    });
    await user.see({ text: world.names.plugin });
    await waitForPopoverClosed();
    evidence.recordAssertionEvidence("The compact row is a working destination, not just a receipt", `The whole-row link opens the shared plugin in Library; the Activity popover is closed; all ${(await feed()).entries.length} observations remain`, true);
    await user.screenshot();
    await user.click(bell);
  });

  await step("View all opens the member's Activity page alongside their conversations", async () => {
    await user.click({ role: "button", label: "View all" });
    await user.see({ role: "button", label: "All" });
    await user.see({ role: "heading", label: "Activity" });
    await user.see({ text: `Skill in ${world.names.plugin}` });
    await user.see({ role: "button", label: "New session" });
    expect(await world.location()).toBe("/activity");
    await waitForPopoverClosed();
    for (const name of [world.names.provider, world.names.skill, world.names.plugin, world.names.connection]) await user.see(available(name));
    expect((await feed()).entries).toEqual(observed);
    await noReadControls();
    evidence.recordAssertionEvidence("The full page keeps the normal sidebar and unchanged history", `/activity; 4 changes; conversation sidebar visible; opening the page does not mark or remove entries`, true);
    await user.screenshot();
  });

  const filters = [
    { label: "Models", kind: "provider", name: world.names.provider },
    { label: "Skills", kind: "skill", name: world.names.skill },
    { label: "Plugins", kind: "plugin", name: world.names.plugin },
    { label: "Connections", kind: "connection", name: world.names.connection },
  ];
  for (const filter of filters) {
    await step(`the member narrows Activity to ${filter.label.toLowerCase()}`, async () => {
      await user.click({ role: "button", label: filter.label });
      await user.see(available(filter.name));
      await user.see({ role: "link", label: `Open ${filter.name}` });
      for (const other of filters.filter((candidate) => candidate.kind !== filter.kind)) await user.notSee(available(other.name));
      const rows = (await probe.dom("[data-activity-page] [data-activity-row]")).elements;
      expect(rows).toHaveLength(1);
      evidence.recordAssertionEvidence(`${filter.label} shows only that kind of change`, `${rows.length} matching row, an Open action, and 0 rows from the other 3 categories; history still has ${(await feed()).entries.length} entries`, true);
      await user.screenshot();
    });
  }

  await step("a shared skill update appears after the member's next successful sync", async () => {
    const beforeRequests = (await world.requests()).length;
    const update = await world.updateBriefing();
    await user.reload();
    const synced = await probe.eventually(feed, {
      within: 60_000, label: "published skill revision reaches Activity", until: (value) => value.refreshState === "idle"
        && value.entries.some((entry) => entry.resource.id === update.skillId && entry.change === "updated"),
    });
    observed = synced.entries;
    await user.click({ role: "button", label: "Skills" });
    await user.see({ text: `${world.names.skill} was updated` });
    await user.see(available(world.names.skill));
    const requests = (await world.requests()).slice(beforeRequests);
    expect(requests.some((request) => request.path.endsWith(`/v1/plugins/${pluginId}/resolved`) && request.status === 200)).toBe(true);
    expect(observed.filter((entry) => entry.change === "updated")).toHaveLength(1);
    evidence.recordAssertionEvidence("A real published revision becomes one update", `Publishing returned HTTP ${update.status}; the app fetched the shared plugin again; 1 new skill update retains the earlier access entry`, true);
    await user.screenshot();
  });

  await step("removed connection access stays visible with a lock and no action", async () => {
    const beforeRequests = (await world.requests()).length;
    expect(await world.removeConnectionAccess()).toBe(200);
    await user.reload();
    const synced = await probe.eventually(feed, {
      within: 60_000, label: "revoked access reaches the member", until: (value) => value.refreshState === "idle"
        && value.entries.some((entry) => entry.resource.id === connectionId && entry.change === "unavailable"),
    });
    observed = synced.entries;
    await user.click({ role: "button", label: "Connections" });
    await user.see({ text: `${world.names.connection} is no longer available to you` });
    await user.notSee({ role: "link", label: `Open ${world.names.connection}` });
    const unavailable = (await probe.dom('[data-activity-page] [data-activity-kind="connection"][data-unavailable="true"]')).elements;
    const locks = (await probe.dom('[data-activity-page] [data-activity-kind="connection"] svg[aria-label="No longer available to you"]')).elements;
    expect(unavailable).toHaveLength(2);
    expect(locks).toHaveLength(2);
    expect((await probe.dom('[data-activity-page] [data-activity-kind="connection"] a, [data-activity-page] [data-activity-kind="connection"] button')).elements).toHaveLength(0);
    expect((await world.inventory("recipient")).connections).not.toContain(connectionId);
    const requests = (await world.requests()).slice(beforeRequests);
    expect(requests.some((request) => request.path.endsWith("/v1/mcp-connections?scope=usable") && request.status === 200)).toBe(true);
    evidence.recordAssertionEvidence("Revocation is visible without a dead-end action", `Den's usable inventory no longer includes the connection; 2 historical rows stay visible with 2 locks and 0 actions`, true);
    await user.screenshot();
  });

  await step("the bell keeps the latest five changes while View all retains the full history", async () => {
    expect(observed.length).toBeGreaterThan(5);
    await user.click(bell);
    await user.see({ text: `${world.names.connection} removed` });
    const compact = (await probe.dom("[data-notification-panel] [data-activity-row]")).elements;
    expect(compact).toHaveLength(5);
    expect(compact[0]?.text).toContain(`${world.names.connection} removed`);
    await user.screenshot();
    await user.click({ role: "button", label: "View all" });
    await waitForPopoverClosed();
    await user.click({ role: "button", label: "All" });
    const full = (await probe.dom("[data-activity-page] [data-activity-row]")).elements;
    expect(full).toHaveLength(observed.length);
    evidence.recordAssertionEvidence("The compact view does not discard older changes", `5 latest popover rows, newest first; View all retains all ${full.length} rows`, true);
    await user.screenshot();
  });

  await step("a failed refresh keeps the last known Activity and its verification time", async () => {
    await world.failInventory();
    await user.reload();
    await user.see(retry, { timeoutMs: 60_000 });
    const state = await probe.eventually(feed, {
      within: 30_000, label: "failed refresh preserves history", until: (value) => value.refreshState === "error",
    });
    expect(state.entries).toEqual(observed);
    expect(state.verifiedAt).not.toBeNull();
    await user.see({ text: /Couldn’t verify activity\. Last verified/ });
    await user.see(available(world.names.provider));
    expect((await probe.dom('[role="dialog"]')).elements).toHaveLength(0);
    const failures = (await world.requests()).filter((request) => request.status === 503 && request.path.endsWith("/v1/llm-providers"));
    evidence.recordAssertionEvidence("An outage does not erase or invent changes", `${failures.length} witnessed HTTP 503 responses; all ${observed.length} entries and the last verification time remain; Retry is visible`, true);
    await user.screenshot();
  });

  await step("Retry and reload preserve history without duplicates or read state", async () => {
    await world.recoverInventory();
    await user.click(retry);
    expect((await baseline()).entries).toEqual(observed);
    await user.notSee(retry);
    await user.reload();
    expect((await baseline()).entries).toEqual(observed);
    await user.see(available(world.names.provider));
    await noReadControls();
    const persisted = JSON.stringify(await probe.storage("openwork:member-activity:v1"));
    expect(persisted).toContain(connectionId);
    expect(persisted).not.toMatch(/"(?:readAt|unread|activeScopeKey)"/);
    evidence.recordAssertionEvidence("Device history persists, not a read/unread inbox", `${observed.length} entries retain their IDs after Retry and reload; 0 duplicates; persisted member history has no readAt, unread, or active identity`, true);
    await user.screenshot();
  });

  await step("another member on the same device sees none of the first member's changes", async () => {
    await agent.run("auth.exchange-grant", await world.handoff("other"));
    await probe.eventually(() => agent.run("auth.status"), {
      within: 60_000, label: "second member is signed in", until: (value) => signedInAs(value, world.emails.other),
    });
    await user.navigate(`${world.app.webUrl}/activity`);
    expect((await baseline()).entries).toEqual([]);
    const remote = await world.inventory("other");
    expect(remote.providers).not.toContain(providerId);
    expect(JSON.stringify(remote.library)).not.toContain(pluginId);
    expect(remote.connections).not.toContain(connectionId);
    await user.see({ text: "Nothing new" });
    await user.see({ role: "button", label: "Browse Library" });
    for (const filter of filters) await user.notSee(available(filter.name));
    evidence.recordAssertionEvidence("History is scoped to the signed-in member, not the device", `Same browser profile, second verified member; 0 Activity entries and no private model, plugin, or connection in their Den inventory`, true);
    await user.screenshot();
  });

  await step("an administrator still gets personal Activity rather than an organization-wide view", async () => {
    await agent.run("auth.exchange-grant", await world.handoff("admin"));
    await probe.eventually(() => agent.run("auth.status"), {
      within: 60_000, label: "administrator is signed in", until: (value) => signedInAs(value, world.emails.admin),
    });
    await user.navigate(`${world.app.webUrl}/activity`);
    expect((await baseline()).entries).toEqual([]);
    await user.see({ text: "Nothing new" });
    await user.notSee({ role: "tab", label: /Organization/i });
    await user.notSee({ role: "button", label: /Organization activity/i });
    for (const filter of filters) await user.notSee(available(filter.name));
    evidence.recordAssertionEvidence("Administrative access does not reveal another member's local history", `Third verified identity on the same device; 0 entries on its first inventory; no organization Activity switch`, true);
    await user.screenshot();
  });

  await step("the original member returns to their own saved history", async () => {
    await agent.run("auth.exchange-grant", await world.handoff("recipient"));
    await probe.eventually(() => agent.run("auth.status"), {
      within: 60_000, label: "original member is signed in again", until: (value) => signedInAs(value, world.emails.recipient),
    });
    await user.navigate(`${world.app.webUrl}/activity`);
    expect((await baseline()).entries).toEqual(observed);
    await user.see(available(world.names.provider));
    await user.see({ text: `${world.names.connection} is no longer available to you` });
    await noReadControls();
    evidence.recordAssertionEvidence("Returning to an account restores only its history", `The original ${observed.length} entry IDs return after two other identities used the same profile; unavailable access remains locked`, true);
    await user.screenshot();
  });
});
