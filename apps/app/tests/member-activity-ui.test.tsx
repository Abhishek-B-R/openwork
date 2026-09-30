import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { ActivityContext, ActivityResource, MemberActivityEntry } from "../src/react-app/kernel/activity-types";

GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const reload = mock(async () => {});
const reloadCoordinator = await import("../src/react-app/shell/reload-coordinator");
mock.module("../src/react-app/shell/reload-coordinator", () => ({
  ...reloadCoordinator,
  useReloadCoordinator: () => ({ reloadWorkspaceEngine: reload }),
}));

const { NotificationBell } = await import("../src/react-app/shell/notification-center");
const { ActivityPage } = await import("../src/react-app/domains/activity/activity-page");
const { ShellConfigProvider } = await import("../src/react-app/shell/shell-config");
const { TooltipProvider } = await import("../src/components/ui/tooltip");
const { useActivityStore } = await import("../src/react-app/kernel/activity-store");
const { ACTIVITY_REFRESH_EVENT } = await import("../src/react-app/kernel/activity-types");
const { useNotificationStore } = await import("../src/react-app/kernel/notification-store");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.localStorage.clear();
  useActivityStore.setState({ activeScopeKey: null, contexts: {}, refreshState: "idle" });
  useNotificationStore.setState({ notifications: [] });
  reload.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  await GlobalRegistrator.unregister();
});

function Location() { return <output data-location>{useLocation().pathname}</output>; }

