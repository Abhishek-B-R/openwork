import { useCallback, useEffect, useRef, useState } from "react";
import { coworkerBridge, type CoworkerActivityItem, type CoworkerSummary } from "@/lib/bridge";

/** How often the bubble looks for something new while it floats (the app's own inbox rests while its window is hidden). */
const LISTEN_MS = 4_000;

function speechFor(item: CoworkerActivityItem): string {
  return item.kind === "event-reminder" ? `${item.title}: ${item.preview}` : item.preview;
}

/**
 * The coworker as a floating bubble, from Focus mode. While it floats, what
 * the coworker newly has for the person (a reply, a mention, a reminder)
 * becomes its speech, newest first, each once. Tapping the bubble brings the
 * window back; the main process tells this app when it did.
 */
export function useBubble(coworker: CoworkerSummary | null): { active: boolean; enter?: () => void } {
  const [active, setActive] = useState(false);
  const since = useRef(0);
  const said = useRef(new Set<string>());

  useEffect(() => coworkerBridge.onBubble((change) => { if (!change.on) setActive(false); }), []);

  const enter = useCallback(async () => {
    if (!coworker) return;
    since.current = Date.now();
    said.current = new Set();
    setActive(true);
    try {
      const result = await coworkerBridge.appWindow.bubble(true, coworker);
      if (!result.on) setActive(false);
    } catch {
      setActive(false);
    }
  }, [coworker]);

  useEffect(() => {
    if (!active || !coworker) return;
    let stopped = false;
    const listen = async () => {
      try {
        const items = await coworkerBridge.activity.list();
        if (stopped) return;
        const fresh = items
          // Anything new since it began floating; the person has seen none of it yet.
          .filter((item) => item.at > since.current && !said.current.has(item.id) && (item.kind === "event-reminder" || item.slug === coworker.slug))
          .sort((a, b) => b.at - a.at);
        const newest = fresh[0];
        if (!newest) return;
        // Only the newest speaks; the ones before it are part of what the person will read on opening.
        for (const item of fresh) said.current.add(item.id);
        await coworkerBridge.appWindow.bubbleSay(speechFor(newest), coworker.name);
      } catch {
        // The next look tries again.
      }
    };
    void listen();
    const timer = window.setInterval(() => void listen(), LISTEN_MS);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [active, coworker]);

  const start = useCallback(() => void enter(), [enter]);
  return { active, enter: coworker ? start : undefined };
}
