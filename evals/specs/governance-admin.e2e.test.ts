import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { gatewayGovernanceOverviewSchema } from "@openwork/types/den/gateway-governance";
import { governanceAdmin } from "../worlds/governance-admin.ts";

const test = spec.world(governanceAdmin, {
  resources: { surfaces: ["web"], services: ["den"] },
  needs: { placement: "local" },
  timeout: 900_000,
});

const path = "/v1/gateway-governance";

test("an owner enables governance only after publishing a policy and approving TypeSafe processing, while a member cannot administer it", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const member = user.on(world.memberWeb);

  await step("before: the owner sees governance disabled with no policies", async () => {
    await owner.see({ testId: "gateway-governance-state" }, { text: "Disabled", timeoutMs: 90_000 });
    await owner.see({ testId: "gateway-governance-empty" });
    const response = await probe.api(world.den.admin, path);
    const data = gatewayGovernanceOverviewSchema.parse(response.body);
    expect(data.settings.enabled).toBe(false);
    expect(data.policies).toHaveLength(0);
    evidence.recordAssertionEvidence("Module configuration does not enable governance", `Enabled: ${data.settings.enabled}; policies: ${data.policies.length}; mode: ${data.availability.mode}. Evaluator configuration only, no live provider exercised.`, !data.settings.enabled && data.policies.length === 0);
    await owner.screenshot();
  });

  await step("the owner creates a draft without enabling screening", async () => {
    await owner.click({ testId: "gateway-governance-create" });
    await owner.type({ testId: "gateway-governance-name" }, "Credentials");
    await owner.type({ testId: "gateway-governance-guidance" }, "Block new user contributions that contain passwords or private keys.");
    await owner.click({ testId: "gateway-governance-save" });
    await owner.see({ testId: "gateway-governance-policy" }, { text: /\bDraft\b/, timeoutMs: 30_000 });
    await owner.see({ testId: "gateway-governance-state" }, { text: "Disabled" });
    const response = await probe.api(world.den.admin, path);
    const data = gatewayGovernanceOverviewSchema.parse(response.body);
    expect(data.policies).toHaveLength(1);
    expect(data.policies[0].status).toBe("draft");
    expect(data.settings.enabled).toBe(false);
    evidence.recordAssertionEvidence("Draft creation leaves governance disabled", `Policy: ${data.policies[0].name}; status: ${data.policies[0].status}; enabled: ${data.settings.enabled}`, !data.settings.enabled && data.policies[0].status === "draft");
    await owner.screenshot();
  });

  await step("the owner publishes the policy and governance is still disabled", async () => {
    await owner.click({ role: "button", label: "Open Credentials" });
    await owner.see({ testId: "gateway-governance-guidance" });
    await owner.click({ testId: "gateway-governance-publish" });
    await owner.see({ testId: "gateway-governance-policy" }, { text: /\bActive\b/, timeoutMs: 30_000 });
    await owner.see({ testId: "gateway-governance-state" }, { text: "Disabled" });
    const response = await probe.api(world.den.admin, path);
    const data = gatewayGovernanceOverviewSchema.parse(response.body);
    expect(data.policies[0].status).toBe("active");
    expect(data.settings.enabled).toBe(false);
    evidence.recordAssertionEvidence("Publication is separate from organization activation", `Policy status: ${data.policies[0].status}; enabled: ${data.settings.enabled}; settings revision: ${data.settings.revision}`, data.policies[0].status === "active" && !data.settings.enabled);
    await owner.screenshot();
  });

  await step("the owner reviews which data will go to TypeSafe before enabling", async () => {
    await owner.click({ testId: "gateway-governance-toggle" });
    await owner.see({ role: "alertdialog" }, { text: /sent to TypeSafe/, timeoutMs: 10_000 });
    await owner.see({ role: "alertdialog" }, { text: /even when a prompt is later blocked/ });
    const response = await probe.api(world.den.admin, path);
    const data = gatewayGovernanceOverviewSchema.parse(response.body);
    expect(data.settings.enabled).toBe(false);
    evidence.recordAssertionEvidence("Disclosure precedes activation", `Enabled while the disclosure is open: ${data.settings.enabled}`, !data.settings.enabled);
    await owner.screenshot();
  });

  await step("after: the owner explicitly approves processing and governance is enabled", async () => {
    await owner.click({ role: "button", label: "Enable governance and send to TypeSafe" });
    await owner.see({ testId: "gateway-governance-state" }, { text: "Enabled", timeoutMs: 30_000 });
    await owner.see({ role: "button", label: "Disable governance" });
    const response = await probe.api(world.den.admin, path);
    const data = gatewayGovernanceOverviewSchema.parse(response.body);
    expect(data.settings.enabled).toBe(true);
    evidence.recordAssertionEvidence("Organization opted in explicitly", `Enabled: ${data.settings.enabled}; active policies: ${data.policies.filter((policy) => policy.status === "active").length}. Administrative configuration only; evaluator and model behavior are not tested.`, data.settings.enabled);
    await owner.screenshot();
  });

  await step("a member cannot open governance management or read its private guidance", async () => {
    await member.see({ testId: "den-org-sidebar" }, { timeoutMs: 90_000 });
    await member.notSee({ role: "link", label: /AI Gateway/ });
    await member.navigate(`${world.den.ref.webUrl}/dashboard/ai-gateway?tab=governance`);
    await member.see({ testId: "den-org-sidebar" }, { timeoutMs: 30_000 });
    await member.notSee({ testId: "gateway-governance-create" });
    await member.notSee({ testId: "gateway-governance-toggle" });
    await member.notSee({ text: "Block new user contributions that contain passwords or private keys." });
    const denied = await probe.api(world.teammate, path);
    expect(denied.response.status).toBe(403);
    expect(denied.text).not.toContain("private keys");
    evidence.recordAssertionEvidence("Member is refused governance management", `GET ${path} as member: ${denied.response.status}; private guidance disclosed: ${denied.text.includes("private keys")}`, denied.response.status === 403 && !denied.text.includes("private keys"));
    await member.screenshot();
  });

  await step("the owner explicitly disables governance without deleting policies", async () => {
    await owner.click({ role: "button", label: "Disable governance" });
    await owner.see({ testId: "gateway-governance-state" }, { text: "Disabled", timeoutMs: 30_000 });
    await owner.see({ testId: "gateway-governance-policy" }, { text: /\bActive\b/ });
    const response = await probe.api(world.den.admin, path);
    const data = gatewayGovernanceOverviewSchema.parse(response.body);
    expect(data.settings.enabled).toBe(false);
    expect(data.policies[0].status).toBe("active");
    evidence.recordAssertionEvidence("Explicit disable preserves the policy", `Enabled: ${data.settings.enabled}; policy status: ${data.policies[0].status}`, !data.settings.enabled && data.policies[0].status === "active");
    await owner.screenshot();
  });
});
