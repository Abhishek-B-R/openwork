import type { Seed } from "@openwork/env";
import { connectorBranding } from "./library.ts";

/** Own a known destination so fixture navigation cannot race the first keystroke. */
export async function connectorActivity(seed: Seed) {
  const base = await connectorBranding(seed);
  const session = await seed.session(base.app, { title: "Connector activity" });
  return { ...base, session };
}
