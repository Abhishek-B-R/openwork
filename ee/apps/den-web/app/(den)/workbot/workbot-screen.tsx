"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  CalendarDays,
  ChevronRight,
  Home,
  LayoutGrid,
  Lock,
  Square,
} from "lucide-react";
import { z } from "zod";
import {
  runSchema,
  scheduleSchema,
  type HeadlessSchedule,
} from "@openwork-ee/headless-execution/schema";
import { DenButton } from "../_components/ui/button";
import { DenInput } from "../_components/ui/input";
import { DenTextarea } from "../_components/ui/textarea";
import { requestJson } from "../_lib/den-flow";
import { getMcpConnectionsRoute } from "../_lib/den-org";
import styles from "./workbot.module.css";

const stateSchema = z.object({
  enabled: z.boolean(),
  blockedReason: z.string().nullable(),
  runs: z.array(runSchema),
  schedules: z.array(scheduleSchema),
  files: z.array(z.string()),
});
type WorkbotState = z.infer<typeof stateSchema>;
type Tab = "Home" | "Apps" | "Calendar";
const calendarSchema = z.object({
  events: z.array(
    z.object({
      title: z.string(),
      startsAt: z.iso.datetime(),
      endsAt: z.iso.datetime(),
      source: z.string(),
    }),
  ),
  blockedReason: z.string().nullable(),
});
const errorSchema = z.object({
  message: z.string().optional(),
  error: z.string().optional(),
});
function time(date: string) {
  return new Date(date).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
class WorkbotRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function call(path: string, init: RequestInit = {}) {
  const result = await requestJson(path, init);
  if (!result.response.ok) {
    const error = errorSchema.safeParse(result.payload);
    throw new WorkbotRequestError(
      result.response.status === 401
        ? "Sign in to use your assistant."
        : error.success
          ? (error.data.message ??
            "This request could not be completed. Try again.")
          : "The connection could not be verified. Try again.",
      result.response.status,
    );
  }
  return result.payload;
}
export function WorkbotScreen() {
  const [state, setState] = useState<WorkbotState | null>(null),
    [error, setError] = useState<string | null>(null),
    [tab, setTab] = useState<Tab>("Home"),
    [connectionError, setConnectionError] = useState<string | null>(null);
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [scheduleOpen, setScheduleOpen] = useState(false),
    [edit, setEdit] = useState<HeadlessSchedule | null>(null);
  const [title, setTitle] = useState("Morning brief"),
    [task, setTask] = useState(
      "Read memory.md and draft a short plan for today. Save it as daily-brief.md. Keep the draft in this chat.",
    ),
    [interval, setIntervalMinutes] = useState("1440");
  const [firstRun, setFirstRun] = useState(""),
    [file, setFile] = useState<{ path: string; text: string } | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const refresh = useCallback(async () => {
    try {
      const next = stateSchema.parse(await call("/v1/workbot"));
      setState(next);
      setConnectionError(null);
      if (!next.enabled) {
        setFile(null);
        setScheduleOpen(false);
      }
    } catch (error) {
      if (
        error instanceof WorkbotRequestError &&
        (error.status === 401 || error.status === 403 || error.status === 404)
      ) {
        setState(null);
        setFile(null);
        setScheduleOpen(false);
      }
      setConnectionError(
        error instanceof Error
          ? error.message
          : "The connection could not be verified. Try again.",
      );
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  const running = state?.runs.find(
    (run) => run.status === "queued" || run.status === "running",
  );
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [state?.runs.length]);
  const mutate = async (path: string, body: unknown, method = "POST") => {
    setBusy(true);
    setError(null);
    try {
      await call(path, { method, body: JSON.stringify(body) });
      await refresh();
      return true;
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "This request failed. Try again.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  };
  const send = async (prompt = message) => {
    if (!prompt.trim()) return;
    const sent = await mutate("/v1/headless/runs", {
      surface: "workbot",
      conversationKey: "main",
      idempotencyKey: crypto.randomUUID(),
      prompt,
      limits: { timeoutMs: 300000 },
    });
    if (sent) setMessage("");
  };
  const openSchedule = (schedule: HeadlessSchedule | null) => {
    setEdit(schedule);
    setTitle(schedule?.title ?? "Morning brief");
    setTask(
      schedule?.prompt ??
        "Read memory.md and draft a short plan for today. Save it as daily-brief.md. Keep the draft in this chat.",
    );
    setIntervalMinutes(String(schedule?.intervalMinutes ?? 1440));
    const date = new Date(schedule?.nextRunAt ?? Date.now() + 60000);
    setFirstRun(
      new Date(date.getTime() - date.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16),
    );
    setScheduleOpen(true);
  };
  const saveSchedule = async () => {
    if (!firstRun || !Number.isFinite(Number(interval))) {
      setError("Choose a start time and repeat interval.");
      return;
    }
    const saved = await mutate(
      edit ? `/v1/workbot/schedules/${edit.id}` : "/v1/workbot/schedules",
      {
        title,
        prompt: task,
        intervalMinutes: Number(interval),
        nextRunAt: new Date(firstRun).toISOString(),
      },
      edit ? "PATCH" : "POST",
    );
    if (saved) setScheduleOpen(false);
  };
  const calendarRuns = (state?.runs ?? []).filter((run) =>
    run.prompt.startsWith("Read my connected calendar"),
  );
  const calendarAttempt = calendarRuns.at(-1);
  const latestCalendar = calendarRuns
    .slice()
    .reverse()
    .find((run) => run.status === "succeeded");
  const calendar = (() => {
    try {
      return latestCalendar?.result
        ? calendarSchema.parse(
            JSON.parse(
              latestCalendar.result.replace(/^```(?:json)?\s*|\s*```$/g, ""),
            ),
          )
        : null;
    } catch {
      return null;
    }
  })();
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <strong>Workbot</strong>
        <nav aria-label="Assistant views">
          {(
            [
              { name: "Home", icon: Home },
              { name: "Apps", icon: LayoutGrid },
              { name: "Calendar", icon: CalendarDays },
            ] satisfies Array<{ name: Tab; icon: typeof Home }>
          ).map((item) => (
            <DenButton
              key={item.name}
              variant="ghost"
              size="sm"
              icon={item.icon}
              aria-current={tab === item.name ? "page" : undefined}
              onClick={() => setTab(item.name)}
            >
              {item.name}
            </DenButton>
          ))}
        </nav>
        <DenButton href="/dashboard" variant="ghost" size="sm">
          Workspace
        </DenButton>
      </header>
      <div className={styles.body}>
        <section className={styles.conversation} aria-label="Conversation">
          <div className={styles.chatHeader}>
            <strong>Your assistant</strong>
            <span>
              {state?.enabled ? "Drafts stay in this chat" : "Team access"}
            </span>
          </div>
          {error || connectionError ? (
            <div role="alert" className={styles.error}>
              {error ?? connectionError}
              <DenButton
                variant="ghost"
                size="xs"
                onClick={() => {
                  setError(null);
                  void refresh();
                }}
              >
                Try again
              </DenButton>
              {connectionError?.startsWith("Sign in") ? (
                <DenButton href="/" size="xs">
                  Sign in
                </DenButton>
              ) : null}
            </div>
          ) : null}
          {state && !state.enabled ? (
            <div className={styles.blocked}>
              <Lock size={16} strokeWidth={1.5} />
              <span>{state.blockedReason}</span>
            </div>
          ) : null}
          <div className={styles.chat}>
            {!state && !error && !connectionError ? (
              <div
                className={styles.skeleton}
                aria-label="Checking your conversation"
              >
                <span />
                <span />
                <span />
              </div>
            ) : null}
            {tab === "Home" ? (
              <>
                {state?.runs.length === 0 ? (
                  <div className={styles.empty}>
                    <h1>What’s on your mind?</h1>
                    <DenButton
                      variant="secondary"
                      size="sm"
                      disabled={!state.enabled || busy}
                      onClick={() =>
                        void send(
                          "List my files and tell me which team tools are available through OpenWork.",
                        )
                      }
                    >
                      Show my files and team tools
                    </DenButton>
                  </div>
                ) : null}
                {state?.runs.map((run) => (
                  <article key={run.id} className={styles.turn}>
                    <div className={styles.memberMessage}>
                      {run.scheduleId ? (
                        <span className={styles.meta}>Scheduled work</span>
                      ) : null}
                      {run.prompt.startsWith("Read my connected calendar")
                        ? "Read my calendar for the next week"
                        : run.prompt}
                    </div>
                    <div className={styles.assistantMessage}>
                      {run.result ? (
                        <div className={styles.answer}>{run.result}</div>
                      ) : null}
                      <div className={styles.runState}>
                        {run.status === "queued"
                          ? "Queued"
                          : run.status === "running"
                            ? "Working"
                            : run.status === "succeeded"
                              ? `Finished${run.usage ? ` in ${Math.round(run.usage.durationMs / 1000)}s` : ""}`
                              : run.status === "cancelled"
                                ? "Stopped"
                                : (run.failure?.message ??
                                  "This run failed. Try again.")}
                      </div>
                      {run.status === "failed" || run.status === "blocked" ? (
                        <DenButton
                          size="xs"
                          variant="ghost"
                          disabled={!state.enabled || busy}
                          onClick={() => void send(run.prompt)}
                        >
                          Try again
                        </DenButton>
                      ) : null}
                      <details className={styles.details}>
                        <summary>
                          Activity <ChevronRight size={14} />
                        </summary>
                        <RunActivity id={run.id} status={run.status} />
                      </details>
                    </div>
                  </article>
                ))}
                <div ref={end} />
              </>
            ) : tab === "Apps" ? (
              <div className={styles.view}>
                <h1>Connections</h1>
                <div className={styles.row}>
                  <span>Team tools and skills</span>
                  <DenButton
                    href={getMcpConnectionsRoute()}
                    size="xs"
                    variant="ghost"
                  >
                    Manage connections
                  </DenButton>
                </div>
                <div className={styles.row}>
                  <span>Approved read actions</span>
                  <DenButton
                    size="xs"
                    variant="ghost"
                    disabled={!state?.enabled || busy}
                    onClick={() =>
                      void send(
                        "Search OpenWork for the tools and skills available to me. Identify any actions blocked for headless use.",
                      )
                    }
                  >
                    Check access
                  </DenButton>
                </div>
                <div className={styles.row}>
                  <span>Computer takeover</span>
                  <span className={styles.lock}>
                    <Lock size={14} />
                    Unavailable in this prototype
                  </span>
                </div>
                <h2>Files</h2>
                {state?.files.length ? (
                  state.files.map((path) => (
                    <div className={styles.row} key={path}>
                      <span>{path}</span>
                      <DenButton
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          void call(
                            `/v1/workbot/files?path=${encodeURIComponent(path)}`,
                          )
                            .then((value) =>
                              setFile(
                                z
                                  .object({
                                    path: z.string(),
                                    text: z.string(),
                                  })
                                  .parse(value),
                              ),
                            )
                            .catch(() =>
                              setError(
                                "This file could not be read. Try again.",
                              ),
                            )
                        }
                      >
                        Open file
                      </DenButton>
                    </div>
                  ))
                ) : (
                  <p>No files yet. Ask your assistant to save a note.</p>
                )}
                {file ? (
                  <section className={styles.file}>
                    <div className={styles.row}>
                      <strong>{file.path}</strong>
                      <DenButton
                        size="xs"
                        variant="ghost"
                        onClick={() => setFile(null)}
                      >
                        Close file
                      </DenButton>
                    </div>
                    <pre>{file.text}</pre>
                  </section>
                ) : null}
              </div>
            ) : (
              <div className={styles.view}>
                <div className={styles.row}>
                  <h1>Your week</h1>
                  <DenButton
                    size="sm"
                    variant="secondary"
                    disabled={!state?.enabled || busy || Boolean(running)}
                    onClick={() =>
                      void send(
                        'Read my connected calendar for the next 7 days using approved OpenWork tools. Return ONLY JSON with {"events":[{"title":"meeting","startsAt":"ISO datetime","endsAt":"ISO datetime","source":"connection name"}],"blockedReason":null}. Include only events returned by a real tool. If no calendar is connected or its read action is blocked, return empty events and a useful blockedReason. Do not modify the calendar.',
                      )
                    }
                  >
                    Refresh calendar
                  </DenButton>
                </div>
                {calendarAttempt?.status === "queued" ||
                calendarAttempt?.status === "running" ? (
                  <p role="status">Checking your connected calendar…</p>
                ) : calendarAttempt?.failure ? (
                  <div role="alert" className={styles.error}>
                    {calendarAttempt.failure.message}
                  </div>
                ) : null}
                {!calendar ? (
                  <div className={styles.blocked}>
                    <Lock size={16} />
                    <span>
                      Calendar not verified. Connect a calendar and approve its
                      read action with your team.
                    </span>
                  </div>
                ) : calendar.blockedReason ? (
                  <div className={styles.blocked}>
                    <Lock size={16} />
                    {calendar.blockedReason}
                  </div>
                ) : calendar.events.length === 0 ? (
                  <p>No meetings returned for this week.</p>
                ) : (
                  calendar.events.map((event, index) => (
                    <div className={styles.row} key={index}>
                      <span>
                        {event.title}
                        <small>{event.source}</small>
                      </span>
                      <time>{time(event.startsAt)}</time>
                    </div>
                  ))
                )}
                {latestCalendar && calendar ? (
                  <span className={styles.meta}>
                    Last checked{" "}
                    {time(
                      latestCalendar.finishedAt ?? latestCalendar.createdAt,
                    )}
                  </span>
                ) : null}
                <h2>Scheduled work</h2>
                {state?.schedules.map((schedule) => (
                  <div className={styles.row} key={schedule.id}>
                    <span>{schedule.title}</span>
                    <span>
                      {schedule.paused ? "Paused" : time(schedule.nextRunAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <form
            className={styles.composer}
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <DenTextarea
              aria-label="Message Workbot"
              placeholder="Message Workbot"
              rows={2}
              value={message}
              disabled={!state?.enabled || busy}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (!running) void send();
                }
              }}
            />
            <div className={styles.composerFooter}>
              <span>
                Team model <span aria-hidden>·</span> Drafts only <kbd>⏎</kbd>
              </span>
              {running ? (
                <DenButton
                  className={styles.round}
                  aria-label="Stop assistant"
                  size="sm"
                  icon={Square}
                  disabled={busy}
                  onClick={() =>
                    void mutate(`/v1/headless/runs/${running.id}/cancel`, {})
                  }
                />
              ) : (
                <DenButton
                  type="submit"
                  className={styles.round}
                  aria-label="Send message"
                  size="sm"
                  icon={ArrowUp}
                  disabled={!state?.enabled || busy || !message.trim()}
                />
              )}
            </div>
          </form>
        </section>
        <aside className={styles.sidebar}>
          <div className={styles.row}>
            <strong>Scheduled work</strong>
            <DenButton
              size="xs"
              variant="ghost"
              disabled={!state?.enabled || busy}
              onClick={() => openSchedule(null)}
            >
              Schedule work
            </DenButton>
          </div>
          {state?.schedules.length === 0 ? <p>No scheduled work yet.</p> : null}
          {state?.schedules.map((schedule) => (
            <section key={schedule.id} className={styles.job}>
              <strong>{schedule.title}</strong>
              <span>
                {schedule.paused ? "Paused" : time(schedule.nextRunAt)}
              </span>
              <details className={styles.details}>
                <summary>
                  Details <ChevronRight size={14} />
                </summary>
                <p>{schedule.prompt}</p>
                <dl>
                  <dt>Sources</dt>
                  <dd>Your files and approved team tools</dd>
                  <dt>Destination</dt>
                  <dd>A draft in this chat. You post it.</dd>
                  <dt>Repeat</dt>
                  <dd>Every {schedule.intervalMinutes} minutes</dd>
                </dl>
                <DenButton
                  variant="ghost"
                  size="xs"
                  onClick={() => openSchedule(schedule)}
                >
                  Edit
                </DenButton>
                <DenButton
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      `/v1/workbot/schedules/${schedule.id}`,
                      { paused: !schedule.paused },
                      "PATCH",
                    )
                  }
                >
                  {schedule.paused ? "Resume" : "Pause"}
                </DenButton>
                <div className={styles.history}>
                  {state.runs
                    .filter((run) => run.scheduleId === schedule.id)
                    .slice(-5)
                    .reverse()
                    .map((run) => (
                      <div key={run.id}>
                        {time(run.createdAt)} <span>{run.status}</span>
                      </div>
                    ))}
                </div>
              </details>
              <DenButton
                size="sm"
                variant="secondary"
                disabled={busy || !state.enabled}
                onClick={() =>
                  void mutate(`/v1/workbot/schedules/${schedule.id}/run`, {
                    idempotencyKey: crypto.randomUUID(),
                  })
                }
              >
                Run now
              </DenButton>
            </section>
          ))}
          {scheduleOpen ? (
            <form
              className={styles.scheduleForm}
              onSubmit={(event) => {
                event.preventDefault();
                void saveSchedule();
              }}
            >
              <label>
                Title
                <DenInput
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                />
              </label>
              <label>
                Task
                <DenTextarea
                  value={task}
                  onChange={(event) => setTask(event.target.value)}
                  required
                />
              </label>
              <label>
                First run
                <DenInput
                  type="datetime-local"
                  value={firstRun}
                  onChange={(event) => setFirstRun(event.target.value)}
                  required
                />
              </label>
              <label>
                Repeat every (minutes)
                <DenInput
                  type="number"
                  min={1}
                  max={10080}
                  value={interval}
                  onChange={(event) => setIntervalMinutes(event.target.value)}
                  required
                />
              </label>
              <div className={styles.row}>
                <DenButton size="sm" type="submit" disabled={busy}>
                  Save schedule
                </DenButton>
                <DenButton
                  variant="ghost"
                  size="sm"
                  onClick={() => setScheduleOpen(false)}
                >
                  Cancel
                </DenButton>
              </div>
            </form>
          ) : null}
          <h2>Your work</h2>
          <div className={styles.row}>
            <span>Saved files</span>
            <span>{state?.files.length ?? "—"}</span>
          </div>
          <div className={styles.row}>
            <span>Completed work</span>
            <span>
              {state?.runs.filter((run) => run.status === "succeeded").length ??
                "—"}
            </span>
          </div>
          <div className={styles.row}>
            <span>Needs attention</span>
            <span>
              {state?.runs.filter(
                (run) => run.status === "failed" || run.status === "blocked",
              ).length ?? "—"}
            </span>
          </div>
        </aside>
      </div>
    </div>
  );
}
function RunActivity({ id, status }: { id: string; status: string }) {
  const [events, setEvents] = useState<
    Array<{ sequence: number; text: string }>
  >([]);
  useEffect(() => {
    let alive = true;
    const read = () =>
      void call(`/v1/headless/runs/${id}/events`)
        .then((value) => {
          if (alive)
            setEvents(
              z
                .object({
                  events: z.array(
                    z.object({ sequence: z.number(), text: z.string() }),
                  ),
                })
                .parse(value).events,
            );
        })
        .catch(() => {});
    read();
    const timer =
      status === "running" || status === "queued"
        ? window.setInterval(read, 1500)
        : null;
    return () => {
      alive = false;
      if (timer) window.clearInterval(timer);
    };
  }, [id, status]);
  return (
    <ol>
      {events.map((event) => (
        <li key={event.sequence}>{event.text}</li>
      ))}
    </ol>
  );
}
