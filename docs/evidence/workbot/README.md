# Local Workbot acceptance evidence

All accounts, workspaces, prompts and read results here are synthetic. These
screens show the actual Den web UI against an isolated MySQL database, Redis,
real Den authentication/membership/admin routes, the actual OpenWork MCP gateway,
SQLite worker state and the pinned native OpenCode v2 executable.
The inference model and external read connection used for these screens are
explicitly labeled deterministic witnesses. No external message was sent.

- [Empty](empty.png): signed-in enabled conversation with no runs or files.
- [Success](success.png): an actual file write/read and upstream read call,
  persisted result, duration and resumable activity.
- [Files](files.png): memory.md contains the preference saved by the native run.
- [Scheduled](scheduled.png): due scheduled work and manual runs share history;
  editing, pause/resume and Run now were exercised through the browser.
- [Error](error.png): an unavailable model connection yields a failed run with
  a visible retry action. Restoring the connection does not erase its history.
- [Blocked](blocked.png): platform-admin revocation clears the exposed state
  and disables the composer/schedules. The file read endpoint returns 403.
- [Calendar](calendar.png): absent live calendar is reported explicitly.
- [Admin](admin.png): independent default-off flags and exact approved-read
  list, while the organization has no OpenWork Web access.
- [Navigation](navigation.png): Workbot appears in existing Den navigation.

Actual HTTP checks also verified default-off admission, an ordinary owner
receiving 403 on platform-admin flag updates, and cross-organization state access
receiving the existing privacy-preserving 404. Private session tokens remain
outside the repository.

Design rules applied: P1 (compact UI), P3/P4 (quiet states and separators), P5
(native semantic tokens), P10 (navigation), P11 (empty/error/blocked states), S1/S2
(single primary conversation), C1/C5/C6 (existing controls, focus and disabled
states), T5 (row layouts). The Paper Home/Calendar reference was read through
OpenWork Connect. Takeover is visibly unavailable, and scheduled destinations
remain drafts in the member conversation.

[Signed out](signed-out.png) shows cleared conversation state and the existing
Den sign-in action. [Genuine inference](genuine-inference.json) is a separate
native acceptance run with qwen3:4b through local Ollama: a real memory.md write
and read, one upstream MCP read, final `Done`, 891 input/966 output tokens,
172.6 seconds, and a 300-second bound. The external MCP is synthetic; inference
is genuine. The older installed coder model advertised tools but returned plain
JSON text, so it was not accepted as a tool-capable result. No text was converted
into tool calls.

[Compiled runtime smoke](compiled-smoke.json) and [its UI](compiled-success.png)
verify a browser submission through the built Den API and separate compiled
Node worker. The 300-second request bound was retained, the result was persisted,
and actual file/MCP activity was observed. This smoke uses the labeled
deterministic model fixture. The final genuine Workbot UI grant requires user
approval; the genuine native-engine witness above passed independently.
