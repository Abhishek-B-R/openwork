import { useEffect, useState } from "react";
import { coworkerBridge } from "@/lib/bridge";
import type { CoworkerDocument, CoworkerDocumentSummary, DocumentRevision } from "@/lib/documents";
import { Button, ErrorNote, inputClass } from "@/ui/kit";
import { DocumentMarkdown } from "@/ui/markdown";

/** Shared documents use the existing Markdown renderer and revision store; drafts stay put on conflict. */
export function GroupDocuments({ groupId, openId, onClose }: { groupId: string; openId: string; onClose: () => void }) {
  const [items, setItems] = useState<CoworkerDocumentSummary[]>([]);
  const [document, setDocument] = useState<CoworkerDocument | null>(null);
  const [history, setHistory] = useState<DocumentRevision[] | null>(null);
  const [preview, setPreview] = useState<DocumentRevision | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load(id: string) {
    setError(""); setHistory(null); setPreview(null);
    try { setDocument(await coworkerBridge.groups.documents.read(groupId, id)); setEditing(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  useEffect(() => {
    let cancelled = false;
    const refresh = () => { void coworkerBridge.groups.documents.list(groupId).then((list) => { if (!cancelled) setItems(list); }).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); }); };
    refresh(); const timer = window.setInterval(refresh, 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [groupId]);
  useEffect(() => { if (openId) void load(openId); }, [groupId, openId]);
  async function save() {
    setBusy(true); setError("");
    try {
      const saved = await coworkerBridge.groups.documents.save(groupId, { ...(document ? { id: document.id, expectedRevision: document.revision } : {}), title, body });
      setDocument(saved); setEditing(false); setHistory(null);
      setItems(await coworkerBridge.groups.documents.list(groupId));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return (
    <aside className="absolute inset-y-0 right-0 z-30 flex w-[min(520px,100%)] flex-col border-l border-line bg-ink shadow-2xl" aria-label="Shared documents" data-testid="group-documents">
      <header className="flex items-center justify-between border-b border-line p-4">
        <h2 className="text-sm font-semibold text-snow">Shared documents</h2>
        <Button variant="ghost" onClick={onClose}>Close</Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!document && !editing ? <>
          <p className="mb-3 text-xs leading-relaxed text-mist">These documents belong to this group. Enabled members can read and update them. Private coworker documents stay separate.</p>
          <Button onClick={() => { setTitle(""); setBody(""); setEditing(true); }} data-testid="group-document-new">New shared document</Button>
          <ul className="mt-4 space-y-2">{items.map((item) => <li key={item.id}><button className="w-full rounded-xl bg-panel p-3 text-left" onClick={() => void load(item.id)} data-testid="group-document-item"><span className="block break-words text-sm font-medium text-snow">{item.title}</span><span className="mt-1 block text-xs text-mist">{item.author || (item.updatedBy === "person" ? "You" : "Coworker")} · revision {item.revision}</span></button></li>)}</ul>
          {items.length === 0 ? <p className="mt-4 text-xs text-mist">A plan, a brief, or decisions your team can work on together.</p> : null}
        </> : null}
        {editing ? <div className="space-y-3">
          <label className="block text-xs text-mist">Title<input className={`${inputClass} mt-1`} aria-label="Shared document title" maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="block text-xs text-mist">Document<textarea className={`${inputClass} mt-1 min-h-72 resize-y font-mono text-xs`} aria-label="Shared document body" maxLength={100000} value={body} onChange={(event) => setBody(event.target.value)} /></label>
          <div className="flex flex-wrap gap-2"><Button variant="primary" disabled={busy || !title.trim()} onClick={() => void save()}>Save shared document</Button><Button variant="ghost" disabled={busy} onClick={() => { setEditing(false); setError(""); }}>Cancel</Button></div>
          {error && document ? <Button variant="ghost" onClick={() => { void coworkerBridge.groups.documents.read(groupId, document.id).then(setPreview).catch((cause: unknown) => setError(String(cause))); }}>Compare with latest</Button> : null}
          {preview ? <div className="rounded-xl border border-line p-3"><p className="text-xs text-mist">Latest: revision {preview.revision} · {preview.author || "Coworker"}. Your draft above has been kept.</p><DocumentMarkdown text={preview.body} /><Button onClick={() => { setDocument(preview); setPreview(null); setError(""); }}>I've reconciled my draft with this revision</Button></div> : null}
        </div> : document ? <>
          <Button variant="ghost" onClick={() => { setDocument(null); setHistory(null); }}>← All documents</Button>
          <h3 className="mt-3 break-words text-xl font-semibold text-snow">{document.title}</h3>
          <p className="mt-1 text-xs text-mist" data-testid="group-document-author">{document.author || "Coworker"} · revision {document.revision}</p>
          <div className="my-3 flex gap-2"><Button onClick={() => { setTitle(document.title); setBody(document.body); setEditing(true); }}>Edit</Button><Button onClick={() => { void coworkerBridge.groups.documents.revisions(groupId, document.id).then(setHistory).catch((cause: unknown) => setError(String(cause))); }}>History</Button><Button variant="ghost" onClick={() => void load(document.id)}>Refresh</Button></div>
          <DocumentMarkdown text={document.body} onOpenDocument={(id) => void load(id)} />
          {history ? <section className="mt-5 border-t border-line pt-3"><h4 className="text-sm text-snow">Earlier revisions</h4>{history.length === 0 ? <p className="mt-2 text-xs text-mist">No earlier revisions.</p> : history.map((revision) => <details className="mt-2 rounded-xl border border-line p-3" key={revision.revision}><summary className="cursor-pointer text-xs text-mist">Revision {revision.revision} · {revision.author || "Coworker"}</summary><DocumentMarkdown text={revision.body} /><Button disabled={busy} onClick={async () => { setBusy(true); try { setDocument(await coworkerBridge.groups.documents.restore(groupId, document.id, revision.revision, document.revision)); setHistory(null); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } }}>Restore as a new revision</Button></details>)}</section> : null}
        </> : null}
        {error ? <div className="mt-3"><ErrorNote>{error}</ErrorNote></div> : null}
      </div>
    </aside>
  );
}
