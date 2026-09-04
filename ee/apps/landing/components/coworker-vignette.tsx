"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, MessageCircle, ListTodo, Plug, RotateCcw, ArrowUp, ArrowRight, ChevronLeft, Check, Pause, Play } from "lucide-react";
import { CoworkerAvatar, CoworkerMark } from "./coworker-brand";
import { CoworkerAction } from "./coworker-announcement-actions";
import { DEMO_VIEWS, EXAMPLES, TEAM, type CoworkerId, type DemoView } from "../lib/coworker-demo";
import { capturePosthogEvent } from "../lib/posthog-client";

const VIEW_ICONS = { chat: MessageCircle, documents: FileText, assignments: ListTodo, connections: Plug };
type Model = "free" | "models";
type Progress = { replied: boolean; assigned: boolean; resultOpen: boolean; routinePaused: boolean; model: Model };
type DemoAction = "coworker_selected" | "view_opened" | "message_sent" | "document_opened" | "assignment_created" | "assignment_result_opened" | "schedule_toggled" | "connection_toggled" | "model_selected" | "reset";
function freshProgress(): Record<CoworkerId, Progress> {
  const empty: Progress = { replied: false, assigned: false, resultOpen: false, routinePaused: false, model: "free" };
  return { scout: { ...empty }, editor: { ...empty }, ops: { ...empty } };
}

/** An interactive sample workspace. All state is local to this component;
 * it never calls inference, auth, connection, document, or scheduling APIs. */
