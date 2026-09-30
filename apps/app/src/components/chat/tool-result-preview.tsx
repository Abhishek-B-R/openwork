import type { DynamicToolUIPart } from "ai";
import { MessageContent } from "@/components/ui/message";
import { ImageAttachmentBadge } from "./image-attachment-badge";
import { FileChip } from "./file-chip";
import { useOpenTargets } from "@/lib/target-provider";
import { openTargetFromUrl } from "@/react-app/domains/session/artifacts/open-target";
import { gatewayMcpAppLaunch, isNativeConnectionAppLaunch } from "./mcp-app-frame";

/** Exact returned content, bounded for the rail; Apps keep their existing host. */
export function ToolResultPreview({ part }: { part: DynamicToolUIPart }) {
  const { onOpenTarget } = useOpenTargets();
  const mcp = part.callProviderMetadata?.openwork?.mcpResult;
  const meta = mcp && typeof mcp === "object" && "_meta" in mcp ? mcp._meta : null;
  // Preserved MCP transport is also used by ordinary tools. Only an actual
  // App launch owns its visual result; ordinary content belongs on this step.
  if (part.state !== "output-available" || gatewayMcpAppLaunch(meta) || isNativeConnectionAppLaunch(part)
    || meta && typeof meta === "object" && "openwork/appDraft" in meta) return null;
  const result = part.callProviderMetadata?.openwork?.mcpResult ?? part.output;
  const content = result && typeof result === "object" && "content" in result && Array.isArray(result.content) ? result.content : [];
  const resources = content.slice(0, 8).flatMap((entry: unknown, index) => {
    if (!entry || typeof entry !== "object" || !("type" in entry)) return [];
    if (entry.type === "image" && "data" in entry && typeof entry.data === "string"
      && "mimeType" in entry && typeof entry.mimeType === "string" && /^image\/(png|jpeg|gif|webp)$/.test(entry.mimeType)) {
      return [<ImageAttachmentBadge key={index} src={`data:${entry.mimeType};base64,${entry.data}`} alt="Returned image" />];
    }
    const resource = entry.type === "resource" && "resource" in entry ? entry.resource : entry;
    if (!resource || typeof resource !== "object" || !("uri" in resource) || typeof resource.uri !== "string") return [];
    const target = openTargetFromUrl(resource.uri);
    if (target) {
      const name = "name" in resource && typeof resource.name === "string" ? resource.name : target.name;
      return [<a key={index} href={target.value} className="underline" onClick={event => {
        if (onOpenTarget) { event.preventDefault(); onOpenTarget({ ...target, name }); }
      }}>{name}</a>];
    }
    if (resource.uri.startsWith("file://")) {
      try { return [<FileChip key={index} path={decodeURIComponent(new URL(resource.uri).pathname)} />]; } catch { return []; }
    }
    return [];
  });
  let text = typeof result === "string" ? result : "";
  if (result && typeof result === "object" && "content" in result && Array.isArray(result.content)) {
    text = result.content.flatMap((entry: unknown) => entry && typeof entry === "object" && "type" in entry
      && entry.type === "text" && "text" in entry && typeof entry.text === "string" ? [entry.text] : []).join("\n\n");
  }
  // Catalog transport contains capability IDs and schemas. Show its recorded
  // descriptions here; the complete search result stays in Technical details.
  if (part.toolName.endsWith("search_capabilities") && text.trim()) {
    try {
      const catalog: unknown = JSON.parse(text);
      if (catalog && typeof catalog === "object" && "matches" in catalog && Array.isArray(catalog.matches)) {
        text = catalog.matches.slice(0, 5).flatMap((match: unknown) => match && typeof match === "object"
          && "summary" in match && typeof match.summary === "string" ? [match.summary] : []).join("\n\n");
      }
    } catch { /* An ordinary text result keeps its recorded preview. */ }
  }
  if (!text.trim() && !resources.length && result && typeof result === "object") {
    const structured = "structuredContent" in result ? result.structuredContent : result;
    const rows = Array.isArray(structured) ? structured.slice(0, 5) : structured && typeof structured === "object" && "rows" in structured && Array.isArray(structured.rows) ? structured.rows.slice(0, 5) : [structured];
    const entries = rows.flatMap(row => row && typeof row === "object" ? Object.entries(row).filter(([, value]) =>
      typeof value === "string" || typeof value === "number" || typeof value === "boolean").slice(0, 6) : []);
    if (entries.length) return <dl data-tool-result-preview className="ms-7 mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {entries.map(([key, value], index) => <div key={`${key}:${index}`} className="contents"><dt>{key}</dt><dd className="min-w-0 wrap-break-word">{String(value).slice(0, 500)}</dd></div>)}
    </dl>;
  }
  if (!text.trim() && !resources.length) return null;
  const bounded = text.length > 2_500 ? `${text.slice(0, 2_500)}\n\n… More in Technical details` : text;
  return <div className="ms-7 mt-1 text-xs text-muted-foreground" data-tool-result-preview>
    {bounded.trim() ? <MessageContent markdown onClick={event => {
      if (!(event.target instanceof Element) || !onOpenTarget) return;
      const target = openTargetFromUrl(event.target.closest("a[href]")?.getAttribute("href") ?? "");
      if (target) { event.preventDefault(); onOpenTarget(target); }
    }}>{bounded}</MessageContent> : null}
    {resources.length ? <div className="mt-1 flex flex-wrap gap-2">{resources}</div> : null}
  </div>;
}
