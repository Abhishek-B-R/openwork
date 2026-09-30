import { afterAll, beforeAll, expect, mock, test } from "bun:test";
const rows = {
  from: () => rows,
  where: async () => [{ id: "fixture-resource" }],
};
mock.module("../src/db.js", () => ({ db: { select: () => rows } }));
let check: (typeof import("../src/headless/authority.js"))["assertHeadlessFlags"];
beforeAll(async () => {
  process.env.DATABASE_URL =
    "mysql://fixture:fixture@127.0.0.1:1/not_connected";
  process.env.GATEWAY_ENABLED = "false";
  process.env.DEN_DB_ENCRYPTION_KEY = "x".repeat(32);
  process.env.BETTER_AUTH_SECRET = "y".repeat(32);
  process.env.BETTER_AUTH_URL = "http://127.0.0.1:8790";
  check = (await import("../src/headless/authority.js")).assertHeadlessFlags;
});
afterAll(() => mock.restore());
test("headless surface flags are default-off and independent of Web entitlement", () => {
  for (const headlessAutomation of [undefined, false, null, "true", 1]) {
    expect(() =>
      check(
        {
          capabilities: {
            headlessAutomation,
            workbot: true,
            slackAssistant: true,
          },
          plan: { tier: "enterprise" },
        },
        "workbot",
      ),
    ).toThrow();
    expect(() =>
      check(
        {
          capabilities: {
            headlessAutomation,
            workbot: true,
            slackAssistant: true,
          },
        },
        "slack",
      ),
    ).toThrow();
  }
  expect(() =>
    check(
      {
        capabilities: { headlessAutomation: true, workbot: true },
        plan: { tier: "free" },
      },
      "workbot",
    ),
  ).not.toThrow();
  expect(() =>
    check(
      { capabilities: { headlessAutomation: true, workbot: true } },
      "slack",
    ),
  ).toThrow();
  expect(() =>
    check(
      JSON.stringify({
        capabilities: { headlessAutomation: true, slackAssistant: true },
      }),
      "slack",
    ),
  ).not.toThrow();
  expect(() =>
    check(
      { capabilities: { headlessAutomation: true, slackAssistant: true } },
      "workbot",
    ),
  ).toThrow();
});