export function CoworkerVignette() {
  const [selected, setSelected] = useState<CoworkerId>("scout");
  const [view, setView] = useState<DemoView>("chat");
  const [progress, setProgress] = useState(freshProgress);
  const [documentOpen, setDocumentOpen] = useState(false);
  const [connections, setConnections] = useState({ drive: false, slack: false });
  const [completed, setCompleted] = useState<Set<DemoView>>(() => new Set());
  const [status, setStatus] = useState("");
  const started = useRef(false);
  const completionSent = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const member = TEAM.find((person) => person.id === selected)!;
  const example = EXAMPLES[selected];
  const state = progress[selected];

  useEffect(() => {
    if (started.current) titleRef.current?.focus();
  }, [selected, view, documentOpen]);
  useEffect(() => {
    if (view === "chat" && state.replied && contentRef.current) {
      contentRef.current.scrollTo({ top: contentRef.current.scrollHeight, behavior: "auto" });
    }
  }, [selected, view, state.replied]);

  function track(action: DemoAction, detail?: string) {
    if (!started.current) {
      started.current = true;
      capturePosthogEvent("coworker_demo_started", { campaign: "coworker", version: 1 });
    }
    // Only fixed example identifiers reach analytics; no visitor input or account data.
    capturePosthogEvent("coworker_demo_interacted", { campaign: "coworker", action, coworker: selected, view, detail });
  }
  function markComplete(part: DemoView) {
    const next = new Set(completed).add(part);
    setCompleted(next);
    if (next.size === DEMO_VIEWS.length && !completionSent.current) {
      completionSent.current = true;
      capturePosthogEvent("coworker_demo_completed", { campaign: "coworker", version: 1 });
    }
  }
  function update(change: Partial<Progress>) {
    setProgress((current) => ({ ...current, [selected]: { ...current[selected], ...change } }));
  }
  function openView(next: DemoView) {
    track("view_opened", next);
    setView(next);
    setDocumentOpen(false);
  }
  function chooseCoworker(id: CoworkerId) {
    track("coworker_selected", id);
    setSelected(id);
    setView("chat");
    setDocumentOpen(false);
  }
  function reply() {
    if (state.replied) return;
    track("message_sent");
    update({ replied: true });
    markComplete("chat");
    setStatus(member.name + " replied to the example message.");
  }
  function openDocument() {
    track("document_opened");
    setView("documents");
    setDocumentOpen(true);
    markComplete("documents");
  }
  function assign() {
    track("assignment_created");
    update({ assigned: true });
    markComplete("assignments");
    setStatus("Example assignment added for " + member.name + ".");
  }
  function toggleConnection(id: "drive" | "slack") {
    track("connection_toggled", id);
    setConnections((current) => ({ ...current, [id]: !current[id] }));
    if (!connections[id]) markComplete("connections");
    setStatus((id === "drive" ? "Google Drive" : "Slack") + (connections[id] ? " disconnected in the demo." : " connected in the demo."));
  }
  function reset() {
    track("reset");
    setProgress(freshProgress());
    setSelected("scout");
    setView("chat");
    setDocumentOpen(false);
    setConnections({ drive: false, slack: false });
    setCompleted(new Set());
    setStatus("The sample workspace has been reset.");
  }

  const panelTitle = view === "chat" ? "With " + member.name : view === "documents" && documentOpen ? example.document.title : view === "connections" ? "Connect your tools" : member.name + "’s " + view;

  return (
    <div className="cw-demo" data-testid="coworker-demo">
      <div className="cw-demo-topbar">
        <div className="flex items-center gap-2.5"><CoworkerMark size={23} /><span className="text-xs font-medium">Open Coworker</span></div>
        <div className="flex items-center gap-3"><span className="cw-demo-badge">Interactive demo</span><button type="button" className="cw-demo-icon-button" aria-label="Reset demo" onClick={reset}><RotateCcw size={15} aria-hidden="true" /></button></div>
      </div>
      <div className="cw-demo-layout">
        <aside className="cw-demo-sidebar" aria-label="Demo workspace">
          <p className="cw-eyebrow cw-demo-sidebar-label">Your coworkers</p>
          <div className="cw-demo-team" role="group" aria-label="Choose a demo coworker">
            {TEAM.map((person) => <button type="button" key={person.id} aria-label={"Talk to " + person.name} aria-pressed={selected === person.id} className="cw-demo-person" onClick={() => chooseCoworker(person.id)}>
              <CoworkerAvatar {...person} size={30} /><span><span className="block text-sm font-medium">{person.name}</span><span className="cw-demo-role">{person.role}</span></span>
            </button>)}
          </div>
          <nav className="cw-demo-nav" aria-label="Explore the demo">
            {DEMO_VIEWS.map((item) => {
              const Icon = VIEW_ICONS[item.id];
              return <button type="button" key={item.id} aria-pressed={view === item.id} aria-controls="coworker-demo-panel" className="cw-demo-nav-item" onClick={() => openView(item.id)} data-testid={"demo-view-" + item.id}><Icon size={16} aria-hidden="true" /><span>{item.label}</span></button>;
            })}
          </nav>
          <p className="cw-demo-sidebar-note">A little company for the work ahead.</p>
        </aside>
        <section className="cw-demo-workspace" id="coworker-demo-panel" aria-labelledby="coworker-demo-title">
          <header className="cw-demo-panel-header">
            <h3 id="coworker-demo-title" ref={titleRef} tabIndex={-1}>{panelTitle}</h3>
            <span className="text-[11px] text-[var(--cw-muted)]">Sample workspace</span>
          </header>
          <div className="cw-demo-content" ref={contentRef} tabIndex={0} role="region" aria-label={member.name + " " + view + " example"} key={selected + view + documentOpen}>
            {view === "chat" && <div className="cw-demo-conversation">
              <div className="flex justify-end"><p className="cw-chat-request">{example.question}</p></div>
              <div className="cw-demo-reply"><CoworkerAvatar {...member} size={27} /><div className="min-w-0"><p className="cw-demo-speaker">{member.name}</p><p>{example.answer}</p>
                <button type="button" className="cw-chat-document" onClick={openDocument} aria-label={"Open " + example.document.title}><FileText size={20} aria-hidden="true" /><span className="flex-1"><span className="block text-sm font-medium text-[var(--cw-text)]">{example.document.title}</span><span className="mt-0.5 block text-xs text-[var(--cw-muted)]">Draft · Ready to review</span></span><ArrowRight size={15} aria-hidden="true" /></button>
              </div></div>
              {state.replied && <div data-testid="demo-follow-up"><div className="mb-6 flex justify-end"><p className="cw-chat-request">{example.followUp}</p></div><div className="cw-demo-reply"><CoworkerAvatar {...member} size={27} /><div><p className="cw-demo-speaker">{member.name}</p><p>{example.reply}</p></div></div></div>}
            </div>}
            {view === "documents" && (documentOpen ? <article className="cw-demo-document" data-testid="demo-document-preview">
              <button type="button" className="cw-demo-text-button mb-7" onClick={() => setDocumentOpen(false)}><ChevronLeft size={14} aria-hidden="true" />All documents</button>
              <p className="cw-eyebrow">{example.document.eyebrow}</p><h4>{example.document.title}</h4><p>{example.document.intro}</p>
              {selected === "editor" && state.replied && <div className="cw-demo-note"><strong>Alternative opening</strong><p>Good work starts with a little company. Meet your new coworkers.</p></div>}
              <h5>What matters</h5><ul>{example.document.points.map((point) => <li key={point}>{point}</li>)}</ul><h5>Next step</h5><p>{example.document.next}</p>
            </article> : <div className="cw-demo-panel-body"><p className="cw-demo-description">The work you can open, review, and build on.</p><button type="button" className="cw-demo-list-row" onClick={openDocument} aria-label={"Read " + example.document.title}><FileText size={23} aria-hidden="true" /><span className="flex-1"><strong>{example.document.title}</strong><small>{member.name} · Ready to review</small></span><ArrowRight size={16} aria-hidden="true" /></button></div>)}
            {view === "assignments" && <div className="cw-demo-panel-body">
              <p className="cw-demo-description">Give {member.name} an outcome to work toward.</p>
              <p className="cw-eyebrow mb-3">Once</p>
              <div className="cw-demo-task" data-testid="demo-assignment">
                <h4>{example.assignment.title}</h4><p>{example.assignment.description}</p>
                {!state.assigned ? <button type="button" className="cw-demo-small-button mt-4" onClick={assign}>{"Assign to " + member.name}<ArrowRight size={14} aria-hidden="true" /></button> : <>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><span className="cw-demo-status"><span aria-hidden="true">●</span>{state.resultOpen ? "Ready to review" : "Working on it · Demo"}</span>{!state.resultOpen && <button type="button" className="cw-demo-text-button" onClick={() => { track("assignment_result_opened"); update({ resultOpen: true }); }}>See sample result<ArrowRight size={14} aria-hidden="true" /></button>}</div>
                  {state.resultOpen && <div className="cw-demo-note" role="status">{example.assignment.result}</div>}
                </>}
              </div>
              <p className="cw-eyebrow mb-3 mt-8">On a schedule</p>
              <div className="cw-demo-list-row"><span className="flex-1"><strong>{example.routine}</strong><small>{state.routinePaused ? "Paused in demo" : (selected === "ops" ? "Fridays" : "Mondays") + " at 9:00 AM · Active"}</small></span><button type="button" className="cw-demo-icon-button" aria-label={state.routinePaused ? "Resume sample schedule" : "Pause sample schedule"} onClick={() => { track("schedule_toggled"); update({ routinePaused: !state.routinePaused }); setStatus(state.routinePaused ? "Sample schedule resumed." : "Sample schedule paused."); }}>{state.routinePaused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}</button></div>
              <p className="mt-4 text-xs leading-5 text-[var(--cw-muted)]">In the app, local schedules run while Coworker is open. Nothing is scheduled by this demo.</p>
            </div>}
            {view === "connections" && <div className="cw-demo-panel-body">
              <p className="cw-eyebrow mb-4">OpenWork Connect</p><h4 className="text-2xl font-medium tracking-tight">Bring your work into the conversation.</h4><p className="cw-demo-description mt-3">Let your coworkers use the tools you already work with. Try a sample connection below.</p>
              <div className="space-y-3">
                <div className="cw-demo-list-row"><span className="cw-demo-provider" aria-hidden="true">D</span><span className="flex-1"><strong>Google Drive</strong><small>{connections.drive ? "Connected in demo · 3 sample documents" : "Docs and working files"}</small></span><button type="button" className="cw-demo-small-button" onClick={() => toggleConnection("drive")} aria-label={connections.drive ? "Disconnect Google Drive demo" : "Connect Google Drive demo"}>{connections.drive ? <><Check size={14} aria-hidden="true" />Connected</> : "Connect"}</button></div>
                <div className="cw-demo-list-row"><span className="cw-demo-provider" aria-hidden="true">S</span><span className="flex-1"><strong>Slack</strong><small>{connections.slack ? "Connected in demo · #launch-team" : "Team updates and conversations"}</small></span><button type="button" className="cw-demo-small-button" onClick={() => toggleConnection("slack")} aria-label={connections.slack ? "Disconnect Slack demo" : "Connect Slack demo"}>{connections.slack ? <><Check size={14} aria-hidden="true" />Connected</> : "Connect"}</button></div>
              </div>
              {(connections.drive || connections.slack) && <div className="cw-demo-note"><strong>Ready for your next conversation</strong><p>{connections.drive ? "The sample launch brief, checklist, and announcement are available to your demo coworkers. " : ""}{connections.slack ? "The sample launch-team updates are available too." : ""}</p></div>}
              <p className="mt-5 text-xs leading-5 text-[var(--cw-muted)]">These are example connections. Your accounts and files stay untouched.</p>
            </div>}
          </div>
          {view === "chat" && <div className="cw-demo-composer-area">
            {state.model === "models" && <div className="cw-demo-model-note">Explore models through an OpenWork membership.<CoworkerAction href="#models" action="models" placement="demo" className="underline underline-offset-4">See membership<ArrowRight size={12} aria-hidden="true" /></CoworkerAction></div>}
            <form className="cw-demo-composer" onSubmit={(event) => { event.preventDefault(); reply(); }}>
              <label className="sr-only" htmlFor="coworker-example-message">Example message</label><input id="coworker-example-message" readOnly value={state.replied ? "Open the draft or try another coworker" : example.followUp} aria-describedby="coworker-demo-disclosure" />
              <div className="flex items-center justify-between gap-3"><label className="cw-demo-model-label">Model<select aria-label="Demo model source" data-testid="demo-model-source" value={state.model} onChange={(event) => { const model = event.currentTarget.value; if (model === "free" || model === "models") { track("model_selected", model); update({ model }); setStatus("Model source changed in the sample workspace."); } }}><option value="free">Free model</option><option value="models">OpenWork Models</option></select></label><button type="submit" className="cw-demo-send" aria-label="Send example message" disabled={state.replied}><ArrowUp size={17} aria-hidden="true" /></button></div>
            </form>
          </div>}
        </section>
      </div>
      <div className="cw-demo-guide">
        <div><p className="font-medium">{completed.size === 4 ? "Make a little room on your team." : view === "chat" ? state.replied ? "There’s something to build on." : "Try the conversation." : view === "documents" ? "A draft you can make your own." : view === "assignments" ? "Give your coworker the next step." : "A place for your tools, too."}</p><p className="mt-1 text-xs text-[var(--cw-muted)]">{completed.size === 4 ? "You’ve explored a sample workday. Meet your own coworkers next." : "Explore at your own pace · " + completed.size + " of 4 moments tried"}</p></div>
        {completed.size === 4 ? <CoworkerAction href="#get-started" action="early_access" placement="demo" className="cw-demo-small-button">Get early access<ArrowRight size={14} aria-hidden="true" /></CoworkerAction> : view === "chat" ? <button type="button" className="cw-demo-small-button" onClick={state.replied ? openDocument : reply}>{state.replied ? "Open the draft" : "Try a reply"}<ArrowRight size={14} aria-hidden="true" /></button> : view === "documents" ? <button type="button" className="cw-demo-small-button" onClick={documentOpen ? () => openView("assignments") : openDocument}>{documentOpen ? "Explore assignments" : "Open the draft"}<ArrowRight size={14} aria-hidden="true" /></button> : view === "assignments" ? <button type="button" className="cw-demo-small-button" onClick={state.assigned ? () => openView("connections") : assign}>{state.assigned ? "Explore connections" : "Try an assignment"}<ArrowRight size={14} aria-hidden="true" /></button> : <button type="button" className="cw-demo-small-button" onClick={() => connections.drive || connections.slack ? openView("chat") : toggleConnection("drive")}>{connections.drive || connections.slack ? "Back to the conversation" : "Try a connection"}<ArrowRight size={14} aria-hidden="true" /></button>}
      </div>
      <p className="sr-only" role="status">{status}</p>
    </div>
  );
}
