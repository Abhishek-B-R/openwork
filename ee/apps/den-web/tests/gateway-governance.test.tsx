import { afterAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { GatewayGovernanceDecision, GatewayGovernanceDecisionListResponse, GatewayGovernanceOverview, GatewayGovernancePolicy } from "@openwork/types/den/gateway-governance";

GlobalRegistrator.register({ url: "https://app.example.test/dashboard/ai-gateway?tab=governance" });
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(() => GlobalRegistrator.unregister());
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider, onlineManager } = await import("@tanstack/react-query");
const requests = await import("../app/(den)/_lib/den-flow");
const organization = await import("../app/(den)/dashboard/_providers/org-dashboard-provider");
const { parseOrgContextPayload } = await import("../app/(den)/_lib/den-org");
const { ORG_SCOPE_HEADER } = await import("../app/(den)/_lib/org-scope");
const { GatewayGovernanceSection } = await import("../app/(den)/dashboard/_components/gateway-governance-section");
const { fetchGatewayGovernanceDecisions, gatewayGovernanceDecisionsKey, fetchGatewayGovernance, gatewayGovernanceKey, gatewayGovernancePath: path, mutateGatewayGovernance, GatewayGovernanceWriteUncertainError, GatewayGovernanceRequestError } = await import("../app/(den)/dashboard/_components/gateway-governance-data");

const orgId = "org_governance_fixture";
const noop = async () => {};
const context = parseOrgContextPayload({
  organization: { id: orgId, name: "Fixture Workspace", slug: "fixture" },
  deploymentCapabilities: { version: 1, aiGateway: true },
  currentMember: { id: "owner_fixture", userId: "user_fixture", role: "owner", isOwner: true },
  members: [], teams: [],
});
if (!context) throw new Error("Invalid organization fixture");

function policy(overrides: Partial<GatewayGovernancePolicy> = {}): GatewayGovernancePolicy {
  return { id: "policy_fixture", name: "Credentials", guidance: "Block new contributions containing a password or private key.", status: "draft", revision: 1, createdAt: "2026-09-25T12:00:00.000Z", updatedAt: "2026-09-25T12:00:00.000Z", ...overrides };
}
function overview(overrides: Partial<GatewayGovernanceOverview> = {}): GatewayGovernanceOverview {
  return { settings: { enabled: false, revision: 1, policySetRevision: 1 }, policies: [], availability: { available: true, mode: "hosted", reason: "ready" }, ...overrides };
}
type Call = { path: string; init: RequestInit };
type Reply = { payload: unknown; status?: number };
type Handler = (call: Call) => Reply | Promise<Reply>;
const tick = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }); };
function writes(calls: Call[]) { return calls.filter((call) => call.init.method !== "GET"); }
function body(call: Call): unknown { return JSON.parse(String(call.init.body)); }

