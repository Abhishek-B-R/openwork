"use client";

import { Separator } from "@base-ui/react/separator";
import {
  MAX_GATEWAY_GOVERNANCE_ACTIVE_POLICIES,
  gatewayGovernancePolicyWriteSchema,
  type GatewayGovernanceDecision,
  type GatewayGovernanceDecisionOutcome,
  type GatewayGovernanceOverview,
  type GatewayGovernancePolicy,
  type GatewayGovernancePolicyWrite,
} from "@openwork/types/den/gateway-governance";
import { ChevronRight, CircleAlert, Lock } from "lucide-react";
import { useId, useRef, useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "../../_components/ui/empty";
import { Field, FieldError, FieldGroup, FieldLabel } from "../../_components/ui/field";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenTextarea } from "../../_components/ui/textarea";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { ConfirmDialog, ItemRowsSkeleton } from "./item-list";
import {
  GatewayGovernanceRequestError,
  GatewayGovernanceWriteUncertainError,
  useGatewayGovernance,
  useGatewayGovernanceDecisions,
  useGatewayGovernanceMutation,
  type GatewayGovernanceAction,
} from "./gateway-governance-data";

const reasons: Record<GatewayGovernanceOverview["availability"]["reason"], string> = {
  ready: "Configuration available; evaluator not tested here.",
  enterprise_required: "Enterprise required. Ask your workspace owner to arrange an Enterprise plan.",
  module_disabled: "Governance module disabled. Ask your deployment administrator to enable it.",
  evaluator_unavailable: "Evaluator unavailable. Ask your deployment administrator to check the TypeSafe configuration.",
  processing_approval_required: "Processing approval required. Ask your deployment administrator to approve the applicable TypeSafe processing terms.",
  thresholds_required: "Decision thresholds required. Ask your deployment administrator to configure calibrated thresholds.",
};

const policyStatuses: Record<GatewayGovernancePolicy["status"], string> = { draft: "Draft", active: "Active", archived: "Archived" };

const outcomes: Record<GatewayGovernanceDecisionOutcome, { label: string; tone: "neutral" | "blocked" | "failure" }> = {
  allowed: { label: "Allowed", tone: "neutral" },
  receipt_reused: { label: "Reused admission", tone: "neutral" },
  blocked: { label: "Blocked", tone: "blocked" },
  uncertain: { label: "Could not clear", tone: "failure" },
  unsupported_input: { label: "Unsupported input", tone: "neutral" },
  unavailable: { label: "Unavailable", tone: "failure" },
  policy_changed: { label: "Policy changed", tone: "neutral" },
};

const decisionTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

type Editor = { policy?: GatewayGovernancePolicy; name: string; guidance: string };

export function GatewayGovernanceLoading() {
  return <ItemRowsSkeleton label="Loading governance" rows={3} />;
}

export function GatewayGovernanceSection({ orgId }: { orgId: string }) {
  return <Governance key={orgId} orgId={orgId} />;
}

