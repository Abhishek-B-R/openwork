import { createContext, useContext } from "react";
import type { WorkerSummary } from "@/lib/workers";

/**
 * The Workers of the conversation on screen, and how to open one, for the
 * Worker names a reply links (worker:<id>). Absent outside a conversation.
 */
export type WorkerLinks = { workers: readonly WorkerSummary[]; open: (workerId: string) => void };

export const WorkerLinksContext = createContext<WorkerLinks | null>(null);

export function useWorkerLinks(): WorkerLinks | null {
  return useContext(WorkerLinksContext);
}
