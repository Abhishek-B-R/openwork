"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Popover } from "@base-ui/react/popover";
import {
  ArrowUp,
  CalendarDays,
  ChevronRight,
  Clock3,
  FileText,
  LayoutGrid,
  Link2,
  Lock,
  Plus,
  Square,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod";
import type { HeadlessRun } from "@openwork-ee/headless-execution/contract";
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
import { useDenFlow } from "../_providers/den-flow-provider";
import styles from "./workbot.module.css";

const stateSchema = z.object({
  enabled: z.boolean(),
  blockedReason: z.string().nullable(),
  runs: z.array(runSchema),
  schedules: z.array(scheduleSchema),
  files: z.array(z.string()),
});
const fileSchema = z.object({ path: z.string(), text: z.string() });
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
const calendarPrompt =
  'Read my connected calendar for the next 7 days using approved OpenWork tools. Return ONLY JSON with {"events":[{"title":"meeting","startsAt":"ISO datetime","endsAt":"ISO datetime","source":"connection name"}],"blockedReason":null}. Include only events returned by a real tool. If no calendar is connected or its read action is blocked, return empty events and a useful blockedReason. Do not modify the calendar.';

function time(date: string) {
  return new Date(date).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
function chatTime(date: string) {
  const value = new Date(date);
  const today = value.toDateString() === new Date().toDateString();
  return `${today ? "Today" : value.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${value.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}
function fileTitle(path: string) {
  const name =
    path
      .split("/")
      .at(-1)
      ?.replace(/\.[^.]+$/, "")
      .replace(/[-_]/g, " ") ?? path;
  return name.charAt(0).toUpperCase() + name.slice(1);
}
function repeatLabel(minutes: number) {
  if (minutes === 1440) return "Every day";
  if (minutes === 10080) return "Every week";
  if (minutes % 60 === 0) return `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
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
        ? "Sign in to chat with Workbot."
        : error.success
          ? (error.data.message ?? "That didn’t go through. Please try again.")
          : "I couldn’t connect. Please try again.",
      result.response.status,
    );
  }
  return result.payload;
}

