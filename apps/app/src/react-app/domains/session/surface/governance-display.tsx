import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Message, MessageContent } from "@/components/ui/message";
import { holdSessionWork } from "@/app/lib/opencode-interruption";
import { governanceQueryPrefix, governanceRetryAction, governanceTitle, isGovernancePolicyBlock, readGovernanceView, type GovernanceCleanup, type GovernanceDisplayEntry } from "../sync/governance-state";

type RetryAction = "resend" | "edit";
const GovernanceDisplayContext = createContext<{
  entries: GovernanceDisplayEntry[];
  onEdit: (text: string) => void;
  onCleanup: () => Promise<void>;
  /** Removes a paused, non-violation attempt from model history, then resends or edits it. */
  onRetry?: (entry: GovernanceDisplayEntry, action: RetryAction) => Promise<void>;
  readOnly: boolean;
}>({ entries: [], onEdit: () => {}, onCleanup: async () => {}, readOnly: true });

export const GovernanceDisplayProvider = GovernanceDisplayContext.Provider;

export function useGovernanceDisplay(input: { baseUrl: string; sessionID: string; token?: string; owner: string; idle: boolean }) {
  const queryClient = useQueryClient();
  const queryKey = [...governanceQueryPrefix, input.owner, input.baseUrl, input.sessionID];
  const query = useQuery({
    queryKey, queryFn: () => readGovernanceView(input.baseUrl, input.sessionID, input.token),
    refetchInterval: (query) => !input.idle || query.state.data?.held ? 2_000 : false, retry: false,
  });
  const held = query.data?.held === true;
  // Held imperatively so a verified release is visible to the very next send.
  const release = useRef<(() => void) | null>(null);
  const syncHold = useCallback((next: boolean) => {
    if (next && !release.current) release.current = holdSessionWork(input.baseUrl, input.sessionID);
    if (!next && release.current) { release.current(); release.current = null; }
  }, [input.baseUrl, input.sessionID]);
  useEffect(() => { syncHold(held); }, [held, syncHold]);
  useEffect(() => () => { release.current?.(); release.current = null; }, [input.baseUrl, input.sessionID]);
  const run = async (cleanup: GovernanceCleanup) => {
    const next = await readGovernanceView(input.baseUrl, input.sessionID, input.token, cleanup);
    queryClient.setQueryData(queryKey, next);
    syncHold(next.held);
    return next;
  };
  const cleanup = async () => { await run(true); };
  const retry = (messageID: string) => run({ intent: "retry", messageID });
  const entries = query.data?.entries ?? [];
  const sessionRejection = entries.some((entry) => entry.correlation === "session" && entry.error);
  return { query, held, cleanup, retry, entries: entries.filter((entry) => entry.error || input.idle && !(sessionRejection && entry.correlation === "session")) };
}

function stateLine(entry: GovernanceDisplayEntry): string | null {
  const policy = isGovernancePolicyBlock(entry.error);
  if (entry.state === "excluded") return "Not included in future model context. Reattach any files to the edited message.";
  if (entry.deleteAttempted?.length && (entry.state === "cleanup_pending" || entry.state === "paused")) return "Removal couldn’t be confirmed. Check status or start a new conversation.";
  if (entry.state === "cleanup_pending") return entry.autoCleanup ? null : "Couldn’t remove this message from model history automatically.";
  if (entry.state === "unsupported") {
    if (entry.correlation === "session") return "This request can’t be safely matched to an individual message for removal. Start a new conversation; no history or file changes are reverted.";
    return policy ? "Removal couldn’t be verified safely. Start a new conversation; existing file changes are kept."
      : "This message can’t be sent again in this conversation. Start a new conversation; existing file changes are kept.";
  }
  if (governanceRetryAction(entry)) return "Not sent to the model. Nothing has been deleted.";
  return "Conversation paused. Nothing has been deleted. Start a new conversation to try an edited message.";
}

export function GovernanceMessage({ messageID }: { messageID: string }) {
  const context = useContext(GovernanceDisplayContext);
  const entry = context.entries.find((item) => item.messageID === messageID);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (!entry) return null;
  const retryAction = governanceRetryAction(entry);
  const act = (operation: () => Promise<void>, message: string) => {
    setWorking(true); setFailure(null);
    void operation().catch(() => setFailure(message)).finally(() => setWorking(false));
  };
  const line = stateLine(entry);
  const confirming = Boolean(entry.deleteAttempted?.length);
  return <Message className="mx-auto flex w-full max-w-3xl flex-col items-end gap-2 px-2 md:px-10" data-message-id={entry.messageID} data-message-role="user" data-governance-state={entry.state}>
    {entry.correlation !== "session" ? <MessageContent className="max-w-[85%] whitespace-pre-wrap bg-muted text-foreground sm:max-w-[75%]">
      {entry.text}
      {entry.files.map((file, index) => <div key={index} className="text-sm text-muted-foreground">{file.filename}</div>)}
    </MessageContent> : null}
    <Alert className="max-w-[85%] sm:max-w-[75%]">
      <LockKeyhole strokeWidth={1.5} />
      <AlertDescription>
        <div className="flex flex-col gap-2">
          <span>{governanceTitle(entry.error)}</span>
          {entry.error?.error.violations.length ? <span>{isGovernancePolicyBlock(entry.error) ? "Policies" : "Unresolved checks"}: {entry.error.error.violations.map((policy) => policy.policy_name).join("; ")}</span> : null}
          {line ? <span>{line}</span> : null}
          {failure ? <span role="status">{failure}</span> : null}
          <div className="flex gap-2">
            {entry.state === "excluded" ? <Button variant="ghost" size="xs" disabled={context.readOnly} onClick={() => context.onEdit(entry.text)}>Edit and resend</Button> : null}
            {entry.state === "cleanup_pending" && !entry.autoCleanup ? <Button variant="ghost" size="xs" disabled={working || context.readOnly}
              onClick={() => act(context.onCleanup, "Removal couldn’t be verified. Check again; no duplicate removal will be attempted.")}>
              {confirming ? "Check status" : "Remove from model history"}</Button> : null}
            {retryAction && context.onRetry ? <Button variant="ghost" size="xs" disabled={working || context.readOnly}
              onClick={() => act(() => context.onRetry?.(entry, confirming ? "edit" : retryAction) ?? Promise.resolve(), "Couldn’t verify this message was removed. Check again; it won’t be removed twice.")}>
              {confirming ? "Check status" : retryAction === "resend" ? "Try again" : "Edit message"}</Button> : null}
          </div>
        </div>
      </AlertDescription>
    </Alert>
  </Message>;
}

export function GovernedMessage({ messageID, children }: { messageID: string; children: ReactNode }) {
  const { entries } = useContext(GovernanceDisplayContext);
  return entries.some((entry) => entry.messageID === messageID) ? <GovernanceMessage messageID={messageID} /> : children;
}
