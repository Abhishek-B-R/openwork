import type {
  HeadlessActor,
  HeadlessEvent,
  HeadlessRun,
  HeadlessSurface,
} from "./contract.js";
import type { HeadlessSchedule } from "./schema.js";

export interface HeadlessFiles {
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<string>;
  list(): Promise<string[]>;
}
type Stored<T> = T | Promise<T>;
export interface RunFence {
  runId: string;
  owner: string;
}
/** Logical operations are atomic in the backing store, across API and worker replicas. */
export interface HeadlessRepository {
  insert(run: HeadlessRun): Stored<HeadlessRun>;
  scoped(actor: HeadlessActor, id: string): Stored<HeadlessRun | null>;
  conversation(
    actor: HeadlessActor,
    surface: HeadlessSurface,
    key: string,
  ): Stored<HeadlessRun[]>;
  cancel(actor: HeadlessActor, id: string): Stored<HeadlessRun | null>;
  events(id: string, after: number): Stored<HeadlessEvent[]>;
  event(id: string, kind: HeadlessEvent["kind"], text: string): Stored<void>;
  claim(
    owner: string,
    now: number,
    leaseMs: number,
  ): Stored<HeadlessRun | null>;
  owns(id: string, owner: string, now?: number): Stored<boolean>;
  heartbeat(
    id: string,
    owner: string,
    now: number,
    leaseMs: number,
  ): Stored<boolean>;
  finish(run: HeadlessRun, owner: string): Stored<boolean>;
  files(actor: HeadlessActor, fence?: RunFence): HeadlessFiles;
  schedule(actor: HeadlessActor, id: string): Stored<HeadlessSchedule | null>;
  schedules(actor: HeadlessActor): Stored<HeadlessSchedule[]>;
  saveSchedule(schedule: HeadlessSchedule): Stored<void>;
  due(now: number): Stored<HeadlessSchedule[]>;
  enqueueSchedule(schedule: HeadlessSchedule, now: number): Stored<void>;
}
