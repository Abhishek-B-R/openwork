# Fast decisions candidate — September 29, 2026

Local, uncommitted candidate on `feature/coworker-fast-decisions`, based on
Coworker `bf42e00f0500fb2137900ecd9b75f7b2b79bf73e` and the uncommitted
Call-mode source candidate (with its September 29 microphone-gesture/key guard
refreshed during this task). The current upstream `dev` was fetched at
`4e7aa1715888635edb5d3a280dc7f39ecbaea271`; it has no `apps/coworker`.
This candidate does not claim upstream integration or a released app.

## Verified API boundary

Jalil supplied an announcement describing Decisions API as a limited preview
for finite, predefined answers and explicitly chose Luna for now. That
announcement was supplied by the user, not independently verified in this task.
The [September 29 API changelog](https://developers.openai.com/api/docs/changelog),
official documentation searches, and the published OpenAPI endpoint index did
not establish its endpoint, SDK contract, access requirements, pricing, or any
advertised latency. Direct Decisions API support awaits a verified contract and
access.

The implementation now uses [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
through Coworker's existing connected native model provider. This follows
Jalil's later instruction to remove the separate API-key requirement for Luna,
which supersedes the original shared-key requirement for fast decisions.
No provider credentials are read or copied by the helper. Luna must already be
available in the connected native catalog; absence uses the existing facilitator.
Selection accepts exact Luna or a native catalog entry with Luna's canonical
upstream model identity, including a managed provider alias. Provider/model IDs
come from the native catalog, not an invented picker entry.

The isolated native plugin uses the provider's existing OpenAI-compatible
[Responses](https://developers.openai.com/api/reference/resources/responses/methods/create)
or Chat Completions transport and forces no reasoning, a 64-token output limit,
and [strict Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
It replaces ambient instructions and history with the bounded observation,
removes tools/provider options, refuses extra requests and retries, and
validates the finite answer again in main. No Decisions endpoint is called.
Luna documents text and image input; this integration sends text only.

Usage and access follow the chosen native model connection. The helper adds no
separate key, credential store, billing scope, paid tier or model fallback.
Diagnostics display native-reported usage/cost when available, not a direct
OpenAI invoice estimate. Account-specific model access was not tested.

## Implemented use case

For an automatic, standalone human group request, `group-execution.mjs` asks
`fast-decisions.mjs` to choose one member or defer to the existing facilitator.
Only the latest message (at most 1,200 UTF-8 bytes) and up to eight short role
descriptions are sent. Names, slugs, missions, history, memory, AGENTS.md, tool
payloads, screenshots, and private reasoning are excluded. Oversized context,
explicit mentions, saved facilitator choices, Event plans, contextual requests,
and continuations stay on the existing path.

The helper runs once, with a configurable 1 / 2.5 / 5 second deadline, at most
64 output tokens, no SDK retries, and one transport request in flight. Busy,
invalid, refused, deferred, failed, cancelled, stale, or timed-out requests
continue through the existing facilitator and deterministic fallback. Native
connection changes cancel pending helper requests. The provider/model and
workspace generation must still match before accepting the answer. Late,
uncooperative transports retain the slot until settlement and cannot return a
late decision. The fast path uses an already-warmed native workspace; it does
not boot or repair the engine on its deadline.

Before accepting a choice, the owning group request, cancellation state, roster,
member creation identity/role, and facilitator settings must still match. Main
navigation does not discard admitted background group work; this helper is
bound to its persisted request, not the visible tab. No browser or screenshot
observation is used. The native workflow records the speaker plan, submits the
reply, and retains model, tool, and permission boundaries. The helper does not
admit, resume, approve, or execute work itself.

## Model connection and Call-key scope

Fast decisions uses the native provider connection already configured for the
team. Its Settings control and Test action require no Call-mode key. The opt-in
remains separate and defaults to off; enabling it does not change the selected
conversation model. If Luna is unavailable, Settings names the existing
facilitator fallback and points to Available models. An unavailable Call-key
settings read does not block fast-decision controls.

`openai-credential.mjs` continues to own Call mode's encrypted
`voice-call-key.bin` in main. Add/Replace/Remove and masked system entry now say
voice-only usage; removal during key entry cannot resurrect the credential.
Call mode retains its separate opt-in and legacy consent. Its primary key never
travels through renderer state, IPC, settings projections, Den or provider-error
text. Removing this voice key cannot disable native Luna routing.

## Other opportunities inspected

| Existing path / delay | Possible change and necessary data | Fallback / measurement |
| --- | --- | --- |
| Group routing can make two attempts on each of two native models before replies begin | Implemented: one bounded member choice from latest request and roles | Existing facilitator; measure send-to-first-reply, choice quality, valid output, deferrals, timeouts and actual token cost |
| Native progress summary creates a fresh thread and polls its snapshot | A future fixed-label classifier could use canonical tool categories and dependency counts | Existing deterministic activity; compare useful information against local labels before adding paid inference |
| Browser/computer actions wait for a reasoning/tool round trip | A future choice helper could rank an already validated action set from a fresh scoped observation | Native action/approval path; measure correct action, stale-observation rejection and successful task completion, including network overhead |
| Voice Call mode delegates work through the native thread | Evaluate full-duplex conversational front ends independently of work execution | Current Call/native delegation; measure interruption, first audible response and correctness while native work continues |

Progress completion/failure and approvals are already grounded in native
receipts; a model classifier should not replace those authoritative facts.
Worker model selection is also already bounded by catalog, preferences and
cost guards; an extra classifier has no established benefit there.

## Model adoption recommendation

[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) was
announced September 29. It supports text/images and tool calling through
Responses, and requires at least low reasoning effort. Consider it for native
Worker tasks after comparing it with the selected model on the same real work.
Native model discovery/provider compatibility and account access need to confirm
picker availability; no hardcoded entry or automatic model switch was added.
The native provider connection remains separate from the voice-only Call key.

[Astra Ultrafast](https://developers.openai.com/api/docs/guides/ultrafast-mode)
is a Responses service tier, not a new model or Decisions API. It documents
faster token generation, recommends persistent WebSockets because network
cost can reduce gains, and is available at low default rate limits with Global
or US processing. Small-prompt pricing is $60 input / $300 output per million
tokens, compared with Astra Standard $10 / $50. No end-to-end Coworker speedup
has been established. Do not silently adopt that tier for routine routing.

## Verification and how to try

Passed on the revised candidate: Coworker renderer/test typecheck, six focused
fast-decision/credential/native-adapter cases, seven Call and Call-contract
cases, the group-routing/native-fallback case, the native launch prerequisite
case, the native isolation-hook case (also covering the unchanged memory and
progress policies), and synthetic release-manifest validation. Plugin source
entries match the required manifest entries. These checks use fixtures and
prove plumbing, cancellation, bounded input/output and fallback, not live
model quality. Synthetic native usage was 250 input / 8 output tokens and
$0.000029; a 1-second deadline fixture confirmed timeout and cancellation.

The actual Settings component was rendered with a local IPC fixture and no
Call key: Fast decisions could be enabled and Test could run, while Voice calls
remained disabled. The missing-Luna state showed the facilitator fallback and
disabled Test. Screenshot: `coworker-luna-native-settings.jpg` in the task's
local visualization artifacts. Temporary preview files and its server were
removed afterward. This component preview is not native model-access proof.

Pending: live native Luna access, refusal/choice quality on real prompts,
end-to-end latency, valid-choice rate, real cost, model A/B comparisons,
native system-key entry and packaged execution. No real API key was retrieved,
read, entered or logged. No broad suites, native rebuild, installed-app update,
commit, push, PR or release was performed.

To try the source app in a fresh isolated profile (the normal dev launcher will
prepare the native runtime and renderer):

```sh
cd /Users/jalillaaraichi/openwork-worktrees/coworker-fast-decisions
coworkerPreview=$(mktemp -d /tmp/coworker-fast-decisions.XXXXXX)
COWORKER_USER_DATA_DIR="$coworkerPreview/profile" \
COWORKER_HOME_DIR="$coworkerPreview/team" \
COWORKER_SERVER_CONFIG="$coworkerPreview/config/openwork.json" \
OPENWORK_RUNTIME_DB="$coworkerPreview/config/runtime.sqlite" \
OPENWORK_ENV_STORE="$coworkerPreview/config/env.json" \
XDG_CONFIG_HOME="$coworkerPreview/xdg-config" \
PORT=5519 pnpm_config_verify_deps_before_run=false \
pnpm --filter @openwork/coworker dev
```

This launch command was not exercised in this pass. Shared installed dependencies
are linked from the inspected Call candidate; do not purge them or run install
through those links. Connect the usual native provider and confirm Luna appears
in Available models. In Settings › OpenAI, enable Fast decisions and use Test
decision, then ask a simple question in a group with distinct roles and an
automatic facilitator. No Call key is needed for these steps. Collect same-task
native baseline and helper latency/quality/cost before recommending adoption.
