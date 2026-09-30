import { expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { HeadlessRun } from "@openwork-ee/headless-execution/contract";
import * as requests from "../app/(den)/_lib/den-flow";
import { ChatText, WorkbotReply } from "../app/(den)/workbot/workbot-screen";

const run: HeadlessRun = {
  id: "sample-message",
  actor: { organizationId: "sample-org", memberId: "sample-member" },
  surface: "workbot",
  conversationKey: "main",
  idempotencyKey: "sample-request",
  prompt: "Can you draft a plan for today?",
  status: "succeeded",
  createdAt: "2026-09-30T09:00:00Z",
  startedAt: "2026-09-30T09:00:00Z",
  finishedAt: "2026-09-30T09:00:02Z",
  result:
    "Here’s a first pass. I saved **daily-brief.md** for us to edit together.",
  failure: null,
  usage: { inputTokens: 1234, outputTokens: 5678, durationMs: 271828 },
};
const actions = {
  onOpen: () => undefined,
  onEdit: () => undefined,
  onRetry: () => undefined,
};

test("a reply shows the answer once and a real saved draft, without execution UI", () => {
  const html = renderToStaticMarkup(
    createElement(WorkbotReply, {
      run,
      files: ["daily-brief.md"],
      canRetry: true,
      ...actions,
    }),
  );
  expect(html).toContain("<strong>daily-brief.md</strong>");
  expect(html.match(/Here’s a first pass/g)).toHaveLength(1);
  expect(html).toContain("Edit together");
  for (const hidden of [
    "Activity",
    "Finished",
    "Queued",
    "271828",
    "1234",
    "5678",
    "sample-message",
    "sample-org",
    "sample-member",
    "<details",
  ])
    expect(html).not.toContain(hidden);
  const missing = renderToStaticMarkup(
    createElement(WorkbotReply, { run, files: [], canRetry: true, ...actions }),
  );
  expect(missing).not.toContain("Saved draft");
});

test("waiting for an answer shows only a typing indicator", () => {
  for (const status of [
    "queued",
    "running",
  ] satisfies HeadlessRun["status"][]) {
    const html = renderToStaticMarkup(
      createElement(WorkbotReply, {
        run: { ...run, status, result: null },
        files: [],
        canRetry: false,
        ...actions,
      }),
    );
    expect(html).toContain('aria-label="Workbot is replying"');
    expect(html).not.toContain("Queued");
    expect(html).not.toContain("Working");
    expect(html).not.toContain("Activity");
  }
});

test("stopping and denied access give conversational recovery without internal codes", () => {
  const stopped = renderToStaticMarkup(
    createElement(WorkbotReply, {
      run: { ...run, status: "cancelled", result: null },
      files: [],
      canRetry: true,
      ...actions,
    }),
  );
  expect(stopped).toContain("Send another message");
  const blocked = renderToStaticMarkup(
    createElement(WorkbotReply, {
      run: {
        ...run,
        status: "blocked",
        result: null,
        failure: {
          code: "model_grant_unavailable",
          message: "Ask your team admin to connect a model.",
        },
      },
      files: [],
      canRetry: false,
      ...actions,
    }),
  );
  expect(blocked).toContain("Ask your team admin");
  expect(blocked).not.toContain("model_grant_unavailable");
  expect(blocked).toContain("disabled");
});

test("assistant markdown does not execute HTML or load unrequested images", () => {
  const html = renderToStaticMarkup(
    createElement(ChatText, {
      text: "<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))\n\n![Remote image](https://example.test/tracker.png)",
    }),
  );
  expect(html).not.toContain("<script>");
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain("<img");
});

test("Open reads the saved draft and Edit together targets that same file", async () => {
  GlobalRegistrator.register({ url: "http://example.test/workbot" });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  const paths: string[] = [];
  const read = spyOn(requests, "requestJson").mockImplementation(
    async (path) => {
      paths.push(path);
      return {
        response: new Response("{}"),
        payload: {
          path: "daily-brief.md",
          text: "# Today\n\nFinish the draft together.",
        },
      };
    },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const opened: string[] = [],
    edited: string[] = [];
  try {
    await act(async () =>
      root.render(
        createElement(WorkbotReply, {
          run,
          files: ["daily-brief.md"],
          canRetry: true,
          onOpen: (path) => {
            opened.push(path);
          },
          onEdit: (path) => {
            edited.push(path);
          },
          onRetry: actions.onRetry,
        }),
      ),
    );
    expect(paths).toEqual(["/v1/workbot/files?path=daily-brief.md"]);
    expect(container.textContent).toContain("Finish the draft together.");
    await act(async () =>
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Open")
        ?.click(),
    );
    await act(async () =>
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Edit together")
        ?.click(),
    );
    expect(opened).toEqual(["daily-brief.md"]);
    expect(edited).toEqual(["daily-brief.md"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    read.mockRestore();
    await GlobalRegistrator.unregister();
  }
});
