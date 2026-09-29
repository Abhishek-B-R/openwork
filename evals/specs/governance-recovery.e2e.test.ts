import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { governanceRecovery, governanceBlockedPrompt, governanceReplacementPrompt, governanceReplacementReply } from "../worlds/governance-recovery.ts";

const test = spec.world(governanceRecovery, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, needs: { placement: "local" }, timeout: 600_000,
});

test("a member removes a blocked contribution from model history and sends a safe replacement in the same conversation", async ({ world, user, probe, step, evidence }) => {
  await step("before: the member can write a new contribution", async () => {
    await user.see("composer", { editable: true });
    const composer = await probe.composer();
    expect(composer.selectedModelLabel).toBe(world.modelName);
    evidence.recordAssertionEvidence("The assigned model routes through the real Gateway", `Selected model: ${composer.selectedModelLabel}; real app, host, native engine and Gateway; synthetic evaluator and target model.`, composer.selectedModelLabel === world.modelName);
    await user.screenshot();
  });

  await step("the member sees exactly which organization policies blocked the message", async () => {
    await user.type("composer", governanceBlockedPrompt);
    await user.click("Run task");
    await user.see({ text: "Blocked by organization policy" }, { timeoutMs: 30_000 }).catch(async (error: unknown) => {
      evidence.recordJsonArtifact("Recovery diagnostics from the synthetic fixture", { recovery: await world.recovery(), serverErrors: await world.serverErrors(), rejected: await world.rejected() });
      await user.screenshot();
      throw error;
    });
    await user.see({ text: /^Policies: (Credentials; Personal data|Personal data; Credentials)$/ });
    const rejected = await probe.eventually(() => world.rejected(), { within: 15_000, label: "Gateway records rejection before target dispatch", until: (rows) => rows.length > 0 });
    expect(await world.requests()).toHaveLength(0);
    evidence.recordAssertionEvidence("Both policies block before the target model is called", `Gateway rejected ${rejected.length} request(s); target-model requests: 0. No live TypeSafe quality claim.`, rejected.length > 0);
    await user.screenshot();
  });

  await step("OpenWork automatically removes the rejected contribution from model history while preserving its visible record", async () => {
    await user.notSee({ role: "button", label: "Remove from model history" }, { timeoutMs: 1_000 });
    await user.see({ role: "button", label: "Edit and resend" }, { timeoutMs: 30_000 }).catch(async (error: unknown) => {
      evidence.recordJsonArtifact("Native cleanup diagnostics from the synthetic fixture", { recovery: await world.recovery(), serverErrors: await world.serverErrors(), nativeState: await world.nativeState() });
      await user.screenshot();
      throw error;
    });
    const attempts = await world.primaryAttempts();
    expect(attempts).toEqual([1]);
    evidence.recordAssertionEvidence("The engine never retries a policy decision", `Primary model attempts for the blocked message: ${attempts.join(", ")} (automatic retries would show more).`, attempts.length === 1 && attempts[0] === 1);
    const messages = await probe.eventually(() => world.messages(), { within: 15_000, label: "Native history no longer contains the rejected contribution", until: (rows) => !JSON.stringify(rows).includes(governanceBlockedPrompt) });
    expect(JSON.stringify(messages)).not.toContain(governanceBlockedPrompt);
    await user.see({ text: governanceBlockedPrompt });
    evidence.recordAssertionEvidence("Display history is separate from model history", `Native history contains rejected text: ${JSON.stringify(messages).includes(governanceBlockedPrompt)}; the original blocked message is still visible.`, !JSON.stringify(messages).includes(governanceBlockedPrompt));
    await user.screenshot();
  });

  await step("after: reopening the conversation preserves exclusion and the member sends a replacement", async () => {
    await user.reload();
    await user.see({ role: "button", label: "Edit and resend" }, { timeoutMs: 60_000 });
    await user.click({ role: "button", label: "Edit and resend" });
    await probe.eventually(() => probe.composer(), { within: 10_000, label: "The blocked text is available for editing", until: (value) => value.draftText === governanceBlockedPrompt });
    await user.type("composer", governanceReplacementPrompt, { replace: true, verify: true });
    await user.click("Run task");
    await user.see({ text: governanceReplacementReply }, { timeoutMs: 60_000 });
    const allowed = await world.requests();
    expect(allowed.some((request) => request.kind === "final" && request.promptMarker === governanceReplacementPrompt)).toBe(true);
    const messages = await world.messages();
    expect(JSON.stringify(messages)).not.toContain(governanceBlockedPrompt);
    expect(JSON.stringify(messages)).toContain(governanceReplacementPrompt);
    await user.see({ text: governanceBlockedPrompt });
    evidence.recordAssertionEvidence("The replacement succeeds without resurrecting the rejected contribution", `Target-model requests: ${allowed.length}; rejected text in native history: false; local blocked record survived reload.`, allowed.length > 0 && !JSON.stringify(messages).includes(governanceBlockedPrompt));
    const decisions = await probe.eventually(() => world.decisions(), { within: 15_000, label: "Gateway records metadata-only decisions", until: (rows) => rows.some((row) => row.outcome === "blocked") && rows.some((row) => row.outcome === "allowed") });
    expect(JSON.stringify(decisions)).not.toContain(governanceBlockedPrompt);
    evidence.recordAssertionEvidence("Decision audit records outcomes without prompt content", `Outcomes: ${decisions.map((row) => row.outcome).join(", ")}; prompt text stored: false.`, !JSON.stringify(decisions).includes(governanceBlockedPrompt));
    await user.screenshot();
  });
});