export function ChatText({
  text,
  files = [],
  onOpen,
}: {
  text: string;
  files?: string[];
  onOpen?: (path: string) => void;
}) {
  return (
    <div className={styles.markdown}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const path = files.find(
              (file) => href === file || href === `./${file}`,
            );
            return path && onOpen ? (
              <button
                className={styles.inlineLink}
                onClick={() => onOpen(path)}
              >
                {children}
              </button>
            ) : (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
          img: ({ alt }) => <span>{alt}</span>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
function Typing() {
  return (
    <div
      className={styles.typing}
      role="status"
      aria-label="Workbot is replying"
    >
      <span />
      <span />
      <span />
    </div>
  );
}
function DraftCard({
  path,
  onOpen,
  onEdit,
}: {
  path: string;
  onOpen: (path: string) => void;
  onEdit: (path: string) => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void call(`/v1/workbot/files?path=${encodeURIComponent(path)}`)
      .then((value) => {
        const file = fileSchema.parse(value);
        if (active)
          setPreview(
            file.text
              .replace(/^#+\s+.*\n?/m, "")
              .replace(/[\n*_`#]+/g, " ")
              .trim()
              .slice(0, 180),
          );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [path]);
  return (
    <div className={styles.draftCard}>
      <div className={styles.draftContent}>
        <span className={styles.draftLabel}>
          <FileText size={14} strokeWidth={1.5} /> Saved draft
        </span>
        <strong>{fileTitle(path)}</strong>
        <span className={styles.draftPreview}>{preview ?? path}</span>
      </div>
      <div className={styles.draftActions}>
        <DenButton variant="ghost" size="sm" onClick={() => onOpen(path)}>
          Open
        </DenButton>
        <DenButton variant="ghost" size="sm" onClick={() => onEdit(path)}>
          Edit together
        </DenButton>
      </div>
    </div>
  );
}

export function WorkbotReply({
  run,
  files,
  canRetry,
  onOpen,
  onEdit,
  onRetry,
}: {
  run: HeadlessRun;
  files: string[];
  canRetry: boolean;
  onOpen: (path: string) => void;
  onEdit: (path: string) => void;
  onRetry: () => void;
}) {
  const drafts = files.filter((path) => path !== "memory.md");
  return (
    <div className={styles.assistantMessage}>
      {run.result ? (
        <>
          <div className={styles.assistantBubble}>
            <ChatText text={run.result} files={files} onOpen={onOpen} />
          </div>
          {drafts
            .filter((path) => run.result?.includes(path))
            .map((path) => (
              <DraftCard
                key={path}
                path={path}
                onOpen={onOpen}
                onEdit={onEdit}
              />
            ))}
        </>
      ) : run.status === "queued" || run.status === "running" ? (
        <Typing />
      ) : null}
      {run.status === "cancelled" ? (
        <p className={styles.quietMessage}>
          Stopped. Send another message when you’re ready.
        </p>
      ) : null}
      {run.status === "failed" || run.status === "blocked" ? (
        <div
          className={
            run.status === "blocked" ? styles.blockedReply : styles.failedReply
          }
        >
          {run.status === "blocked" ? (
            <Lock size={14} strokeWidth={1.5} />
          ) : null}
          <span>
            {run.failure?.message ??
              "I couldn’t finish that. Please try again."}
          </span>
          <DenButton
            size="xs"
            variant="ghost"
            disabled={!canRetry}
            onClick={onRetry}
          >
            Try again
          </DenButton>
        </div>
      ) : null}
    </div>
  );
}

export function WorkbotScreen() {
  const { user } = useDenFlow();
  const [state, setState] = useState<WorkbotState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("Home");
  const [message, setMessage] = useState("");
  const [pendingMessage, setPendingMessage] = useState<{
    prompt: string;
    idempotencyKey: string;
  } | null>(null);
  const sendBusy = useRef(false);
  const [busy, setBusy] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [edit, setEdit] = useState<HeadlessSchedule | null>(null);
  const [title, setTitle] = useState("Morning brief");
  const [task, setTask] = useState(
    "Draft a short plan for today and save it as daily-brief.md.",
  );
  const [interval, setIntervalMinutes] = useState("1440");
  const [firstRun, setFirstRun] = useState("");
  const [file, setFile] = useState<z.infer<typeof fileSchema> | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileOpen, setFileOpen] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLFormElement>(null);
  const chat = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const input = composer.current?.querySelector("textarea");
    if (input) {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
    }
  }, [message]);
  const followConversation = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const next = stateSchema.parse(await call("/v1/workbot"));
      setState(next);
      setConnectionError(null);
      if (!next.enabled) {
        setFile(null);
        setFileOpen(false);
        setScheduleOpen(false);
      }
    } catch (error) {
      if (
        error instanceof WorkbotRequestError &&
        [401, 403, 404].includes(error.status)
      ) {
        setState(null);
        setFile(null);
        setFileOpen(false);
        setScheduleOpen(false);
      }
      setConnectionError(
        error instanceof Error
          ? error.message
          : "I couldn’t connect. Please try again.",
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
  const latest = state?.runs.at(-1);
  useEffect(() => {
    if (followConversation.current && tab === "Home")
      end.current?.scrollIntoView({ block: "nearest" });
  }, [state?.runs.length, latest?.result, latest?.status, pendingMessage, tab]);
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
          : "That didn’t go through. Please try again.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  };
  const send = async (prompt = message, showInChat = true) => {
    if (
      !prompt.trim() ||
      busy ||
      sendBusy.current ||
      running ||
      !state?.enabled
    )
      return;
    sendBusy.current = true;
    const idempotencyKey = crypto.randomUUID();
    if (showInChat) {
      setPendingMessage({ prompt: prompt.trim(), idempotencyKey });
      setMessage("");
      setTab("Home");
      followConversation.current = true;
    }
    const sent = await mutate("/v1/headless/runs", {
      surface: "workbot",
      conversationKey: "main",
      idempotencyKey,
      prompt: prompt.trim(),
      limits: { timeoutMs: 300000 },
    });
    if (!sent && showInChat) setMessage(prompt);
    setPendingMessage(null);
    sendBusy.current = false;
  };
  const focusMessage = (text: string) => {
    setTab("Home");
    setMessage(text);
    window.requestAnimationFrame(() =>
      composer.current?.querySelector("textarea")?.focus(),
    );
  };
  const openFile = async (path: string) => {
    setFile(null);
    setFileLoading(true);
    setFileOpen(true);
    setError(null);
    try {
      setFile(
        fileSchema.parse(
          await call(`/v1/workbot/files?path=${encodeURIComponent(path)}`),
        ),
      );
    } catch (error) {
      setFileOpen(false);
      setError(
        error instanceof Error
          ? error.message
          : "This draft couldn’t be opened. Please try again.",
      );
    } finally {
      setFileLoading(false);
    }
  };
  const editFile = (path: string) => {
    setFileOpen(false);
    focusMessage(`Let’s edit ${path} together. `);
  };
  const openSchedule = (schedule: HeadlessSchedule | null) => {
    setEdit(schedule);
    setTitle(schedule?.title ?? "Morning brief");
    setTask(
      schedule?.prompt ??
        "Draft a short plan for today and save it as daily-brief.md.",
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
      setError("Choose a start time and how often to repeat.");
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
  const chatRuns = (state?.runs ?? []).filter(
    (run) => !run.prompt.startsWith("Read my connected calendar"),
  );
  const drafts = state?.files.filter((path) => path !== "memory.md") ?? [];
  const upcoming =
    state?.schedules
      .filter((schedule) => !schedule.paused)
      .slice()
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt)) ?? [];
  const initials = (user?.name ?? "You")
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <button
            className={styles.brand}
            onClick={() => setTab("Home")}
            aria-label="Workbot home"
          >
            <span className={styles.monogram}>W</span>
            <strong>Workbot</strong>
          </button>
          <nav aria-label="Assistant views">
            {(["Home", "Apps", "Calendar"] satisfies Tab[]).map((name) => (
              <DenButton
                key={name}
                variant="ghost"
                size="sm"
                aria-current={tab === name ? "page" : undefined}
                onClick={() => setTab(name)}
              >
                {name}
              </DenButton>
            ))}
          </nav>
        </div>
        <div className={styles.headerRight}>
          <DenButton
            href="/dashboard"
            variant="secondary"
            size="sm"
            icon={Link2}
          >
            Workspace
          </DenButton>
          <span
            className={styles.avatar}
            aria-label={user?.name ?? "Your account"}
          >
            {initials}
          </span>
        </div>
      </header>
      <div className={styles.body}>
        <section className={styles.conversation} aria-label="Conversation">
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
          <div
            ref={chat}
            className={styles.chat}
            onScroll={() => {
              const container = chat.current;
              if (container)
                followConversation.current =
                  container.scrollHeight -
                    container.scrollTop -
                    container.clientHeight <
                  80;
            }}
          >
            {tab === "Home" ? (
              <div className={styles.chatInner}>
                {!state && !connectionError ? (
                  <div
                    className={styles.skeleton}
                    aria-label="Loading your conversation"
                  >
                    <span />
                    <span />
                  </div>
                ) : null}
                {state && chatRuns.length === 0 && !pendingMessage ? (
                  <>
                    <div className={styles.intro}>
                      <span className={styles.largeMonogram}>W</span>
                      <h1>Workbot</h1>
                      <span>Your team assistant</span>
                    </div>
                    <div className={styles.welcome}>
                      <div className={styles.assistantBubble}>
                        Hi{user?.name ? ` ${user.name.split(" ")[0]}` : ""}!
                        What would you like to work on?
                      </div>
                      <div className={styles.assistantBubble}>
                        We can draft something, save a note, or make a plan for
                        your day.
                      </div>
                    </div>
                  </>
                ) : null}
                {chatRuns.map((run) => (
                  <article key={run.id} className={styles.turn}>
                    <time className={styles.timestamp} dateTime={run.createdAt}>
                      {run.scheduleId
                        ? `${state?.schedules.find((schedule) => schedule.id === run.scheduleId)?.title ?? "Scheduled draft"} · `
                        : ""}
                      {chatTime(run.createdAt)}
                    </time>
                    {!run.scheduleId ? (
                      <div className={styles.memberRow}>
                        <div className={styles.memberMessage}>{run.prompt}</div>
                      </div>
                    ) : null}
                    <WorkbotReply
                      run={run}
                      files={state?.files ?? []}
                      canRetry={Boolean(state?.enabled) && !busy && !running}
                      onOpen={(path) => void openFile(path)}
                      onEdit={editFile}
                      onRetry={() => void send(run.prompt)}
                    />
                  </article>
                ))}
                {pendingMessage &&
                !chatRuns.some(
                  (run) => run.idempotencyKey === pendingMessage.idempotencyKey,
                ) ? (
                  <article className={styles.turn}>
                    <div className={styles.memberRow}>
                      <div className={styles.memberMessage}>
                        {pendingMessage.prompt}
                      </div>
                    </div>
                    <div className={styles.assistantMessage}>
                      <Typing />
                    </div>
                  </article>
                ) : null}
                <div ref={end} />
              </div>
            ) : tab === "Apps" ? (
              <div className={styles.view}>
                <h1>Your apps</h1>
                <div className={styles.row}>
                  <span className={styles.rowTitle}>
                    <LayoutGrid size={16} strokeWidth={1.5} />
                    Team apps and skills
                  </span>
                  <DenButton
                    href={getMcpConnectionsRoute()}
                    size="xs"
                    variant="ghost"
                  >
                    Manage
                  </DenButton>
                </div>
                <div className={styles.row}>
                  <span>What can Workbot help with?</span>
                  <DenButton
                    size="xs"
                    variant="ghost"
                    disabled={!state?.enabled || busy || Boolean(running)}
                    onClick={() =>
                      void send(
                        "What can you help me with using my connected apps?",
                      )
                    }
                  >
                    Ask Workbot
                  </DenButton>
                </div>
                <h2>Saved files</h2>
                {state?.files.length ? (
                  state.files.map((path) => (
                    <div className={styles.row} key={path}>
                      <span className={styles.rowTitle}>
                        <FileText size={16} strokeWidth={1.5} />
                        {fileTitle(path)}
                      </span>
                      <DenButton
                        size="xs"
                        variant="ghost"
                        onClick={() => void openFile(path)}
                      >
                        Open
                      </DenButton>
                    </div>
                  ))
                ) : (
                  <p>Your notes and drafts will appear here.</p>
                )}
              </div>
            ) : (
              <div className={styles.view}>
                <div className={styles.row}>
                  <h1>Your week</h1>
                  <DenButton
                    size="sm"
                    variant="secondary"
                    disabled={!state?.enabled || busy || Boolean(running)}
                    onClick={() => void send(calendarPrompt, false)}
                  >
                    Refresh calendar
                  </DenButton>
                </div>
                {calendarAttempt?.status === "queued" ||
                calendarAttempt?.status === "running" ? (
                  <p role="status">Checking your calendar…</p>
                ) : calendarAttempt?.failure ? (
                  <div role="alert" className={styles.failedReply}>
                    {calendarAttempt.failure.message}
                  </div>
                ) : null}
                {!calendar || calendar.blockedReason ? (
                  <div className={styles.calendarEmpty}>
                    <CalendarDays size={24} strokeWidth={1.5} />
                    <h2>Bring your week into view</h2>
                    <p>
                      {calendar?.blockedReason ??
                        "Connect your calendar so Workbot can see your meetings."}
                    </p>
                    <DenButton
                      href={getMcpConnectionsRoute()}
                      size="sm"
                      variant="secondary"
                    >
                      Connect calendar
                    </DenButton>
                  </div>
                ) : calendar.events.length === 0 ? (
                  <p>No meetings this week.</p>
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
                <div className={styles.sectionHeading}>
                  <h2>Scheduled work</h2>
                  <DenButton
                    size="xs"
                    variant="ghost"
                    disabled={!state?.enabled || busy}
                    onClick={() => openSchedule(null)}
                  >
                    Add
                  </DenButton>
                </div>
                {state?.schedules.length ? (
                  state.schedules.map((schedule) => (
                    <button
                      key={schedule.id}
                      className={styles.scheduleRow}
                      onClick={() => openSchedule(schedule)}
                    >
                      <span>
                        <strong>{schedule.title}</strong>
                        <small>{repeatLabel(schedule.intervalMinutes)}</small>
                      </span>
                      <span>
                        {schedule.paused ? "Paused" : time(schedule.nextRunAt)}
                      </span>
                      <ChevronRight size={14} />
                    </button>
                  ))
                ) : (
                  <p>Ask Workbot to help with a recurring draft.</p>
                )}
              </div>
            )}
          </div>
          <form
            ref={composer}
            className={styles.composer}
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <Popover.Root>
              <Popover.Trigger
                className={styles.addButton}
                aria-label="Add to conversation"
                disabled={!state?.enabled}
              >
                <Plus size={16} strokeWidth={1.5} />
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Positioner side="top" align="start" sideOffset={8}>
                  <Popover.Popup className={styles.composerMenu}>
                    <DenButton
                      variant="ghost"
                      size="sm"
                      icon={CalendarDays}
                      onClick={() => openSchedule(null)}
                    >
                      Schedule work
                    </DenButton>
                    <DenButton
                      variant="ghost"
                      size="sm"
                      icon={FileText}
                      onClick={() => setTab("Apps")}
                    >
                      Saved files
                    </DenButton>
                    <DenButton
                      href={getMcpConnectionsRoute()}
                      variant="ghost"
                      size="sm"
                      icon={LayoutGrid}
                    >
                      Connect an app
                    </DenButton>
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>
            <DenTextarea
              aria-label="Message Workbot"
              placeholder="Message Workbot"
              rows={1}
              maxLength={20000}
              value={message}
              disabled={!state?.enabled}
              onChange={(event) => {
                setMessage(event.target.value);
                event.target.style.height = "auto";
                event.target.style.height = `${Math.min(event.target.scrollHeight, 144)}px`;
              }}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  if (!running) void send();
                }
              }}
            />
            {running ? (
              <DenButton
                type="button"
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
          </form>
        </section>
        <aside className={styles.sidebar} aria-label="Your views">
          <div className={styles.sidebarHeading}>
            <span>Your views</span>
          </div>

          <section className={styles.viewCard}>
            <div className={styles.cardHeading}>
              <CalendarDays size={14} strokeWidth={1.5} />
              <strong>Coming up</strong>
              <span>
                {new Date().toLocaleDateString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })}
              </span>
            </div>
            {upcoming.length || calendar?.events.length ? (
              <>
                {calendar?.events.slice(0, 3).map((event, index) => (
                  <div key={index} className={styles.agendaRow}>
                    <time>
                      {new Date(event.startsAt).toLocaleTimeString(undefined, {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </time>
                    <span className={styles.agendaRule} />
                    <span>{event.title}</span>
                  </div>
                ))}
                {upcoming.slice(0, 3).map((schedule) => (
                  <button
                    key={schedule.id}
                    className={styles.agendaRow}
                    onClick={() => openSchedule(schedule)}
                  >
                    <time>
                      {new Date(schedule.nextRunAt).toLocaleTimeString(
                        undefined,
                        { hour: "numeric", minute: "2-digit" },
                      )}
                    </time>
                    <span className={styles.agendaRule} />
                    <span>{schedule.title}</span>
                    <small>Workbot</small>
                  </button>
                ))}
              </>
            ) : (
              <p className={styles.cardEmpty}>
                Your meetings and recurring work will appear here.
              </p>
            )}
            <DenButton
              variant="ghost"
              size="xs"
              onClick={() => setTab("Calendar")}
            >
              View calendar
              <ChevronRight size={12} />
            </DenButton>
          </section>
          <section className={styles.viewCard}>
            <div className={styles.cardHeading}>
              <FileText size={14} strokeWidth={1.5} />
              <strong>Your drafts</strong>
              <span>{drafts.length ? `${drafts.length} saved` : ""}</span>
            </div>
            {drafts.length ? (
              drafts.slice(-5).map((path) => (
                <button
                  key={path}
                  className={styles.draftRow}
                  onClick={() => void openFile(path)}
                >
                  <span className={styles.fileBadge}>
                    <FileText size={14} strokeWidth={1.5} />
                  </span>
                  <span>{fileTitle(path)}</span>
                  <ChevronRight size={14} />
                </button>
              ))
            ) : (
              <p className={styles.cardEmpty}>
                Draft something in chat. You can open it or keep editing
                together.
              </p>
            )}
          </section>
          <section className={styles.viewCard}>
            <div className={styles.cardHeading}>
              <Clock3 size={14} strokeWidth={1.5} />
              <strong>Scheduled work</strong>
              <DenButton
                size="xs"
                variant="ghost"
                disabled={!state?.enabled || busy}
                onClick={() => openSchedule(null)}
              >
                Add
              </DenButton>
            </div>
            {state?.schedules.length ? (
              state.schedules.map((schedule) => (
                <div key={schedule.id} className={styles.job}>
                  <details>
                    <summary>
                      <span>
                        <strong>{schedule.title}</strong>
                        <small>
                          {schedule.paused
                            ? "Paused"
                            : repeatLabel(schedule.intervalMinutes)}
                        </small>
                      </span>
                      <ChevronRight size={14} />
                    </summary>
                    <p>{schedule.prompt}</p>
                    <dl>
                      <dt>Sources</dt>
                      <dd>Your files and connected apps</dd>
                      <dt>Destination</dt>
                      <dd>A draft in this chat. You post it.</dd>
                      <dt>Repeat</dt>
                      <dd>{repeatLabel(schedule.intervalMinutes)}</dd>
                    </dl>
                    <div className={styles.jobActions}>
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
                      <DenButton
                        size="xs"
                        variant="secondary"
                        disabled={busy || !state?.enabled || Boolean(running)}
                        onClick={() => {
                          setTab("Home");
                          followConversation.current = true;
                          void mutate(
                            `/v1/workbot/schedules/${schedule.id}/run`,
                            { idempotencyKey: crypto.randomUUID() },
                          );
                        }}
                      >
                        Run now
                      </DenButton>
                    </div>
                    <div className={styles.history}>
                      {state.runs
                        .filter((run) => run.scheduleId === schedule.id)
                        .slice(-5)
                        .reverse()
                        .map((run) => (
                          <div key={run.id}>
                            <time>{time(run.createdAt)}</time>
                            <span>
                              {run.status === "succeeded"
                                ? "Draft ready"
                                : run.status === "cancelled"
                                  ? "Stopped"
                                  : run.status === "failed" ||
                                      run.status === "blocked"
                                    ? "Needs attention"
                                    : "Preparing draft"}
                            </span>
                          </div>
                        ))}
                    </div>
                  </details>
                </div>
              ))
            ) : (
              <p className={styles.cardEmpty}>
                A morning brief, a weekly update, or anything you do regularly.
              </p>
            )}
          </section>
          <button
            className={styles.newView}
            disabled={!state?.enabled}
            onClick={() => focusMessage("Help me make a new view of ")}
          >
            <Plus size={14} strokeWidth={1.5} />
            Ask Workbot for a new view
          </button>
        </aside>
      </div>
      <Dialog.Root open={fileOpen} onOpenChange={setFileOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className={styles.backdrop} />
          <Dialog.Popup className={styles.fileDialog}>
            <div className={styles.dialogHeading}>
              <Dialog.Title>
                {file ? fileTitle(file.path) : "Opening draft…"}
              </Dialog.Title>
              <Dialog.Close
                className={styles.closeButton}
                aria-label="Close draft"
              >
                <X size={16} strokeWidth={1.5} />
              </Dialog.Close>
            </div>
            <Dialog.Description className={styles.dialogDescription}>
              {file?.path ?? "Your saved draft"}
            </Dialog.Description>
            <div className={styles.fileContent}>
              {fileLoading ? (
                <p>Opening your draft…</p>
              ) : file ? (
                <ChatText text={file.text} />
              ) : null}
            </div>
            <div className={styles.dialogFooter}>
              <DenButton
                size="sm"
                variant="secondary"
                disabled={!file || !state?.enabled}
                onClick={() => {
                  if (file) editFile(file.path);
                }}
              >
                Edit together
              </DenButton>
              <Dialog.Close className={styles.textButton}>Done</Dialog.Close>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={scheduleOpen} onOpenChange={setScheduleOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className={styles.backdrop} />
          <Dialog.Popup className={styles.scheduleDialog}>
            <div className={styles.dialogHeading}>
              <Dialog.Title>
                {edit ? "Edit scheduled work" : "Schedule work"}
              </Dialog.Title>
              <Dialog.Close
                className={styles.closeButton}
                aria-label="Close schedule"
              >
                <X size={16} strokeWidth={1.5} />
              </Dialog.Close>
            </div>
            <Dialog.Description className={styles.dialogDescription}>
              Workbot brings the draft back to this conversation.
            </Dialog.Description>
            <form
              className={styles.scheduleForm}
              onSubmit={(event) => {
                event.preventDefault();
                void saveSchedule();
              }}
            >
              <label>
                Name
                <DenInput
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                />
              </label>
              <label>
                What would you like Workbot to do?
                <DenTextarea
                  value={task}
                  onChange={(event) => setTask(event.target.value)}
                  required
                />
              </label>
              <div className={styles.formColumns}>
                <label>
                  First draft
                  <DenInput
                    type="datetime-local"
                    value={firstRun}
                    onChange={(event) => setFirstRun(event.target.value)}
                    required
                  />
                </label>
                <label>
                  Repeat
                  <select
                    value={interval}
                    onChange={(event) => setIntervalMinutes(event.target.value)}
                  >
                    <option value="1440">Every day</option>
                    <option value="10080">Every week</option>
                    <option value="60">Every hour</option>
                    {!["1440", "10080", "60"].includes(interval) ? (
                      <option value={interval}>
                        {repeatLabel(Number(interval))}
                      </option>
                    ) : null}
                  </select>
                </label>
              </div>
              {error ? (
                <p role="alert" className={styles.failedReply}>
                  {error}
                </p>
              ) : null}
              <div className={styles.dialogFooter}>
                <Dialog.Close className={styles.textButton}>
                  Cancel
                </Dialog.Close>
                <DenButton
                  size="sm"
                  type="submit"
                  disabled={busy || !state?.enabled}
                >
                  Save schedule
                </DenButton>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
