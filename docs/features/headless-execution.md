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
