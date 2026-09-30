# Shared headless execution contract

The TypeScript port is `ee/packages/headless-execution/src/contract.ts`.
Workbot and Slack submit bounded tasks to the same durable worker. Den resolves
the organization and member using existing authenticated membership. Transports
must never accept actor IDs from a browser or Slack request body.

Use `HeadlessExecution.submit(actor, { surface, conversationKey, idempotencyKey,
prompt, limits? })`, then `read`, `events`, or `cancel` with the same actor.
Conversation and idempotency keys are scoped by organization, member and surface.
Duplicate idempotency keys return the original run; different inputs conflict.
Events have an increasing sequence for resumable polling.

Terminal states: succeeded, failed, cancelled and blocked. Recheck Den authority
before delivering results. Require headlessAutomation plus the surface flag at
admission, claim, during execution and before output. There is no Web entitlement
or environment bypass. Actor files persist; no desktop or Web workspace boots.

Slack owns its authenticated transport, slackAssistant flag and external-message
approval. It consumes this package rather than launching a second runtime.
Workbot owns headlessAutomation/workbot flags, Den authority, worker, actor files
and schedules. Scheduled output goes into conversation history as a draft.

## Workbot prototype

Open `/workbot` in Den after signing in. When both `headlessAutomation` and
`workbot` are enabled, the existing workspace navigation also offers Workbot.
One member conversation holds chat and scheduled drafts. Replies use conversation
bubbles and Markdown. Saved drafts offer Open and Edit together; Open reads the
actual member file, and Edit together continues the same conversation. Tool calls,
activity logs, token counts and completion timing are absent from this screen.
Apps shows persistent files and links to the existing team connections controls.
Calendar asks the agent for connected data; it renders only returned events and
shows an explicit blocked state when no approved calendar is connected.

Platform admins use the existing `/admin` organization controls to enable
`headlessAutomation` and `workbot` independently of Web subscriptions. Both are
absent/false by default. The organization creation/update APIs cannot write
these flags or the approved-action list. Ordinary organization owners cannot
change platform-admin flags. Under Technical details, platform admins may add
exact `mcp:<connection-id>:<tool-name>` names to `headlessReadCapabilities` after
verifying that the action only reads. An empty list permits discovery and skill
reads, and blocks capability execution. The proxy hides mutation tools, rejects
scripts and unapproved calls, and holds the Den execute-scoped bearer privately.
It never gives that bearer to the native model process.

The worker resolves active membership and granted ready models using Den's
existing gateway/model access records. It supports native OpenAI,
OpenAI-compatible and Anthropic provider packages. Unsupported or unconfigured
providers produce a visible blocked result. Existing session-coupled first-party
MCP grants require a current Den sign-in; this prototype does not create a new
service identity. Grant and flag changes stop active work. No Web subscription,
desktop process, browser or computer session is started.

## Run locally

Requires Node 24 or later (built-in SQLite), pnpm, the ordinary Den MySQL/Redis
setup and a verified native OpenCode v2 binary at `0.0.0-beta-19086`.
Use the existing `apps/server/src/opencode-v2-binary.ts` installer to verify its
published artifact, then point `DEN_HEADLESS_OPENCODE_BIN` at the returned path.
The adapter rejects a different native version before inference. From the repository
root, this command installs the pinned binary and prints its absolute path:

```sh
pnpm --filter @openwork-ee/den-api exec tsx --eval 'import { installOpencodeV2Binary } from "../../../apps/server/src/opencode-v2-binary.ts"; installOpencodeV2Binary("/tmp/workbot-native", "0.0.0-beta-19086").then(console.log)'
```

Point `DEN_HEADLESS_OPENCODE_BIN` at that path; use a private durable cache path
on the deployed host instead of `/tmp`.

1. Install with `pnpm install --frozen-lockfile` and build Den dependencies with
   `pnpm --filter @openwork-ee/den-api build:workspace-dependencies`.
2. Start the existing Den API and Den web dev services. Use a dedicated local
   database and ports to avoid changing another development environment.
3. Supply the same Den database, encryption, auth and MCP resource environment
   to the separate worker. Give API and worker the same private persistent
   `DEN_HEADLESS_DATA_DIR` (default `.headless-data` under each process cwd).
4. Run `pnpm --filter @openwork-ee/den-api dev:headless`. Enable the two flags
   through platform-admin controls, connect a model and grant it to the member.
5. For production, the existing `pnpm --filter @openwork-ee/den-api build`
   includes the shared compiled runtime. Start the worker with
   `node ee/apps/den-api/dist/headless/worker.js` from the repository root, using
   the same environment as the API.
6. Sign in and open `/workbot`. Ask it to save a preference to `memory.md`,
   read that file, and draft a note. Schedule work, edit it, pause/resume it,
   run it now, and open or edit the returned draft in chat.

