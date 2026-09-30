# Activity: member changes and background notices

ENG-278 replaces the desktop Notifications popover with a member Activity
popover and full page. Organization-wide audit history belongs in Den and is
not part of this surface.

## What belongs here

- Changes to the signed-in member's usable model-provider access.
- Newly available skills/plugins and published skill or connection revisions.
- Meaningful connection configuration changes and observed unavailability.
- Existing device/background notices: applied or pending engine reloads, update
  checks and background failures, with their existing actions.

Confirmations of the user's own actions, such as archiving a session or
installing a skill, remain toast-only. Task permission/question prompts and
native OS notifications keep their separate delivery contracts. Activity does
not collect all toasts, other people's activity, usage analytics or automation
history.

## Observations, not an audit log

Existing desktop cloud-sync lifecycle hooks and inventory-change signals ask
one app-level observer to read the current usable inventories. The observer
compares complete, successful results with the previous successful snapshots.
Installation drift and engine connectivity are not permission evidence.

- The first successful inventory is a silent baseline, including an empty one.
- A repeated inventory adds nothing. Later revisions and removal/re-grant
  transitions are distinct observations.
- Connections retain the usable connection ID across direct and plugin grants;
  an unbound plugin configuration is represented by its plugin, not a fabricated
  connection. Binding it cannot remove an already usable connection.
- The feed uses stable resource identities and records when this device
  **observed** a change. The timestamp is not the time someone granted access
  or published a version.
- Actor, team, audience count, deletion reason and connection-health history
  are not inferred. Copy says “You now have access to …”, “… was updated”, or
  “… is no longer available to you”.
- Failed/partial reads preserve the last successful baselines and entries;
  they never become empty inventories. The UI offers Retry and keeps the last
  verification time visible.
- A change added and removed between successful syncs can be missed. This is
  deliberately not complete historical or compliance evidence.

The client reuses existing authorized Den reads. There is no new notification
endpoint, table, server event writer or audit schema. Complete-inventory reads
reject malformed/partial responses rather than silently turning omitted rows
into removals. Grant-scoped marketplace references are resolved directly so a
paginated management catalog cannot expand or truncate the member feed.

## Identity and persistence

`openwork:member-activity:v1` stores comparison baselines and up to 100 entries
from the last 30 days per deployment/organization/member, for up to five recent
contexts. Baselines survive entry expiry. The active identity and refresh state
are never persisted. A newly verified identity selects only its own context;
identity changes invalidate in-flight deliveries.

Only minimal display metadata, resource IDs, content revisions/digests,
observation times and internal destinations are stored. Skill content,
connection URLs, credentials and raw provider configuration are not retained.
There is no persisted read/unread state, unread count or mark-all-read flow.
Opening the popover or page does not mutate history.

Existing device notices retain their separate bounded local store. Its legacy
read field remains an in-memory compatibility detail and is not serialized.
Old unscoped cloud/provider entries cannot be attributed to a member and are
not migrated into the member feed. Resource-change producers now request a
verified member refresh instead of adding duplicate, profile-wide notices.

## Presentation

- The shared sidebar/titlebar bell is named **Activity** and opens on demand.
- The popover shows the latest five entries and **View all**. An available
  resource row opens its existing destination; unavailable rows have no dead
  action. System notices retain their existing action where applicable.
- `/activity` uses the normal conversation sidebar, groups entries by observed
  day, and filters All / Models / Skills / Plugins / Connections. Device notices
  appear under All.
- The empty popover follows Paper QOD-1: a quiet bell, **Nothing new**, and a short explanation. The full page offers **Browse Library**. A filter
  with no results offers **Show all activity**.
- Refreshing preserves existing rows. An initial load uses matching skeletons;
  failure keeps known rows and offers Retry. Unavailable resources remain
  visible, muted and locked, without naming an unrecorded actor or reason.
- Admins get the same member surface, not an Organization switch.
- New entries never open the panel, change routes or create popups.

These choices follow DESIGN.md P1/P2 (state rather than explanatory prose),
P5 (existing primitives), S2 (compact rows), S5 (no automatic navigation),
C5/C6 (neutral unavailable states and useful recovery), and P10 (visual proof).

## Verification boundaries

- `apps/app/tests/member-activity-store.test.ts`: successful snapshots → scoped
  entries, silent initialization, revisions, deduplication, removal/re-grant,
  persistence, corruption/expiry and identity boundaries.
- `apps/app/tests/member-activity-sync.test.ts`: existing inventory reads → feed,
  partial failures, stale delivery and connection configuration versus health.
- `apps/app/tests/member-activity-ui.test.tsx`: bell → page, filters, actions and
  non-happy states without unread behavior.
- `evals/specs/member-activity-sync.e2e.test.ts`: real Den grants and version
  changes → real app Activity, refresh failures, restart and another member on
  the same device. HTTP reads witness the synchronization boundary.
- `evals/specs/notification-center-scope.e2e.test.ts`: background notices still
  work, archive/Undo remains toast-only, and Activity stays reachable with the
  sidebar hidden. The legacy event seam here is not evidence of Cloud sync.

The previous notification-center contract (PR #2215, later scope clarification)
kept user-action confirmations out of the bell. That delivery distinction is
preserved; persisted unread tracking and the explanatory empty-state copy are
intentionally replaced by the ENG-278 member-feed contract.