function Governance({ orgId }: { orgId: string }) {
  const overview = useGatewayGovernance(orgId);
  const mutation = useGatewayGovernanceMutation(orgId);
  const { runReauthableAction, reauthDialogOpen } = useOrgDashboard();
  const id = useId();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [completion, setCompletion] = useState<string | null>(null);
  const [enableRevision, setEnableRevision] = useState<number | null>(null);
  const data = overview.data;
  const needsReview = error instanceof GatewayGovernanceWriteUncertainError
    || (error instanceof GatewayGovernanceRequestError && error.status === 409);
  const blocked = busy || needsReview || overview.isError || overview.isFetching;
  const stateLabel = busy ? "Saving…" : needsReview || overview.isError
    ? `Last confirmed ${data?.settings.enabled ? "enabled" : "disabled"}`
    : data?.settings.enabled ? "Enabled" : "Disabled";
  const available = data?.availability.available === true && data.availability.reason === "ready" && data.availability.mode !== "disabled";
  const activeCount = data?.policies.filter((policy) => policy.status === "active").length ?? 0;
  const latest = data?.policies.find((policy) => policy.id === editor?.policy?.id);
  const editorChanged = Boolean(editor?.policy && (!latest || latest.revision !== editor.policy.revision));
  const validation = gatewayGovernancePolicyWriteSchema.safeParse({ name: editor?.name ?? "", guidance: editor?.guidance ?? "" });
  const issues = submitted && !validation.success ? validation.error.issues : [];
  const fieldError = (field: string) => issues.find((issue) => issue.path[0] === field)?.message;

  async function write(action: GatewayGovernanceAction, message: string) {
    if (inFlight.current || blocked) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setCompletion(null);
    try {
      await runReauthableAction("gateway-governance", async () => { await mutation.mutateAsync(action); });
      setEditor(null);
      setSubmitted(false);
      setCompletion(message);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Governance could not be updated. Refresh to verify the current state."));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function refresh() {
    if (inFlight.current) return;
    const result = await overview.refetch();
    if (result.isSuccess) {
      setError(null);
      setEnableRevision(null);
      if (needsReview && !editor?.policy) setEditor(null);
      setCompletion("Current state refreshed. Review the saved policies before making another change.");
    }
  }

  function openEditor(policy?: GatewayGovernancePolicy) {
    setEditor({ policy, name: policy?.name ?? "", guidance: policy?.guidance ?? "" });
    setSubmitted(false);
    setCompletion(null);
  }

  function save() {
    setSubmitted(true);
    if (!editor || !validation.success || blocked || !available || editorChanged) return;
    const body: GatewayGovernancePolicyWrite = validation.data;
    void write(editor.policy ? { type: "edit", policy: editor.policy, body } : { type: "create", body }, editor.policy ? "Changes saved." : "Draft created. Governance remains unchanged.");
  }

  if (!data && overview.isPending) return <GatewayGovernanceLoading />;
  if (!data) return (
    <section aria-label="Governance" className="flex flex-col items-start gap-3" data-testid="gateway-governance-unavailable">
      <DenNotice tone="error" message={overview.error?.message ?? "Governance could not be verified. Refresh to try again."} />
      <DenButton variant="secondary" onClick={() => void refresh()} disabled={overview.isFetching}>Refresh current state</DenButton>
    </section>
  );

  return (
    <section aria-label="Governance" data-testid="gateway-governance" aria-busy={busy} className="flex flex-col gap-4 text-sm text-[var(--dls-text-primary)]">
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-3">
        <h2 className="font-medium">Governance</h2>
        <div className="flex items-center gap-4">
          <span role="status" data-testid="gateway-governance-state">{stateLabel}</span>
          <DenButton variant={data.settings.enabled ? "secondary" : "primary"} size="sm" disabled={blocked || (!data.settings.enabled && !available)} data-testid="gateway-governance-toggle" onClick={() => {
            if (data.settings.enabled) void write({ type: "settings", body: { expectedRevision: data.settings.revision, enabled: false } }, "Governance disabled.");
            else setEnableRevision(data.settings.revision);
          }}>{data.settings.enabled ? "Disable governance" : "Enable governance"}</DenButton>
        </div>
      </div>
      {!available ? (
        <div role="status" className="flex items-start gap-2 text-[var(--dls-text-secondary)]" data-testid="gateway-governance-locked">
          <Lock className="size-4 shrink-0" strokeWidth={1.5} aria-hidden />
          <p>{reasons[data.availability.reason]}{data.settings.enabled ? " Governance is still enabled; new requests cannot proceed until availability is restored or an administrator explicitly disables it." : " Governance is not enabled by plan or module changes."}</p>
        </div>
      ) : null}
      {overview.isError || error ? (
        <div className="flex flex-col items-start gap-3" data-testid="gateway-governance-recovery">
          <DenNotice tone={needsReview ? "neutral" : "error"} message={error?.message ?? overview.error?.message} />
          <p className="text-[var(--dls-text-secondary)]">Last confirmed {new Date(overview.dataUpdatedAt).toLocaleString()}. The displayed state may be out of date.</p>
          <DenButton variant="secondary" size="sm" disabled={busy || overview.isFetching} onClick={() => void refresh()}>Refresh current state</DenButton>
        </div>
      ) : completion ? <p role="status" className="text-[var(--dls-text-secondary)]">{completion}</p> : null}
      <Separator className="h-px bg-[var(--dls-border)]" />
      <div className="flex min-h-10 items-center justify-between gap-3">
        <h3 className="font-medium">Policies</h3>
        <span className="text-[var(--dls-text-secondary)]">{activeCount} of {MAX_GATEWAY_GOVERNANCE_ACTIVE_POLICIES} active</span>
        {data.policies.length > 0 ? <DenButton size="sm" variant="secondary" disabled={blocked || !available || editor !== null} onClick={() => openEditor()} data-testid="gateway-governance-create">Create policy</DenButton> : null}
      </div>
      {data.policies.length === 0 && !editor ? (
        <Empty data-testid="gateway-governance-empty">
          <EmptyHeader><EmptyTitle>No policies yet</EmptyTitle></EmptyHeader>
          <EmptyContent><DenButton size="sm" variant="secondary" disabled={blocked || !available} onClick={() => openEditor()} data-testid="gateway-governance-create">Create policy</DenButton></EmptyContent>
        </Empty>
      ) : (
        <ul className="divide-y divide-[var(--dls-border)]">
          {data.policies.map((policy) => (
            <li key={policy.id} className="flex min-h-12 items-center gap-3 py-2" data-testid="gateway-governance-policy">
              <span className="min-w-0 flex-1 break-words">{policy.name}</span>
              <span className="text-[var(--dls-text-secondary)]">{policyStatuses[policy.status]}</span>
              <DenButton variant="ghost" size="sm" disabled={busy || editor !== null} aria-label={`Open ${policy.name}`} onClick={() => openEditor(policy)}>Open policy</DenButton>
            </li>
          ))}
        </ul>
      )}
      {editor ? (
        <form className="flex flex-col gap-4 py-4" data-testid="gateway-governance-editor" onSubmit={(event) => { event.preventDefault(); save(); }}>
          <h3 className="font-medium">{editor.policy ? "Edit policy" : "Create draft policy"}</h3>
          <FieldGroup>
            <Field data-invalid={Boolean(fieldError("name"))} data-disabled={busy || !available}>
              <FieldLabel htmlFor={`${id}-name`}>Policy name</FieldLabel>
              <DenInput id={`${id}-name`} data-testid="gateway-governance-name" maxLength={120} value={editor.name} disabled={busy || !available} aria-invalid={Boolean(fieldError("name"))} aria-describedby={fieldError("name") ? `${id}-name-error` : undefined} onChange={(event) => setEditor({ ...editor, name: event.target.value })} />
              <FieldError id={`${id}-name-error`}>{fieldError("name")}</FieldError>
            </Field>
            <Field data-invalid={Boolean(fieldError("guidance"))} data-disabled={busy || !available}>
              <FieldLabel htmlFor={`${id}-guidance`}>Evaluation guidance</FieldLabel>
              <DenTextarea id={`${id}-guidance`} data-testid="gateway-governance-guidance" rows={5} maxLength={4000} value={editor.guidance} disabled={busy || !available} aria-invalid={Boolean(fieldError("guidance"))} aria-describedby={fieldError("guidance") ? `${id}-guidance-error` : undefined} onChange={(event) => setEditor({ ...editor, guidance: event.target.value })} />
              <FieldError id={`${id}-guidance-error`}>{fieldError("guidance")}</FieldError>
            </Field>
          </FieldGroup>
          <p className="text-[var(--dls-text-secondary)]">{editor.policy?.status === "active" ? "Saving changes updates this active policy for new submissions." : "Creating or publishing a policy does not enable governance."} Members see failed policy names, not this guidance.</p>
          {editorChanged ? (
            <div className="flex flex-col items-start gap-2" role="status">
              <p>This policy changed elsewhere. Your unsaved text is still shown.</p>
              {latest ? <DenButton variant="secondary" size="sm" disabled={blocked} onClick={() => openEditor(latest)}>Discard edits and use latest policy</DenButton> : <p>Close the editor and review the current policies.</p>}
            </div>
          ) : null}
          {activeCount >= MAX_GATEWAY_GOVERNANCE_ACTIVE_POLICIES && editor.policy?.status !== "active" ? <p role="status">Archive an active policy before publishing another.</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <DenButton type="submit" size="sm" disabled={blocked || !available || editorChanged} data-testid="gateway-governance-save">{editor.policy ? "Save changes" : "Create draft"}</DenButton>
            {editor.policy && editor.policy.status !== "active" ? <DenButton size="sm" variant="secondary" disabled={blocked || !available || editorChanged || activeCount >= MAX_GATEWAY_GOVERNANCE_ACTIVE_POLICIES || editor.name !== editor.policy.name || editor.guidance !== editor.policy.guidance} data-testid="gateway-governance-publish" onClick={() => { if (editor.policy) void write({ type: "publish", policy: editor.policy }, "Policy published. Governance remains unchanged."); }}>Publish policy</DenButton> : null}
            {editor.policy && editor.policy.status !== "archived" ? <DenButton size="sm" variant="secondary" disabled={blocked || !available || editorChanged} data-testid="gateway-governance-archive" onClick={() => { if (editor.policy) void write({ type: "archive", policy: editor.policy }, "Policy archived."); }}>Archive policy</DenButton> : null}
            <DenButton size="sm" variant="ghost" disabled={busy} onClick={() => setEditor(null)}>Close editor</DenButton>
          </div>
        </form>
      ) : null}
      <RecentDecisions orgId={orgId} />
      <details className="group" data-testid="gateway-governance-scope">
        <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded focus-visible:ring-2 focus-visible:ring-[var(--dls-accent)]"><ChevronRight className="size-4 group-open:rotate-90" strokeWidth={1.5} aria-hidden />Screening scope</summary>
        <div className="flex flex-col gap-2 py-3 text-[var(--dls-text-secondary)]">
          <p>Active policies apply to everyone in this organization. Only new user text and supported directly attached text sent through Gateway are evaluated.</p>
          <p>Historical messages, tool results, assistant output and direct-provider traffic are not screened. With no active policies, no policy evaluation runs.</p>
          <p>{available ? reasons.ready : reasons[data.availability.reason]}</p>
        </div>
      </details>
      <ConfirmDialog confirm={enableRevision !== null && !reauthDialogOpen ? {
        title: "Enable governance?",
        description: "New user prompts, supported directly attached text and active policy guidance will be sent to TypeSafe for evaluation, even when a prompt is later blocked from reaching the selected model. Disabling governance stops future evaluation; it cannot recall data already sent. This does not screen conversation history, tool results or model output.",
        action: "Enable governance and send to TypeSafe",
      } : null} onClose={() => setEnableRevision(null)} onConfirm={async () => {
        if (enableRevision === null || !available) return;
        await write({ type: "settings", body: { expectedRevision: enableRevision, enabled: true, processingAcknowledged: true } }, "Governance enabled.");
      }} />
    </section>
  );
}

function DecisionOutcome({ outcome }: { outcome: GatewayGovernanceDecisionOutcome }) {
  const { label, tone } = outcomes[outcome];
  return (
    <span className={`flex w-40 shrink-0 items-center gap-1.5 ${tone === "failure" ? "text-red-700" : "text-[var(--dls-text-primary)]"}`} data-tone={tone} data-testid="gateway-governance-decision-outcome">
      {tone === "blocked" ? <Lock className="size-4 shrink-0 text-[var(--dls-text-secondary)]" strokeWidth={1.5} aria-hidden /> : null}
      {tone === "failure" ? <CircleAlert className="size-4 shrink-0" strokeWidth={1.5} aria-hidden /> : null}
      {label}
    </span>
  );
}

function DecisionRow({ decision }: { decision: GatewayGovernanceDecision }) {
  const failed = decision.failedPolicies.map((policy) => policy.name).join(", ");
  return (
    <li className="flex min-h-10 flex-wrap items-center gap-x-4 gap-y-1 py-2" data-testid="gateway-governance-decision">
      <time dateTime={decision.createdAt} className="w-44 shrink-0 tabular-nums text-[var(--dls-text-secondary)]">{decisionTime.format(new Date(decision.createdAt))}</time>
      <DecisionOutcome outcome={decision.outcome} />
      <span className="min-w-0 flex-1 truncate">{decision.memberName ?? "Unknown member"}</span>
      {failed ? <span className="min-w-0 max-w-full truncate text-[var(--dls-text-secondary)]" title={failed} data-testid="gateway-governance-decision-policies">{failed}</span> : null}
    </li>
  );
}

function RecentDecisions({ orgId }: { orgId: string }) {
  const [open, setOpen] = useState(false);
  const decisions = useGatewayGovernanceDecisions(orgId, open);
  const rows = decisions.data?.pages.flatMap((page) => page.decisions) ?? [];
  return (
    <details className="group" data-testid="gateway-governance-decisions" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded focus-visible:ring-2 focus-visible:ring-[var(--dls-accent)]"><ChevronRight className="size-4 group-open:rotate-90" strokeWidth={1.5} aria-hidden />Recent decisions</summary>
      {!open ? null : decisions.isPending ? (
        <ItemRowsSkeleton label="Loading decisions" rows={3} />
      ) : decisions.isError && rows.length === 0 ? (
        <div className="flex flex-col items-start gap-3 py-3" data-testid="gateway-governance-decisions-error">
          <DenNotice tone="error" message={decisions.error.message} />
          <DenButton variant="secondary" size="sm" disabled={decisions.isFetching} onClick={() => void decisions.refetch()}>Try again</DenButton>
        </div>
      ) : rows.length === 0 ? (
        <Empty data-testid="gateway-governance-decisions-empty">
          <EmptyHeader><EmptyTitle>No decisions yet</EmptyTitle></EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col items-start gap-3 pb-3">
          <ul className="w-full divide-y divide-[var(--dls-border)]" aria-label="Recent decisions">
            {rows.map((decision) => <DecisionRow key={decision.decisionId} decision={decision} />)}
          </ul>
          {decisions.isFetchNextPageError ? (
            <div className="flex flex-col items-start gap-3" data-testid="gateway-governance-decisions-error">
              <DenNotice tone="error" message={decisions.error?.message ?? "Recent decisions could not be loaded. Try again."} />
            </div>
          ) : null}
          {decisions.hasNextPage ? (
            <DenButton variant="secondary" size="sm" disabled={decisions.isFetchingNextPage} data-testid="gateway-governance-decisions-more" onClick={() => void decisions.fetchNextPage()}>
              {decisions.isFetchNextPageError ? "Try loading more again" : "Load more decisions"}
            </DenButton>
          ) : null}
        </div>
      )}
    </details>
  );
}