async function render() {
  await act(async () => root.render(
    <MemoryRouter><ShellConfigProvider><TooltipProvider>
      <Location />
      <NotificationBell />
      <Routes>
        <Route path="/" element={<div>Session</div>} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/extensions/*" element={<div>Library</div>} />
        <Route path="/settings/*" element={<div>Settings destination</div>} />
      </Routes>
    </TooltipProvider></ShellConfigProvider></MemoryRouter>,
  ));
}

function button(label: string) {
  const result = Array.from(document.querySelectorAll("button"))
    .find((element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

function resource(id: string, kind: ActivityResource["kind"], label: string): ActivityResource {
  return { id, kind, label, revision: "1", href: kind === "provider" ? "/settings/ai" : `/extensions/${id}` };
}

function seed(entries: MemberActivityEntry[], resources = entries.filter((entry) => entry.change !== "unavailable").map((entry) => entry.resource)) {
  const context: ActivityContext = {
    entries,
    snapshots: {
      providers: resources.filter((item) => item.kind === "provider"),
      capabilities: resources.filter((item) => item.kind === "skill" || item.kind === "plugin"),
      connections: resources.filter((item) => item.kind === "connection"),
    },
    verifiedAt: Date.now(),
  };
  useActivityStore.setState({ activeScopeKey: "member-fixture", contexts: { "member-fixture": context }, refreshState: "idle" });
}

test("Activity bell opens the compact empty feed and View all reaches the filtered page without read controls", async () => {
  await render();
  await click("Activity");
  const panel = document.querySelector("[data-notification-panel]");
  expect(panel?.textContent).toContain("Nothing new");
  expect(panel?.textContent).toContain("When something is shared with you or changes, it shows here.");
  expect(document.querySelector("[data-notification-unread]")).toBeNull();
  expect(document.querySelector("[data-activity-loading]")).toBeNull();
  expect(document.body.textContent).not.toContain("Mark all");
  await click("View all");
  expect(container.querySelector("[data-location]")?.textContent).toBe("/activity");
  expect(container.querySelector("[data-activity-page]")).not.toBeNull();
  for (const filter of ["All", "Models", "Skills", "Plugins", "Connections"]) expect(button(filter)).toBeTruthy();
  expect(container.textContent).toContain("Nothing new");
  await click("Browse Library");
  expect(container.querySelector("[data-location]")?.textContent).toBe("/extensions");
});

test("member changes keep actorless observed copy, filters, day groups and safe existing-resource navigation", async () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(12, 0, 0, 0);
  seed([
    { id: "model-added", resource: resource("model", "provider", "Research models"), change: "available", observedAt: Date.now() - 1_000 },
    { id: "skill-updated", resource: resource("summary", "skill", "Summarize notes"), change: "updated", observedAt: Date.now() - 2_000 },
    { id: "connection-removed", resource: resource("calendar", "connection", "Work calendar"), change: "unavailable", observedAt: yesterday.getTime() },
  ]);
  await render();
  await click("Activity");
  const panel = document.querySelector("[data-notification-panel]");
  expect(panel?.textContent).toContain("Research models is now available");
  expect(panel?.textContent).toContain("Summarize notes updated");
  expect(panel?.textContent).toContain("Work calendar removed");
  expect(panel?.querySelectorAll("[data-activity-row] button").length).toBe(0);
  expect(panel?.querySelectorAll("[data-activity-row] a").length).toBe(2);
  expect(panel?.querySelector("time")?.getAttribute("aria-label")).toStartWith("Observed on this device");
  await click("View all");
  expect(container.textContent).toContain("Today");
  expect(container.textContent).toContain("Yesterday");
  const removed = container.querySelector('[data-activity-row="connection-removed"]');
  expect(removed?.getAttribute("data-unavailable")).toBe("true");
  expect(removed?.querySelector("a, button")).toBeNull();
  await click("Plugins");
  expect(container.textContent).toContain("No activity in this filter");
  await click("Show all activity");
  await click("Skills");
  expect(container.textContent).toContain("Summarize notes was updated");
  expect(container.textContent).not.toContain("Research models");
  const destination = container.querySelector<HTMLAnchorElement>('[data-activity-row="skill-updated"] a');
  expect(destination?.getAttribute("href")).toBe("/extensions/summary");
  await act(async () => destination?.click());
  expect(container.querySelector("[data-location]")?.textContent).toBe("/extensions/summary");
});

test("compact member rows navigate as one link and close Activity; unavailable rows stay noninteractive", async () => {
  seed([
    { id: "model-added", resource: resource("model", "provider", "Research models"), change: "available", observedAt: Date.now() - 1_000 },
    { id: "skill-updated", resource: resource("summary", "skill", "Summarize notes"), change: "updated", observedAt: Date.now() - 2_000 },
    { id: "connection-removed", resource: resource("calendar", "connection", "Work calendar"), change: "unavailable", observedAt: Date.now() - 3_000 },
  ]);
  await render();
  expect(button("Activity").getAttribute("aria-expanded")).toBe("false");
  await click("Activity");
  const panel = document.querySelector("[data-notification-panel]");
  const destination = panel?.querySelector<HTMLAnchorElement>('[data-activity-row="skill-updated"] a');
  expect(destination?.getAttribute("href")).toBe("/extensions/summary");
  expect(destination?.getAttribute("aria-label")).toBe("Open Summarize notes");
  expect(destination?.textContent).toContain("Summarize notes updated");
  expect(destination?.querySelector("button, a, [tabindex='0']")).toBeNull();
  expect(destination?.querySelector("time")?.getAttribute("title")).toStartWith("Observed on this device");
  expect(panel?.querySelectorAll('[data-activity-row="skill-updated"] a, [data-activity-row="skill-updated"] button').length).toBe(1);
  const unavailable = panel?.querySelector('[data-activity-row="connection-removed"]');
  expect(unavailable?.querySelector("a, button, [tabindex='0']")).toBeNull();
  expect(unavailable?.getAttribute("data-unavailable")).toBe("true");
  await act(async () => destination?.click());
  expect(container.querySelector("[data-location]")?.textContent).toBe("/extensions/summary");
  expect(button("Activity").getAttribute("aria-expanded")).toBe("false");
  await click("Activity");
  const model = document.querySelector<HTMLAnchorElement>('[data-notification-panel] [data-activity-row="model-added"] a');
  expect(model?.getAttribute("href")).toBe("/settings/ai");
  await act(async () => model?.click());
  expect(container.querySelector("[data-location]")?.textContent).toBe("/settings/ai");
  expect(button("Activity").getAttribute("aria-expanded")).toBe("false");
});

test("initial scoped refresh shows skeletons, failed refresh keeps history and Retry requests fresh verification", async () => {
  useActivityStore.setState({ activeScopeKey: "member-fixture", refreshState: "refreshing" });
  await render();
  await click("Activity");
  expect(document.querySelector("[data-activity-loading]")).not.toBeNull();
  expect(document.querySelector("[data-notification-panel]")?.textContent).not.toContain("Nothing new");
  await act(async () => seed([
    { id: "verified-skill", resource: resource("summary", "skill", "Summarize notes"), change: "updated", observedAt: Date.now() - 1_000 },
  ]));
  await click("View all");
  await act(async () => useActivityStore.setState({ refreshState: "refreshing" }));
  expect(container.querySelector("[data-activity-loading]")).toBeNull();
  expect(container.textContent).toContain("Summarize notes was updated");
  await act(async () => useActivityStore.setState({ refreshState: "error" }));
  expect(container.textContent).toContain("Summarize notes was updated");
  expect(container.textContent).toContain("Couldn’t verify activity");
  expect(container.textContent).toContain("Last verified");
  const refresh = mock(() => {});
  window.addEventListener(ACTIVITY_REFRESH_EVENT, refresh);
  try {
    await click("Retry");
    expect(refresh).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener(ACTIVITY_REFRESH_EVENT, refresh);
  }
});

test("recent member changes and system notices share chronology without mutating history; system actions still work", async () => {
  seed(Array.from({ length: 6 }, (_, index) => ({
    id: `skill-${index}`, resource: resource(`skill-${index}`, "skill", `Skill ${index}`), change: "updated", observedAt: Date.now() - (index + 1) * 1_000,
  })));
  useNotificationStore.getState().add({ kind: "reload", title: "An engine restart is needed", body: "Installed extensions changed", action: { type: "reload-engine" }, actionLabel: "Reload engine" });
  const noticesBefore = JSON.stringify(useNotificationStore.getState().notifications);
  await render();
  await click("Activity");
  const panel = document.querySelector("[data-notification-panel]");
  expect(panel?.querySelectorAll("[data-activity-row]").length).toBe(5);
  expect(panel?.querySelector("[data-activity-row]")?.textContent).toContain("An engine restart is needed");
  expect(panel?.textContent).not.toContain("Skill 5");
  expect(JSON.stringify(useNotificationStore.getState().notifications)).toBe(noticesBefore);
  await click("Reload engine");
  expect(reload).toHaveBeenCalledTimes(1);
  await click("Activity");
  await click("View all");
  expect(container.querySelectorAll("[data-activity-row]").length).toBe(7);
  await click("Reload engine");
  expect(reload).toHaveBeenCalledTimes(2);
  await act(async () => useActivityStore.setState({ activeScopeKey: null }));
  expect(container.textContent).not.toContain("Skill 0");
  expect(container.textContent).toContain("An engine restart is needed");
});

test("compact system notices expose one whole-row action with no nested focus target and close after activation", async () => {
  useNotificationStore.getState().add({ kind: "system", title: "Background verification finished" });
  useNotificationStore.getState().add({ kind: "reload", title: "An engine restart is needed", body: "Installed extensions changed", action: { type: "reload-engine" }, actionLabel: "Reload engine" });
  await render();
  await click("Activity");
  const action = button("Reload engine");
  expect(action.textContent).toContain("An engine restart is needed");
  expect(action.querySelector("time")?.getAttribute("title")).toStartWith("Observed on this device");
  expect(action.querySelector("button, a, [tabindex='0']")).toBeNull();
  const row = action.closest("[data-activity-row]");
  expect(row?.querySelectorAll("button, a").length).toBe(1);
  const passiveNotice = Array.from(document.querySelectorAll('[data-notification-panel] [data-activity-kind="system"]'))
    .find((entry) => entry.textContent?.includes("Background verification finished"));
  expect(passiveNotice?.querySelector("button, a, [tabindex='0']")).toBeNull();
  await click("Reload engine");
  expect(reload).toHaveBeenCalledTimes(1);
  expect(button("Activity").getAttribute("aria-expanded")).toBe("false");
  await act(async () => useNotificationStore.getState().add({ kind: "system", title: "Background verification finished again" }));
  expect(button("Activity").getAttribute("aria-expanded")).toBe("false");
});

test("Activity stays hidden when the shell disables notifications", async () => {
  window.localStorage.setItem("openwork.shell-config", JSON.stringify({ notifications: false }));
  await render();
  expect(document.querySelector("[data-notification-bell]")).toBeNull();
});