async function mount(handler: Handler) {
  const calls: Call[] = [];
  const reauth: string[] = [];
  const request = spyOn(requests, "requestJson").mockImplementation(async (requestedPath, init = {}) => {
    calls.push({ path: requestedPath, init });
    const result = await handler({ path: requestedPath, init });
    return { response: Response.json(result.payload, { status: result.status ?? 200 }), payload: result.payload, text: JSON.stringify(result.payload) };
  });
  const org = spyOn(organization, "useOrgDashboard").mockReturnValue({
    orgSlug: "fixture", orgId, orgDirectory: [], activeOrg: null, orgContext: context,
    orgSelectionOpen: false, orgBusy: false, orgError: null, mutationBusy: null, reauthDialogOpen: false, orgSettingsCompletion: null,
    clearOrgSettingsCompletion: noop, refreshOrgData: noop, createOrganization: noop,
    updateOrganizationName: noop, updateOrganizationSettings: noop, deleteOrganization: noop,
    switchOrganization: noop, inviteMember: noop, startSeatCheckout: noop, cancelInvitation: noop,
    updateMemberRole: noop, removeMember: noop, transferOwnership: noop,
    createTeam: noop, updateTeam: noop, deleteTeam: noop, createRole: noop, updateRole: noop, deleteRole: noop,
    runReauthableAction: async (label, action) => { reauth.push(label); await action(); },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: 3 } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (id: string) => {
    await act(async () => root.render(<QueryClientProvider client={client}><GatewayGovernanceSection orgId={id} /></QueryClientProvider>));
    await tick();
  };
  await render(orgId);
  return { calls, reauth, client, container, render,
    async close() { await act(async () => root.unmount()); client.clear(); request.mockRestore(); org.mockRestore(); container.remove(); },
  };
}
function button(label: string) {
  const element = [...document.querySelectorAll("button")].find((item) => item.textContent === label || item.getAttribute("aria-label") === label);
  if (!element) throw new Error(`Missing button ${label}`);
  return element;
}
async function click(label: string) {
  await act(async () => button(label).click());
  await tick();
}
async function fill(field: "name" | "guidance", value: string) {
  const input = document.querySelector(`[data-testid="gateway-governance-${field}"]`);
  if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) throw new Error(`Missing ${field}`);
  await act(async () => {
    const prototype = input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await tick();
}
function state() { return document.querySelector('[data-testid="gateway-governance-state"]')?.textContent; }

function store(initial = overview()) {
  let current = initial;
  const handler: Handler = (call) => {
    if (call.init.method === "GET") return { payload: current };
    if (call.path === `${path}/policies` && call.init.method === "POST") {
      const data = body(call);
      if (!data || typeof data !== "object" || !("name" in data) || !("guidance" in data) || typeof data.name !== "string" || typeof data.guidance !== "string") throw new Error("Invalid fixture policy write");
      const created = policy({ name: data.name, guidance: data.guidance });
      current = { ...current, policies: [...current.policies, created] };
      return { payload: { policy: created } };
    }
    if (call.path === `${path}/settings`) {
      const data = body(call);
      if (!data || typeof data !== "object" || !("enabled" in data) || typeof data.enabled !== "boolean") throw new Error("Invalid fixture settings write");
      current = { ...current, settings: { ...current.settings, enabled: data.enabled, revision: current.settings.revision + 1 } };
      return { payload: { settings: current.settings } };
    }
    const data = body(call);
    const existing = current.policies[0];
    if (!existing || !data || typeof data !== "object") throw new Error("Invalid fixture patch");
    const next = { ...existing, revision: existing.revision + 1 };
    if ("status" in data && (data.status === "active" || data.status === "archived")) next.status = data.status;
    if ("name" in data && typeof data.name === "string") next.name = data.name;
    if ("guidance" in data && typeof data.guidance === "string") next.guidance = data.guidance;
    current = { ...current, policies: [next], settings: { ...current.settings, revision: current.settings.revision + 1, policySetRevision: current.settings.policySetRevision + 1 } };
    return { payload: { policy: next } };
  };
  return { handler, read: () => current, replace: (next: GatewayGovernanceOverview) => { current = next; } };
}

test("overview and mutations have organization-specific keys and authenticated request scope", async () => {
  expect(gatewayGovernanceKey("org_one")).toEqual(["gateway-governance", "org_one"]);
  expect(gatewayGovernanceKey("org_two")).not.toEqual(gatewayGovernanceKey("org_one"));
  const fixture = store();
  const view = await mount(fixture.handler);
  try {
    await click("Create policy");
    await fill("name", "Credentials");
    await fill("guidance", "Block new contributions containing credentials.");
    await click("Create draft");
    expect(writes(view.calls)).toHaveLength(1);
    expect(body(writes(view.calls)[0])).toEqual({ name: "Credentials", guidance: "Block new contributions containing credentials." });
    expect(view.calls.at(-1)?.init.method).toBe("GET");
    expect(view.reauth).toEqual(["gateway-governance"]);
    for (const call of view.calls) {
      expect(new Headers(call.init.headers).get(ORG_SCOPE_HEADER)).toBe(orgId);
      expect(call.init.cache).toBe("no-store");
    }
    expect(state()).toBe("Disabled");
    expect(view.container.textContent).toContain("Draft");
    expect(view.container.textContent).not.toContain("evaluator tested");
  } finally { await view.close(); }
});

test("publishing never enables governance and enabling requires the external processing disclosure", async () => {
  const fixture = store(overview({ policies: [policy()] }));
  const view = await mount(fixture.handler);
  try {
    await click("Open Credentials");
    await click("Publish policy");
    expect(body(writes(view.calls)[0])).toEqual({ expectedRevision: 1, status: "active" });
    expect(state()).toBe("Disabled");
    expect(view.container.textContent).toContain("Active");
    await click("Enable governance");
    expect(writes(view.calls)).toHaveLength(1);
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("sent to TypeSafe");
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("even when a prompt is later blocked");
    await click("Cancel");
    expect(writes(view.calls)).toHaveLength(1);
    await click("Enable governance");
    await click("Enable governance and send to TypeSafe");
    expect(body(writes(view.calls)[1])).toEqual({ expectedRevision: 2, enabled: true, processingAcknowledged: true });
    expect(state()).toBe("Enabled");
    await click("Disable governance");
    expect(body(writes(view.calls)[2])).toEqual({ expectedRevision: 3, enabled: false });
    expect(state()).toBe("Disabled");
  } finally { await view.close(); }
});

test.each(["enterprise_required", "module_disabled", "evaluator_unavailable", "processing_approval_required", "thresholds_required"] satisfies GatewayGovernanceOverview["availability"]["reason"][])("%s stays visible and locked but an already enabled organization can explicitly disable", async (reason) => {
  const fixture = store(overview({ availability: { available: false, mode: reason === "module_disabled" ? "disabled" : "hosted", reason } }));
  const view = await mount(fixture.handler);
  try {
    expect(view.container.querySelector('[data-testid="gateway-governance-locked"]')).not.toBeNull();
    expect(button("Enable governance").disabled).toBe(true);
    expect(button("Create policy").disabled).toBe(true);
    expect(writes(view.calls)).toHaveLength(0);
    fixture.replace({ ...fixture.read(), settings: { enabled: true, revision: 7, policySetRevision: 1 } });
    await act(async () => { await view.client.invalidateQueries({ queryKey: gatewayGovernanceKey(orgId) }); });
    await tick();
    expect(state()).toBe("Enabled");
    expect(button("Disable governance").disabled).toBe(false);
    await click("Disable governance");
    expect(body(writes(view.calls)[0])).toEqual({ expectedRevision: 7, enabled: false });
    expect(state()).toBe("Disabled");
  } finally { await view.close(); }
});

test("configured self-hosted module can opt in without a browser-side Enterprise assumption", async () => {
  const view = await mount(() => ({ payload: overview({ availability: { available: true, mode: "self_hosted_module", reason: "ready" } }) }));
  try {
    expect(button("Enable governance").disabled).toBe(false);
    expect(state()).toBe("Disabled");
    expect(writes(view.calls)).toHaveLength(0);
  } finally { await view.close(); }
});

test.each([
  null,
  { ...overview(), unexpected: true },
  { ...overview(), settings: { enabled: false, revision: "1", policySetRevision: 1 } },
  { ...overview(), policies: [{ ...policy(), status: "unknown" }] },
  { ...overview(), availability: { available: true, mode: "local", reason: "ready" } },
])("malformed overview never becomes an implicitly disabled or available organization", async (payload) => {
  const view = await mount(() => ({ payload }));
  try {
    expect(view.container.textContent).toContain("invalid response");
    expect(view.container.querySelector('[data-testid="gateway-governance-toggle"]')).toBeNull();
    expect(state()).toBeUndefined();
    expect(view.calls).toHaveLength(1);
  } finally { await view.close(); }
});

test("loading keeps a row skeleton and never exposes an enable button", async () => {
  let resolve: ((reply: Reply) => void) | undefined;
  const pending = new Promise<Reply>((done) => { resolve = done; });
  const view = await mount(() => pending);
  try {
    expect(view.container.querySelector('[aria-label="Loading governance"]')).not.toBeNull();
    expect(state()).toBeUndefined();
    await act(async () => resolve?.({ payload: overview() }));
    await tick();
    expect(state()).toBe("Disabled");
  } finally { await view.close(); }
});

test("policy validation requires bounded name and guidance without remediation fields", async () => {
  const view = await mount(() => ({ payload: overview() }));
  try {
    await click("Create policy");
    await click("Create draft");
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(2);
    expect(document.querySelector('[data-testid="gateway-governance-name"]')?.getAttribute("maxlength")).toBe("120");
    expect(document.querySelector('[data-testid="gateway-governance-guidance"]')?.getAttribute("maxlength")).toBe("4000");
    expect(writes(view.calls)).toHaveLength(0);
    await expect(mutateGatewayGovernance(orgId, { type: "create", body: { name: "x".repeat(121), guidance: "rule" } })).rejects.toThrow();
    expect(writes(view.calls)).toHaveLength(0);
  } finally { await view.close(); }
});

test("active edits and archive use the displayed revision; twenty active policies prevent another publication", async () => {
  const fixture = store(overview({ policies: [policy({ status: "active", revision: 5 })] }));
  const view = await mount(fixture.handler);
  try {
    await click("Open Credentials");
    await fill("guidance", "Block new contributions containing private keys.");
    await click("Save changes");
    expect(body(writes(view.calls)[0])).toEqual({ expectedRevision: 5, name: "Credentials", guidance: "Block new contributions containing private keys." });
    await click("Open Credentials");
    await click("Archive policy");
    expect(body(writes(view.calls)[1])).toEqual({ expectedRevision: 6, status: "archived" });
    expect(view.container.textContent).toContain("Archived");
    fixture.replace(overview({ policies: [policy(), ...Array.from({ length: 20 }, (_, i) => policy({ id: `active_${i}`, name: `Active ${i}`, status: "active" }))] }));
    await act(async () => { await view.client.invalidateQueries({ queryKey: gatewayGovernanceKey(orgId) }); });
    await tick();
    await click("Open Credentials");
    expect(button("Publish policy").disabled).toBe(true);
    expect(view.container.textContent).toContain("Archive an active policy");
  } finally { await view.close(); }
});

test("revision conflict preserves local edits and requires a read plus explicit adoption of the latest policy", async () => {
  const fixture = store(overview({ policies: [policy()] }));
  let conflicts = true;
  const view = await mount((call) => {
    if (call.init.method === "PATCH" && conflicts) {
      fixture.replace(overview({ policies: [policy({ revision: 2, name: "Changed remotely" })], settings: { enabled: false, revision: 2, policySetRevision: 2 } }));
      return { status: 409, payload: { error: "revision_conflict" } };
    }
    return fixture.handler(call);
  });
  try {
    await click("Open Credentials");
    await fill("name", "Local edits");
    await click("Save changes");
    expect(view.container.textContent).toContain("Governance changed");
    expect(document.querySelector<HTMLInputElement>('[data-testid="gateway-governance-name"]')?.value).toBe("Local edits");
    expect(button("Save changes").disabled).toBe(true);
    expect(writes(view.calls)).toHaveLength(1);
    conflicts = false;
    await click("Refresh current state");
    expect(button("Save changes").disabled).toBe(true);
    await click("Discard edits and use latest policy");
    expect(document.querySelector<HTMLInputElement>('[data-testid="gateway-governance-name"]')?.value).toBe("Changed remotely");
    await fill("name", "Reviewed edit");
    await click("Save changes");
    expect(body(writes(view.calls)[1])).toMatchObject({ expectedRevision: 2, name: "Reviewed edit" });
  } finally { await view.close(); }
});

test.each(["network", "timeout", "malformed", "server"])("%s write uncertainty never retries, including when reconnecting, and refresh reconciles a possibly created draft", async (failure) => {
  const fixture = store();
  const view = await mount(async (call) => {
    if (call.init.method === "POST") {
      await fixture.handler(call);
      if (failure === "network") throw new TypeError("network disconnected");
      if (failure === "timeout") throw new requests.DenRequestTimeoutError(15000);
      return { status: failure === "server" ? 503 : 200, payload: { unexpected: true } };
    }
    return fixture.handler(call);
  });
  try {
    await click("Create policy");
    await fill("name", "Credentials");
    await fill("guidance", "Block credentials.");
    await click("Create draft");
    expect(view.container.textContent).toContain("may already have been saved");
    expect(button("Create draft").disabled).toBe(true);
    await act(async () => { onlineManager.setOnline(false); onlineManager.setOnline(true); });
    await tick();
    expect(writes(view.calls)).toHaveLength(1);
    await click("Refresh current state");
    expect(view.container.querySelector('[data-testid="gateway-governance-editor"]')).toBeNull();
    expect(view.container.querySelectorAll('[data-testid="gateway-governance-policy"]')).toHaveLength(1);
    expect(writes(view.calls)).toHaveLength(1);
  } finally { await view.close(); }
});

test("an acknowledged write whose follow-up read fails stays uncertain until a successful explicit read", async () => {
  const fixture = store();
  let failReads = false;
  const view = await mount(async (call) => {
    if (call.init.method !== "GET") { failReads = true; return fixture.handler(call); }
    if (failReads) return { status: 503, payload: { error: "unavailable" } };
    return fixture.handler(call);
  });
  try {
    await click("Enable governance");
    await click("Enable governance and send to TypeSafe");
    expect(state()).toBe("Last confirmed disabled");
    expect(view.container.textContent).toContain("may already have been saved");
    expect(view.container.textContent).toContain("Last confirmed");
    expect(button("Enable governance").disabled).toBe(true);
    await click("Refresh current state");
    expect(button("Enable governance").disabled).toBe(true);
    failReads = false;
    await click("Refresh current state");
    expect(state()).toBe("Enabled");
    expect(writes(view.calls)).toHaveLength(1);
  } finally { await view.close(); }
});

test("saving keeps the current policy row and blocks duplicate writes", async () => {
  const fixture = store(overview({ policies: [policy()] }));
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const view = await mount(async (call) => {
    if (call.init.method === "PATCH") await pending;
    return fixture.handler(call);
  });
  try {
    await click("Open Credentials");
    await click("Publish policy");
    expect(state()).toBe("Saving…");
    expect(view.container.querySelectorAll('[data-testid="gateway-governance-policy"]')).toHaveLength(1);
    expect(button("Publish policy").disabled).toBe(true);
    await click("Publish policy");
    expect(writes(view.calls)).toHaveLength(1);
    await act(async () => release?.());
    await tick();
    expect(state()).toBe("Disabled");
    expect(view.container.textContent).toContain("Active");
  } finally { release?.(); await view.close(); }
});

test("enable disclosure holds its settings revision even if a policy changes before confirmation", async () => {
  const fixture = store();
  const view = await mount((call) => call.init.method === "PATCH" ? { status: 409, payload: { error: "revision_conflict" } } : fixture.handler(call));
  try {
    await click("Enable governance");
    fixture.replace(overview({ settings: { enabled: false, revision: 2, policySetRevision: 2 }, policies: [policy({ status: "active" })] }));
    await act(async () => { await view.client.invalidateQueries({ queryKey: gatewayGovernanceKey(orgId) }); });
    await tick();
    await click("Enable governance and send to TypeSafe");
    expect(body(writes(view.calls)[0])).toEqual({ enabled: true, expectedRevision: 1, processingAcknowledged: true });
    expect(state()).toBe("Last confirmed disabled");
    expect(button("Enable governance").disabled).toBe(true);
    expect(writes(view.calls)).toHaveLength(1);
    await click("Refresh current state");
    expect(button("Enable governance").disabled).toBe(false);
    expect(writes(view.calls)).toHaveLength(1);
  } finally { await view.close(); }
});

test("fresh-auth rejection preserves its typed error and does not become an uncertain replay", async () => {
  const reauth = new requests.ReauthRequiredError("Confirm your identity", "fresh_session_required");
  const request = spyOn(requests, "requestJson").mockRejectedValue(reauth);
  try {
    await expect(mutateGatewayGovernance(orgId, { type: "settings", body: { enabled: false, expectedRevision: 1 } })).rejects.toBe(reauth);
    expect(request).toHaveBeenCalledTimes(1);
  } finally { request.mockRestore(); }
});

test("typed conflict and unknown mutation errors do not expose server payloads", async () => {
  let status = 409;
  const request = spyOn(requests, "requestJson").mockImplementation(async () => ({ response: new Response(null, { status }), payload: { message: "private-server-details" }, text: "" }));
  try {
    await expect(mutateGatewayGovernance(orgId, { type: "archive", policy: policy() })).rejects.toBeInstanceOf(GatewayGovernanceRequestError);
    status = 503;
    await expect(mutateGatewayGovernance(orgId, { type: "archive", policy: policy() })).rejects.toBeInstanceOf(GatewayGovernanceWriteUncertainError);
    await expect(fetchGatewayGovernance(orgId)).rejects.toThrow("Governance is unavailable. Refresh to verify the current state.");
  } finally { request.mockRestore(); }
});

test("switching organizations clears retained policies, edit state and disclosure before reading the next organization", async () => {
  const view = await mount((call) => ({ payload: new Headers(call.init.headers).get(ORG_SCOPE_HEADER) === orgId ? overview({ policies: [policy()] }) : overview() }));
  try {
    await click("Open Credentials");
    await fill("name", "Private local draft");
    await view.render("org_other");
    expect(view.container.textContent).not.toContain("Credentials");
    expect(document.querySelector('[data-testid="gateway-governance-editor"]')).toBeNull();
    expect(state()).toBe("Disabled");
    expect(new Headers(view.calls.at(-1)?.init.headers).get(ORG_SCOPE_HEADER)).toBe("org_other");
    expect(writes(view.calls)).toHaveLength(0);
  } finally { await view.close(); }
});

function decision(index: number, overrides: Partial<GatewayGovernanceDecision> = {}): GatewayGovernanceDecision {
  return {
    decisionId: `decision_${index}`, createdAt: new Date(Date.UTC(2026, 8, 29, 12, 0, 0) - index * 60_000).toISOString(), route: "provider",
    outcome: "allowed", memberId: "member_fixture", memberName: "Ada Member", policySetRevision: 2, failedPolicies: [],
    latencyMs: 40, evaluatorModel: "jev-1.13.0", ...overrides,
  };
}
const decisionsPath = `${path}/decisions`;
function decisionPages(pages: GatewayGovernanceDecisionListResponse[], fail: (call: Call) => boolean = () => false): Handler {
  return (call) => {
    if (!call.path.startsWith(decisionsPath)) return { payload: overview() };
    if (fail(call)) return { payload: { error: "gateway_governance_unavailable", message: "private-server-details" }, status: 503 };
    const cursor = new URL(call.path, "https://app.example.test").searchParams.get("cursor");
    return { payload: pages[cursor ? Number(cursor.replace("page", "")) : 0] };
  };
}
function decisionCalls(calls: Call[]) { return calls.filter((call) => call.path.startsWith(decisionsPath)); }
async function openDecisions() {
  const details = document.querySelector('[data-testid="gateway-governance-decisions"]');
  if (!(details instanceof HTMLDetailsElement)) throw new Error("Missing recent decisions");
  await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
  await tick();
  return details;
}
function decisionRows() { return [...document.querySelectorAll('[data-testid="gateway-governance-decision"]')]; }

test("recent decisions stay collapsed and unread until opened", async () => {
  const view = await mount(decisionPages([{ decisions: [decision(0)], nextCursor: null }]));
  try {
    const details = document.querySelector('[data-testid="gateway-governance-decisions"]');
    expect(details instanceof HTMLDetailsElement && !details.open).toBe(true);
    expect(details?.querySelector("summary")?.textContent).toBe("Recent decisions");
    expect(decisionCalls(view.calls)).toHaveLength(0);
    expect(document.querySelector('[data-testid="gateway-governance"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="gateway-governance-scope"]')).not.toBeNull();
    await openDecisions();
    expect(decisionCalls(view.calls)).toHaveLength(1);
    const call = decisionCalls(view.calls)[0];
    expect(call.path).toBe(`${decisionsPath}?limit=25`);
    expect(new Headers(call.init.headers).get(ORG_SCOPE_HEADER)).toBe(orgId);
    expect(call.init.cache).toBe("no-store");
    expect(writes(view.calls)).toHaveLength(0);
  } finally { await view.close(); }
});

test("decision rows show time, outcome label, member and failed policy names with neutral blocked states", async () => {
  const rows = [
    decision(0, { outcome: "blocked", failedPolicies: [{ id: "p1", revision: 2, name: "Credentials" }, { id: "p2", revision: 1, name: "Customer data" }] }),
    decision(1, { outcome: "allowed" }),
    decision(2, { outcome: "receipt_reused" }),
    decision(3, { outcome: "uncertain" }),
    decision(4, { outcome: "unsupported_input", memberId: null, memberName: null }),
    decision(5, { outcome: "unavailable" }),
    decision(6, { outcome: "policy_changed" }),
  ];
  const view = await mount(decisionPages([{ decisions: rows, nextCursor: null }]));
  try {
    await openDecisions();
    const items = decisionRows();
    expect(items).toHaveLength(7);
    const outcomes = items.map((item) => item.querySelector('[data-testid="gateway-governance-decision-outcome"]'));
    expect(outcomes.map((item) => item?.textContent)).toEqual(["Blocked", "Allowed", "Reused admission", "Could not clear", "Unsupported input", "Unavailable", "Policy changed"]);
    expect(outcomes.map((item) => item?.getAttribute("data-tone"))).toEqual(["blocked", "neutral", "neutral", "failure", "neutral", "failure", "neutral"]);
    expect(outcomes[0]?.className).not.toContain("red");
    expect(outcomes[0]?.querySelector("svg")).not.toBeNull();
    expect(outcomes[3]?.className).toContain("red");
    expect(outcomes[1]?.className).not.toContain("red");
    expect(items[0].querySelector('[data-testid="gateway-governance-decision-policies"]')?.textContent).toBe("Credentials, Customer data");
    expect(items[1].querySelector('[data-testid="gateway-governance-decision-policies"]')).toBeNull();
    expect(items[0].textContent).toContain("Ada Member");
    expect(items[4].textContent).toContain("Unknown member");
    expect(items[0].querySelector("time")?.getAttribute("dateTime")).toBe(rows[0].createdAt);
    expect(view.container.textContent).not.toContain("jev-1.13.0");
    expect(view.container.textContent).not.toContain("decision_0");
    expect(document.querySelector('[data-testid="gateway-governance-decisions-more"]')).toBeNull();
  } finally { await view.close(); }
});

test("recent decisions show a skeleton while loading and an empty state", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const view = await mount(async (call) => {
    if (!call.path.startsWith(decisionsPath)) return { payload: overview() };
    await gate;
    return { payload: { decisions: [], nextCursor: null } };
  });
  try {
    const details = await openDecisions();
    expect(details.querySelector('[aria-label="Loading decisions"]')).not.toBeNull();
    await act(async () => { release(); });
    await tick();
    expect(details.querySelector('[aria-label="Loading decisions"]')).toBeNull();
    expect(details.querySelector('[data-testid="gateway-governance-decisions-empty"]')?.textContent).toBe("No decisions yet");
  } finally { await view.close(); }
});

test("a failed decision read offers retry without exposing server payloads", async () => {
  let failing = true;
  const view = await mount(decisionPages([{ decisions: [decision(0)], nextCursor: null }], () => failing));
  try {
    const details = await openDecisions();
    const error = details.querySelector('[data-testid="gateway-governance-decisions-error"]');
    expect(error?.textContent).toContain("Recent decisions could not be loaded. Try again.");
    expect(error?.querySelector('[data-notice-tone="error"]')).not.toBeNull();
    expect(details.textContent).not.toContain("private-server-details");
    expect(decisionRows()).toHaveLength(0);
    failing = false;
    await click("Try again");
    expect(details.querySelector('[data-testid="gateway-governance-decisions-error"]')).toBeNull();
    expect(decisionRows()).toHaveLength(1);
    expect(decisionCalls(view.calls)).toHaveLength(2);
  } finally { await view.close(); }
});

test("load more appends older pages with the opaque cursor and keeps rows when a later page fails", async () => {
  let failSecond = true;
  const view = await mount(decisionPages([
    { decisions: [decision(0), decision(1)], nextCursor: "page1" },
    { decisions: [decision(2)], nextCursor: "page2" },
    { decisions: [decision(3, { outcome: "blocked", failedPolicies: [{ id: "p1", revision: 1, name: "Credentials" }] })], nextCursor: null },
  ], (call) => failSecond && call.path.includes("cursor=page2")));
  try {
    await openDecisions();
    expect(decisionRows()).toHaveLength(2);
    await click("Load more decisions");
    expect(decisionCalls(view.calls).at(-1)?.path).toBe(`${decisionsPath}?limit=25&cursor=page1`);
    expect(decisionRows()).toHaveLength(3);
    await click("Load more decisions");
    expect(decisionRows()).toHaveLength(3);
    expect(document.querySelector('[data-testid="gateway-governance-decisions-error"]')).not.toBeNull();
    failSecond = false;
    await click("Try loading more again");
    expect(decisionRows().map((row) => row.querySelector('[data-testid="gateway-governance-decision-outcome"]')?.textContent)).toEqual(["Allowed", "Allowed", "Allowed", "Blocked"]);
    expect(document.querySelector('[data-testid="gateway-governance-decisions-more"]')).toBeNull();
    expect(document.querySelector('[data-testid="gateway-governance-decisions-error"]')).toBeNull();
  } finally { await view.close(); }
});

test("decision reads are organization scoped and reject malformed responses", async () => {
  expect(gatewayGovernanceDecisionsKey("org_one")).not.toEqual(gatewayGovernanceDecisionsKey("org_two"));
  expect(gatewayGovernanceDecisionsKey(orgId)).not.toEqual(gatewayGovernanceKey(orgId));
  const request = spyOn(requests, "requestJson").mockImplementation(async () => ({
    response: Response.json({ decisions: [{ ...decision(0), prompt: "private input" }], nextCursor: null }),
    payload: { decisions: [{ ...decision(0), prompt: "private input" }], nextCursor: null }, text: "",
  }));
  try {
    await expect(fetchGatewayGovernanceDecisions(orgId, "page1")).rejects.toThrow("Recent decisions could not be loaded. Try again.");
    expect(request.mock.calls[0]?.[0]).toBe(`${decisionsPath}?limit=25&cursor=page1`);
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get(ORG_SCOPE_HEADER)).toBe(orgId);
  } finally { request.mockRestore(); }
});
