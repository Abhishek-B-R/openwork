# Cloud Workbot and shared headless execution

Workbot is a member conversation in Den at `/workbot`. It uses the organization's
AI Gateway and injects OpenWork MCP for every run. The conversation, drafts,
memory and schedules live in Den's encrypted cloud database. API and worker
replicas share that database; no member desktop, local workspace or persistent
worker disk is required.

## Primitives and boundaries

- Existing Den sessions and organization membership resolve the actor on the
  server. Request bodies cannot choose organization or member identities.
- Existing organization capabilities gate `headlessAutomation` plus `workbot`,
  independently of Web subscriptions. Both flags are off by default. Slack can
  consume the same execution port behind its separate `slackAssistant` flag.
- Existing `gatewaySummary` supplies only models granted to this member. The
  native adapters are the same OpenAI, OpenAI-compatible, Anthropic and OpenRouter
  adapters used by the desktop. There is no direct-provider fallback. By default,
  the least expensive usable model in the granted catalog is selected; unknown
  prices sort last. Platform admins can pin an already-granted model with
  `headlessModel: {providerId, modelId}` in organization metadata.
- Existing member Gateway keys, routing aliases, provider credentials and usage
  limits remain authoritative. The native process receives a member Gateway key,
  never the upstream provider secret. Availability polling does not mint keys.
- Existing first-party OpenWork MCP grants remain coupled to a current Den
  session. Each run receives a five-minute token behind a private proxy. The
  proxy permits discovery and skill reads by default; capability execution
  requires an exact platform-admin `headlessReadCapabilities` entry. Sends,
  scripts and unapproved actions are denied. The native process receives only
  the private proxy credential, not the Den MCP bearer.
- Existing encrypted database columns hold run, event, schedule and file
  contents. Database row locks, scoped idempotency and database-clock leases
  provide atomic admission, claims, cancellation and completion across replicas.
- Existing desktop `Message` and send/stop controls are shared through
  `@openwork/ui/react`; the Workbot screen uses Den buttons, inputs, dialogs and
  navigation. The pinned OpenCode v2 installer also comes from the desktop.

`HeadlessExecution` is the transport port: `submit`, `read`, `events`, `cancel`
and `conversation`. `HeadlessRepository` contains atomic persistence operations;
Den implements it using MySQL. The SQLite adapter is only for explicit local
integrations and isolated runtime tests. Den production never uses it.

## Conversation and design

The Paper Messages artboard sets the desktop layout: 60-pixel header,
620-pixel conversation column, 420-pixel contextual sidebar, quiet assistant
bubbles, navy member bubbles, a rounded composer and small saved-draft cards.
Browser chrome from the mockup is not part of the web app. Narrow screens keep
the conversation and composer visible and hide the contextual sidebar.

The screen shows member messages, replies and actual saved drafts. Open loads
the saved file; Edit together continues the same conversation. It does not show
tool calls, execution logs, token counts, run durations or duplicated draft text.
Calendar renders only saved results from an approved connected read. Scheduled
work writes drafts into the same member conversation. Missing Gateway access
shows a neutral blocked state and disables submission; there are no generated
sample answers or invented calendar/project rows.

Design rules applied: P1 (real state and compact copy), P5 (reuse primitives),
P10 (screenshots), P11 (continuous conversation), S4 (Open/Edit draft cards),
C3 (no internal tool identifiers), C5 (neutral blocked state), T5 (round send/stop).
Fresh screenshots and verification details are in `docs/evidence/workbot`.

## Safety and resource bounds

Membership and surface flags are checked at admission, claim, during execution,
before tools and before output. Model grants, Gateway-key revocation, the exact
MCP session and the approved action list are rechecked during active work.
Cancellation clears the database lease; stale file writes and late completion
cannot commit. A worker that cannot renew its lease aborts its native process.
After a crash, uncertain running jobs become failed after lease expiry and are
never replayed automatically. Queued jobs survive restart. Review saved drafts
before manually retrying interrupted work.

The native agent has no shell, browser, computer or arbitrary host-file access.
Its filesystem is a scoped text-file MCP backed by encrypted cloud rows:
100 KB per file, 200 files per member and at most six relative path segments.
Traversal and symlink escapes are rejected. Run defaults are two minutes,
eight turns and at most 2,048 output tokens per turn. Requests may raise the
bounds to five minutes and 16 turns. Workbot chat uses the five-minute time
bound while keeping the default eight turns. A member can queue at most 20 messages and
save at most 20 schedules. Conversation context includes at most 12 successful
turns and 24,000 characters. Existing Gateway usage policies provide the team
budget boundary.

Native config, credentials and engine state use a private temporary directory
and are deleted after the run. Child processes receive a small environment
without Den database/auth secrets. Trusted deployment CA paths may be forwarded.
Both MCP connections and the exact native version are verified before inference.

