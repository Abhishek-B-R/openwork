import type { Seed } from "@openwork/env";
import { agentChildDesktop } from "./agent-child.ts";

/** The unrelated main pane and delegated side pane own independent drafts. */
export async function agentChildSplitDesktop(seed: Seed) {
  const base = await agentChildDesktop(seed);
  const primary = await seed.session(base.app, { title: "Independent fixture chat" });
  return { ...base, primary };
}