Use an absolute storage path when launching API and worker from different
folders. Keep it private and mount it durably; it contains member prompts,
results, memory and files. The repository ignores the default folder.

The worker starts native `serve` and a native run client only during a claimed
job. It registers both MCPs, confirms connected status, then runs the prompt.
On exit/cancellation it kills the private process groups and removes transient
config, native state and credentials. Persistent actor files and conversation
history survive. A crashed worker's uncertain run is failed after lease expiry
and is never replayed automatically. Review files before a manual retry.

## Deploy cheaply

This prototype needs a small Node process, private durable disk and short-lived
native engine processes. Put the worker next to its SQLite volume; API processes
must access that same local volume. This is a single-host prototype, not a
multi-host queue implementation. Multiple local worker processes use SQLite
leases and serialize runs per member, including across surfaces.

A small Ubuntu VM (2 CPUs, 4 GB RAM, approximately 16 GB disk) is a practical
starting host. It runs Node and the native binary without installing the desktop
or OpenWork Web. Inference remains at the organization-granted provider. For a
Freestyle dev VM, persist the disk, set a TTL, and pause it after work completes
or a lease expires; do not assume disk reads wake a paused VM. Keep the Den
control plane and a durable schedule wake-up outside a paused worker. A paused
process cannot poll schedules. Use a supervisor/container that terminates the
run process group if the Node worker dies.

Freestyle and Daytona account credentials were unavailable during prototype
acceptance, so hosted creation, pause/resume and disk retention remain
unverified. Connect a development account before the tiny host lifecycle smoke.
The runtime's `HeadlessEngine` and authority ports keep hosting replaceable.

## Validation and limits

`pnpm --filter @openwork-ee/headless-execution test` checks actual SQLite
persistence/restart, actor separation, duplicate/conflicting delivery,
schedules/edit/pause/resume, cancellation, access revocation, lease fencing,
uncertain recovery and traversal/symlink rejection.
`pnpm --filter @openwork-ee/den-api test:headless` checks default-off surface
flags and independence from Web entitlement. Public-create capability tests
also reject reserved headless metadata.

`HEADLESS_TEST_MODEL_WITNESS=1 DEN_HEADLESS_OPENCODE_BIN=<verified-path>
pnpm --filter @openwork-ee/headless-execution test:engine` exercises the actual
native engine, bounded filesystem MCP and read proxy. Its deterministic HTTP
model and external MCP are explicitly synthetic fixtures. It asserts a real
file on disk and an actual upstream MCP call rather than trusting generated
text. Use `HEADLESS_TEST_LOCAL_MODEL=1 HEADLESS_TEST_MODEL=<model>
OPENAI_BASE_URL=<local-openai-compatible-url>` for a genuine local model, or the
normal `OPENAI_API_KEY` credential flow for genuine remote inference.
`HEADLESS_TEST_TIMEOUT_MS` and `HEADLESS_TEST_PROMPT` allow a bounded focused
acceptance prompt; the genuine local qwen3:4b run used 300 seconds and finished
in 172.6 seconds. Workbot chat explicitly requests the supported 300-second bound; other
requests and scheduled runs retain the 120-second default. The default turn
limit is unchanged.

External sends, browser takeover, arbitrary shell and native filesystem access
are denied. Native Code Mode stays confined and nested tools still enforce
these rules. File tools accept relative, non-hidden regular text files up to
100 KB. Calendar JSON may fail parsing for an unsuitable model; the screen
retains its unverified state rather than inventing meetings. Production readiness
still requires a hosted lifecycle run, process-death supervision, backups,
retention policy and a durable multi-host queue if deployment grows beyond one
host.

## Conversation design correction

The chat layout follows the supplied Paper v3 Home and Messages artboards: a
60-pixel quiet navigation bar, a 620-pixel conversation column, a dark member
bubble, a soft assistant bubble, a pill composer, and a 420-pixel supporting views
panel at the reference desktop width. The web page does not imitate OS chrome.
The right panel uses actual member drafts, schedules and returned calendar data.
It does not turn failed runs into team inbox items or invent connected app data.

`pnpm --filter @openwork-ee/den-web test:workbot` verifies conversational replies,
typing, recovery, Markdown safety, and usable saved-draft actions. A labeled
local model fixture also passed native chat → file write/read → follow-up edit
and cancellation with late-result suppression. These are protocol and interaction
checks, not genuine inference or a screenshot comparison. The production web
build and web type check passed after the revision.

The updated visual comparison and screenshots are pending: the existing browser
tab was on an internal connection-error page and its URL policy blocked further
automation. Existing evidence screenshots above predate this design correction.
The local preview is running at http://127.0.0.1:18995/workbot. It still uses the
existing labeled sample-response fixture; no model access grant was changed.
