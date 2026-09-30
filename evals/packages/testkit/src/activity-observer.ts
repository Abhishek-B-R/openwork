import { browserScript } from "@openwork/cdp";
import type { Probe } from "./spec/types.ts";

/** Fixed read-only screen observation for continuity between eventual assertions. */
export async function observeActivity(probe: Probe) {
  const key: `activity-observer-${string}` = `activity-observer-${crypto.randomUUID()}`;
  await probe.eval(browserScript((key: `activity-observer-${string}`) => {
    const samples: { at: number; working: string | null; liveHeight: number | null; railHeight: number | null; railExpanded: boolean; helperRow: boolean; rows: string[]; visibleRows: string[]; replacements: string[] }[] = [];
    const elements = new Map<string, Element>();
    const started = performance.now();
    const sample = () => {
      const shell = document.querySelector<HTMLElement>("[data-live-steps]");
      const rail = shell?.querySelector<HTMLElement>("[data-steps-rail]");
      const railExpanded = Boolean(rail && !rail.hidden && getComputedStyle(rail).display !== "none");
      const rows = [...(shell?.querySelectorAll<HTMLElement>("[data-step-identity], [data-code-mode-invocation]") ?? [])];
      const replacements: string[] = [];
      for (const row of rows) {
        const id = row.dataset.stepIdentity ?? row.dataset.codeModeInvocation!;
        if (elements.has(id) && elements.get(id) !== row) replacements.push(id);
        elements.set(id, row);
      }
      if (samples.length < 3_600) samples.push({ at: Math.round(performance.now() - started),
        working: shell?.querySelector("[data-working-line]")?.textContent?.match(/Working\s*\d+(?:m\s*\d+)?s/)?.[0] ?? null,
        liveHeight: shell ? Math.round(shell.getBoundingClientRect().height) : null,
        railHeight: railExpanded && rail ? Math.round(rail.getBoundingClientRect().height) : null, railExpanded,
        helperRow: Boolean(shell?.querySelector("[data-subagent-run]")),
        rows: rows.map(row => row.dataset.stepIdentity ?? row.dataset.codeModeInvocation!),
        visibleRows: rows.filter(row => row.getBoundingClientRect().height > 0 && row.getBoundingClientRect().width > 0)
          .map(row => row.dataset.stepIdentity ?? row.dataset.codeModeInvocation!), replacements });
    };
    const interval = setInterval(sample, 50);
    const timeout = setTimeout(() => clearInterval(interval), 180_000);
    sample();
    window[key] = { samples, stop() { clearInterval(interval); clearTimeout(timeout); } };
  }, [key]));
  return {
    read() { return probe.eval(browserScript((key: `activity-observer-${string}`) => window[key]?.samples ?? [], [key])); },
    async finish() { return probe.eval(browserScript((key: `activity-observer-${string}`) => {
      const observer = window[key];
      if (!observer) throw new Error("Activity observation was lost");
      observer.stop(); delete window[key]; return observer.samples;
    }, [key])); },
    async [Symbol.asyncDispose]() { await probe.eval(browserScript((key: `activity-observer-${string}`) => { window[key]?.stop(); delete window[key]; }, [key])); },
  };
}

/** Observe command admission without collecting prompts, credentials or payloads. */
export async function observeSessionCommands(probe: Probe) {
  const key: `command-observer-${string}` = `command-observer-${crypto.randomUUID()}`;
  await probe.eval(browserScript((key: `command-observer-${string}`) => {
    const requests: { method: string; path: string }[] = [];
    const original = window.fetch;
    const wrapped: typeof fetch = (...args) => {
      const input = args[0];
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = args[1]?.method ?? (input instanceof Request ? input.method : "GET");
      if (method !== "GET" && /\/session\/[^/]+\/(?:prompt|prompt_async|abort|interrupt)$/.test(url.pathname)) requests.push({ method, path: url.pathname });
      return original.apply(window, args);
    };
    window.fetch = wrapped;
    window[key] = { requests, stop() { if (window.fetch === wrapped) window.fetch = original; } };
  }, [key]));
  return {
    read() { return probe.eval(browserScript((key: `command-observer-${string}`) => window[key]?.requests ?? [], [key])); },
    async [Symbol.asyncDispose]() { await probe.eval(browserScript((key: `command-observer-${string}`) => { window[key]?.stop(); delete window[key]; }, [key])); },
  };
}