## Required cloud infrastructure

Start with existing Den API/web, Den MySQL, existing Redis, the AI Gateway and the
OpenWork MCP endpoint, plus **one shared Linux Node worker**. The new infrastructure
is an optional worker Deployment and four additive database tables. Redis keeps
its existing Den role; the job queue does not add a separate broker.

The worker image uses Node 24 and SHA-512-verified OpenCode v2
`0.0.0-beta-19086`. It runs as a non-root user. The Helm deployment has no Service
or Ingress, no Kubernetes API token, no privilege escalation, a read-only root
filesystem and a disposable 2 GiB `/tmp`. Defaults request 250 millicores and
512 MiB, with limits of one CPU and 2 GiB. These are initial bounds, not measured
production capacity. Each worker runs one job at a time; add replicas for
concurrency across members. Database claims serialize work for one member,
including across Workbot and Slack.

Only existing database, Redis, auth and encryption secret references are supplied
to the worker. Gateway and MCP URLs follow the existing Den config. Workspace provisioning is explicitly disabled in this worker, so an inherited
Den Daytona configuration does not require a sandbox key. No Freestyle,
Daytona, provider API-key or desktop provisioning secret is required. The worker
needs private database/Redis connectivity and outbound Gateway/MCP access;
only its pod-local health port 9091 is exposed to probes.

```sh
# Build/publish this target through the existing image release pipeline.
docker build -f packaging/docker/Dockerfile.den --target headless-worker \
  -t <registry>/openwork-den-headless:<release> .

# Deploy API/schema changes through the existing migration flow first.
# Then enable the optional worker with the same release as Den.
helm upgrade --install openwork-ee packaging/helm/openwork-ee \
  -f <deployment-values.yaml> \
  --set headlessWorker.enabled=true \
  --set headlessWorker.image.repository=<registry>/openwork-den-headless \
  --set headlessWorker.image.tag=<release>
```

`headlessWorker.enabled` is false by default. The normal Docker target continues
to build the Den API. The existing EE artifact workflow builds and publishes the
worker target under `openwork-den-headless` with the same release tags, and its
smoke uses a real bootstrapped MySQL database. The worker has readiness/liveness checks and a 30-second
termination grace period. Idle polling backs off to five seconds; no native
process runs while idle. Storage remains in the database when a pod is replaced.
Platform admins enable the member capabilities and grant a usable Gateway model
through existing controls. Members sign in before using the injected MCP.

This is the smallest initial deployment because the current workload needs only
conversation, confined files and MCP. Freestyle or Daytona become useful if a
later capability needs a complete operating system, browser or arbitrary code;
that requires a separate execution adapter and isolation policy. Cloudflare
Workers exposes `node:child_process` as a non-functional stub, so this binary
needs a container runtime there: [Cloudflare Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/). A managed Node/container host can run the same worker image with the
same private service connectivity.

For a Freestyle alternative, current list rates imply roughly $0.0055 of compute
and 2 GiB disk for a five-minute job at one vCPU/2 GiB RAM, before plan minimums,
inference and transfer. Paused VMs retain storage charges. This is an estimate,
not a deployed benchmark: [Freestyle pricing](https://www.freestyle.sh/docs/vms/pricing-and-limits).
The first PR adds no per-member VM lifecycle.

## Verification

```sh
pnpm --dir ee/packages/headless-execution test
pnpm --dir ee/apps/den-api test:headless
DEN_HEADLESS_TEST_DATABASE_URL=<owned-loopback-headless_test-database-url> \
  pnpm --dir ee/apps/den-api test:headless:db
pnpm --dir ee/apps/den-web test:workbot
bash packaging/helm/openwork-ee/tests/headless-worker.sh
```

The database suite uses two independent connection pools against real MySQL to
check concurrent deduplication, claims, actor isolation, clock skew, cancellation,
expired leases, encrypted files, schedule occurrence fencing and offboarding.
The Gateway selection suite checks the lack of a legacy fallback, cost selection,
output limits, model pinning, supported native adapters and non-mutating readiness.
The UI suite verifies conversational output, safe Markdown and actual draft actions.

An opt-in smoke script can exercise a deployed, already-enabled workspace without
adding grants or fixtures. Its credential file contains a current Den session
`cookie` or `token`; keep that file private. The script writes and reads a small
scoped file and reports only verification status.

```sh
pnpm --dir ee/apps/den-api exec tsx --conditions=development \
  scripts/smoke-workbot.ts https://<den-api-host> <private-session-file.json>
```

A real existing cloud workspace and deployment are still required for final
hosted acceptance. Local Linux-image, MySQL and Gateway-wire results do not
substitute for that deployment check. Evidence states which authorization and
quota records were fixtures and which connections/inference were real.
