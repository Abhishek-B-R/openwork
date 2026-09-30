import { useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { SubagentRunLine } from "./subagent-run-line";
import { agentInventory, agentResultVersion } from "@/lib/agent-inventory";
import { taskChildSessionId } from "@/lib/build-in-tools";
import { isToolPartInFlight } from "@/lib/tool-activity";
import { runElapsed } from "@/lib/session-run";
import { formatElapsedSeconds } from "@/lib/tool-call-duration";
import { useSessionActivityStore } from "@/react-app/domains/session/status/session-activity-store";

export function AgentTray({ workspaceId, sessionId, owner, messages, syncDegraded, onOpen, onStop }: {
  workspaceId: string; sessionId: string; owner: string | null; messages: UIMessage[]; syncDegraded: boolean;
  onOpen?: (id: string) => void; onStop: (id: string) => Promise<void>;
}) {
  const records = useSessionActivityStore(state => state.recordsByWorkspaceId[workspaceId]);
  const inventory = useMemo(() => agentInventory(sessionId, messages, records), [sessionId, messages, records]);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [seen, setSeen] = useState<Record<string, string>>({});
  const [stopping, setStopping] = useState(false);
  const [failures, setFailures] = useState<Record<string, string>>({});
  const order = useRef<string[]>([]);
  const key = owner ? `openwork:agent-results:${owner}` : null;
  useEffect(() => {
    const refresh = () => {
      try {
        const saved: unknown = key ? JSON.parse(localStorage.getItem(key) ?? "{}") : {};
        setSeen(saved && typeof saved === "object" && !Array.isArray(saved)
          ? Object.fromEntries(Object.entries(saved).filter(([, version]) => typeof version === "string")) : {});
      } catch { setSeen({}); }
    };
    refresh();
    const onStorage = (event: StorageEvent) => { if (event.key === key) refresh(); };
    window.addEventListener("storage", onStorage);
    order.current = [];
    setOpen(false);
    return () => window.removeEventListener("storage", onStorage);
  }, [key, sessionId]);
  useEffect(() => {
    if (syncDegraded) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [syncDegraded]);
  for (const part of inventory) {
    const id = taskChildSessionId(part)!;
    if (!order.current.includes(id)) order.current.push(id);
  }
  const parts = [...inventory].sort((left, right) => order.current.indexOf(taskChildSessionId(left)!) - order.current.indexOf(taskChildSessionId(right)!));
  const active = parts.filter(part => {
    const child = records?.[taskChildSessionId(part)!];
    return child?.runActive || !child && !part.callProviderMetadata?.openwork?.inventoryOnly && isToolPartInFlight(part);
  });
  const needs = parts.filter(part => {
    const child = records?.[taskChildSessionId(part)!];
    return (child?.waitingPermissionIds.length ?? 0) + (child?.waitingQuestionIds.length ?? 0) > 0;
  });
  const unread = parts.filter(part => {
    const id = taskChildSessionId(part)!;
    const version = agentResultVersion(part, records?.[id]);
    return version && seen[id] !== version;
  });
  const parent = records?.[sessionId];
  const oldest = active.map(part => records?.[taskChildSessionId(part)!]).filter(child => child !== undefined)
    .sort((left, right) => left.runStartedAt - right.runStartedAt)[0];
  const timed = parent?.runActive ? parent : oldest;
  const run = timed?.currentRunId ? timed.runs[timed.currentRunId] : undefined;
  const elapsed = run ? Math.floor(runElapsed(run, now) / 1_000) : timed?.runStartedAt ? Math.max(0, Math.floor((now - timed.runStartedAt) / 1_000)) : null;
  if (!parts.length || !open && !active.length && !needs.length && !unread.length) return null;
  const openResult = (id: string) => {
    const part = parts.find(part => taskChildSessionId(part) === id);
    const version = part ? agentResultVersion(part, records?.[id]) : null;
    if (version && onOpen) {
      const next = { ...seen, [id]: version };
      setSeen(next);
      if (key) try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Optional read markers. */ }
    }
    onOpen?.(id);
  };
  const retryStop = (id: string) => {
    setFailures(current => Object.fromEntries(Object.entries(current).filter(([child]) => child !== id)));
    return onStop(id);
  };
  return <div data-agent-tray className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
    <div className="flex h-6 items-center gap-2">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        {active.length} {active.length === 1 ? "agent" : "agents"} working {elapsed !== null ? `· ${formatElapsedSeconds(elapsed)}` : ""}
      </button>
      {needs.length ? <button type="button" className="rounded bg-amber-4 px-1.5 py-0.5 text-amber-11" onClick={() => setOpen(true)}>{needs.length} needs you</button> : null}
      {unread.length ? <button type="button" onClick={() => setOpen(true)}>See results · {unread.length}</button> : null}
      {active.length ? <button type="button" className="ms-auto" disabled={stopping || syncDegraded} onClick={() => {
        setStopping(true);
        const targets = active.map(part => taskChildSessionId(part)!);
        void Promise.allSettled(targets.map(onStop)).then(results => {
          const errors: Record<string, string> = {};
          results.forEach((result, index) => { if (result.status === "rejected") errors[targets[index]!] = "Could not stop — retry on this row"; });
          setFailures(errors);
        }).finally(() => setStopping(false));
      }}>{stopping ? "Stopping…" : "Stop all"}</button> : null}
    </div>
    {open ? <div data-agent-tray-rows>{parts.map(part => {
      const id = taskChildSessionId(part)!;
      return <div key={id}>
        <SubagentRunLine part={part} parentActive={Boolean(parent?.runActive)} stopFailure={failures[id]}
          actions={{ workspaceId, syncDegraded, onOpenSubagentSession: onOpen ? openResult : undefined, onStopSubagentSession: retryStop }}
          onNeedsUser={(id, kind, requestId) => {
            const child = records?.[id];
            if ((kind === "permission" ? child?.waitingPermissionIds : child?.waitingQuestionIds)?.includes(requestId)) onOpen?.(id);
          }} />
      </div>;
    })}</div> : null}
  </div>;
}
