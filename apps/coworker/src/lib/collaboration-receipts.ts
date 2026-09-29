/**
 * The quiet lines under a conversation that say how its requested work went.
 * Many turns can end the same way ("Follow-up completed · Market scan:
 * failed"), so no line is ever repeated: finished follow-ups (completed or
 * stopped) fold into one line each with a count and what their Workers
 * reported, failures first; open or failed work that would read the same
 * becomes one line too. A line sits where the latest of its tasks was and
 * carries every task it stands for, so stopping it stops them all;
 * continuing acts on the latest.
 */
import type { CollaborationReceipt } from "./bridge.ts";
import { safeWorkLabel } from "./work-receipt.ts";

export type ReceiptLine = {
  /** The latest task this line stands for: its id keys the line and continuing acts on it. */
  latest: CollaborationReceipt;
  ids: string[];
  state: CollaborationReceipt["state"];
  text: string;
  dependencies: Array<{ id: string; text: string; groupId: string }>;
  /** Further distinct Worker outcomes folded into this line beyond those shown. */
  more: number;
};

/** How many Worker outcomes one line names before it says "N more". */
const SHOWN_DEPENDENCIES = 3;

const SETTLED = new Set<CollaborationReceipt["state"]>(["succeeded", "failed", "cancelled"]);

export function receiptIsSettled(state: CollaborationReceipt["state"]): boolean {
  return SETTLED.has(state);
}

function stateText(state: CollaborationReceipt["state"], count: number): string {
  if (state === "succeeded") return count > 1 ? `${count} follow-ups completed` : "Follow-up completed";
  if (state === "cancelled") return count > 1 ? `${count} collaborations stopped` : "Collaboration stopped";
  if (state === "failed") return count > 1 ? `${count} collaborations need attention` : "Collaboration needs attention";
  const text = state === "waiting" ? "Waiting for requested work"
    : state === "waiting-person" ? "Waiting for your answer"
    : state === "resumption-queued" ? "Results ready; follow-up queued"
    : state === "resuming" ? "Following up on the results"
    : "Requested work is running";
  return count > 1 ? `${text} (${count})` : text;
}

function dependencyName(dependency: CollaborationReceipt["dependencies"][number]): string {
  return safeWorkLabel(dependency.label, dependency.kind === "worker" ? "Worker" : "Coworker");
}

function dependencyText(dependency: CollaborationReceipt["dependencies"][number]): string {
  const name = dependencyName(dependency);
  const outcome = dependency.state === "succeeded" ? "received"
    : dependency.state === "failed" ? "failed"
    : dependency.state === "cancelled" ? "cancelled"
    : dependency.state === "waiting-person" ? "needs your input"
    : "pending";
  return `${name}: ${outcome}`;
}

type Outcome = { id: string; name: string; text: string; groupId: string; failed: boolean };

/** One line per distinct outcome, newest last, at most `limit` lines. */
export function receiptLines(receipts: readonly CollaborationReceipt[], limit = 12): ReceiptLine[] {
  const lines = new Map<string, { latest: CollaborationReceipt; ids: string[]; outcomes: Outcome[] }>();
  for (const receipt of receipts) {
    const outcomes = receipt.dependencies.map((dependency) => ({ id: dependency.id, name: dependencyName(dependency), text: dependencyText(dependency), groupId: dependency.groupId, failed: dependency.state === "failed" }));
    // Finished follow-ups are history: one line per ending. Anything still open or failed folds only with its exact twin.
    const folds = receipt.state === "succeeded" || receipt.state === "cancelled";
    const key = folds ? receipt.state : [receipt.state, ...new Set(outcomes.map((outcome) => outcome.text))].join("\u0000");
    const earlier = lines.get(key);
    // Re-inserting moves the line to where its latest task is.
    lines.delete(key);
    lines.set(key, { latest: receipt, ids: [...(earlier?.ids ?? []), receipt.id], outcomes: [...(earlier?.outcomes ?? []), ...outcomes] });
  }
  return [...lines.values()].slice(-limit).map(({ latest, ids, outcomes }) => {
    // Each Worker reads once, with how it last ended, what went wrong first.
    const seen = new Set<string>();
    const unique = outcomes.toReversed().filter((outcome) => !seen.has(outcome.name) && Boolean(seen.add(outcome.name))).toReversed();
    const ordered = [...unique.filter((outcome) => outcome.failed), ...unique.filter((outcome) => !outcome.failed)];
    return {
      latest,
      ids,
      state: latest.state,
      text: stateText(latest.state, ids.length),
      dependencies: ordered.slice(0, SHOWN_DEPENDENCIES).map(({ id, text, groupId }) => ({ id, text, groupId })),
      more: Math.max(0, ordered.length - SHOWN_DEPENDENCIES),
    };
  });
}
