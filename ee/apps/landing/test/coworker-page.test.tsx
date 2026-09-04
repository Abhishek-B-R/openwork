import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CoworkerAvatar, CoworkerMark } from "../components/coworker-brand";
import { AUTOMATIC_PREVIEW, AVATAR_COLORS, CoworkerSettingsVignette, GLASSES, RECENT_CHANGES, VOICES } from "../components/coworker-settings-vignette";
import { CoworkerVignette, TEAM } from "../components/coworker-vignette";
import { SiteFooter } from "../components/site-footer";
import {
  AGENT,
  CLOUD,
  COWORKER,
  CUSTOMIZE,
  FORBIDDEN_PHRASES,
  GET_STARTED,
  HERO,
  MEMORY,
  PLACEMENTS,
  STEPS,
  TEAM as TEAM_COPY,
  WITH_OPENWORK,
  allClaims
} from "../lib/coworker-content";

const root = join(import.meta.dir, "..");

describe("/coworker copy", () => {
  test("every product claim names where in the product it is true", () => {
    const claims = allClaims();
    expect(claims.length).toBeGreaterThanOrEqual(14);
    for (const claim of claims) {
      expect(claim.text.trim().length, `claim is too thin: ${claim.text}`).toBeGreaterThan(20);
      if (claim.planned) {
        expect(claim.source, `a planned statement must be sourced to the product plan: ${claim.text}`).toMatch(/^plans\//);
        expect(claim.text, `a planned statement must read as direction, not as shipped: ${claim.text}`).toMatch(/direction|toward|next|over time/i);
        continue;
      }
      expect(claim.source, `claim needs a product source, got "${claim.source}" for: ${claim.text}`).toMatch(
        /(apps\/coworker|packages\/|ee\/apps\/den-api|ee\/apps\/landing\/app\/pricing|@openwork\/)/
      );
    }
  });

  test("only one statement on the page is about direction, and it says so", () => {
    const planned = allClaims().filter((claim) => claim.planned);
    expect(planned).toHaveLength(1);
    expect(planned[0]!.text).toMatch(/today a coworker lives on your Mac/);
  });

  test("the page says plainly what is yours to shape, and each of those claims is sourced", () => {
    expect(CUSTOMIZE.items.length).toBeGreaterThanOrEqual(6);
    const labels = CUSTOMIZE.items.map((item) => item.label);
    for (const label of ["Name, role, mission", "Soul", "Voice", "Face", "AI model", "Memory", "Team"]) expect(labels).toContain(label);
    // The lead names the folder-of-files fact and the Automatic model; the items name the real controls.
    expect(CUSTOMIZE.lead.text).toMatch(/folder of plain files/);
    expect(CUSTOMIZE.lead.text).toMatch(/Automatic/);
    expect(CUSTOMIZE.items.find((item) => item.label === "Voice")!.text).toMatch(/never how it works/);
    expect(CUSTOMIZE.items.find((item) => item.label === "AI model")!.text).toMatch(/from the same provider/);
    expect(CUSTOMIZE.items.find((item) => item.label === "Memory")!.text).toMatch(/undone/);
    expect(CUSTOMIZE.items.find((item) => item.label === "Team")!.text).toMatch(/only your tap creates it/);
    // Every item is part of the honesty footnote.
    const claimTexts = allClaims().map((claim) => claim.text);
    for (const item of CUSTOMIZE.items) expect(claimTexts).toContain(`${item.label}: ${item.text}`);
    expect(claimTexts).toContain(CUSTOMIZE.lead.text);
  });

  test("copy never promises what the product cannot do, and never sells against OpenWork", () => {
    const everything = JSON.stringify({ HERO, WITH_OPENWORK, STEPS, CUSTOMIZE, MEMORY, TEAM_COPY, PLACEMENTS, CLOUD, GET_STARTED, AGENT }).toLowerCase();
    for (const phrase of FORBIDDEN_PHRASES) {
      expect(everything.includes(phrase), `forbidden phrase present: "${phrase}"`).toBe(false);
    }
    // A complement, said so: the page names OpenWork as the platform underneath, in the hero and the comparison.
    expect(HERO.lead).toMatch(/OpenWork/);
    expect(WITH_OPENWORK.lead).toMatch(/nothing is duplicated underneath/i);
    expect(WITH_OPENWORK.rows.length).toBeGreaterThanOrEqual(4);
  });

  test("placement copy keeps local and cloud promises distinct and truthful", () => {
    const local = PLACEMENTS.items.find((item) => item.name === "This Mac");
    const cloud = PLACEMENTS.items.find((item) => item.name === "OpenWork Cloud");
    expect(local && cloud).toBeTruthy();
    expect(local!.points.join(" ")).toMatch(/while Open Coworker is open/);
    expect(local!.points.join(" ")).toMatch(/recovered once on launch/);
    expect(cloud!.points.join(" ")).toMatch(/even when your Mac is off/);
    expect(cloud!.points.join(" ")).toMatch(/Cannot read the coworker's local files or memory/);
    expect(CLOUD.cloud.cta.href.startsWith("https://app.openworklabs.com?mode=sign-up")).toBe(true);
    expect(CLOUD.cloud.cta.href).toContain("utm_campaign=coworker");
    expect(CLOUD.cloud.secondary.href).toBe("/pricing");
    expect(CLOUD.teams.cta.href).toBe("/enterprise");
  });

  test("get-started is honest about distribution and points at the real repository", () => {
    expect(GET_STARTED.status).toMatch(/no signed download yet/);
    expect(GET_STARTED.commands.some((command) => command.includes("@openwork/coworker dev"))).toBe(true);
    expect(GET_STARTED.commands[0]).toBe(`git clone ${COWORKER.repository}`);
  });

  test("the agent resources the page links to exist on this site and agree with it", () => {
    for (const link of AGENT.links) {
      const file = join(root, "public", link.href);
      expect(existsSync(file), `${link.href} must be served from public/`).toBe(true);
    }
    const start = readFileSync(join(root, "public", "coworker", "start.md"), "utf8");
    expect(start).toMatch(/Use this Mac/);
    expect(start).not.toMatch(/Start locally/);
    expect(start).toMatch(/no signed download yet/i);
    for (const command of GET_STARTED.commands) expect(start).toContain(command);
    const llms = readFileSync(join(root, "public", "llms.txt"), "utf8");
    expect(llms).toContain("## Open Coworker");
    expect(llms).toContain("https://openworklabs.com/coworker/start.md");
    expect(AGENT.promptTemplate("https://openworklabs.com/coworker/start.md")).toMatch(/Use this Mac/);
    expect(existsSync(join(root, "public", "coworker", "og.png"))).toBe(true);
  });
});

describe("/coworker visuals", () => {
  test("the brand mark and avatars render as accessible SVG in the app's palettes", () => {
    const mark = renderToStaticMarkup(createElement(CoworkerMark, { size: 30, label: "Open Coworker" }));
    expect(mark).toContain('role="img"');
    expect(mark).toContain('aria-label="Open Coworker"');
    expect(mark).toContain("#f7f8fa");
    const avatar = renderToStaticMarkup(createElement(CoworkerAvatar, { name: "Editor", color: "rose", glasses: "square" }));
    expect(avatar).toContain('aria-label="Editor avatar"');
    expect(avatar).toContain("#e2c1cb");
    expect(avatar).toContain("<rect");
  });

  test("the vignette shows the app's own states and vocabulary, never a feature it lacks", () => {
    const html = renderToStaticMarkup(createElement(CoworkerVignette));
    expect(TEAM.map((member) => member.label)).toEqual(["Working", "Needs you", "Ready"]);
    for (const member of TEAM) expect(html).toContain(member.name);
    for (const phrase of ["Coworkers", "Activity", "Thought through", "Documents", "Workers", "Assignments", "Message Scout", "Enter sends it next"]) {
      expect(html).toContain(phrase);
    }
    for (const phrase of ["Response delayed", "could not reply", "engine", "MCP", "session"]) {
      expect(html.toLowerCase()).not.toContain(phrase.toLowerCase());
    }
  });

  test("the settings vignette shows the app's own controls and words, in the app's palette, never a control it lacks", () => {
    const html = renderToStaticMarkup(createElement(CoworkerSettingsVignette));
    for (const phrase of ["Coworker settings", "Profile", "Name", "Role", "Mission", "Personality", "Face", "AI model", "Automatic", "Thinking effort", "Memory", "Soul", "Working memory", "Long-term", "Recent changes", "Undo", "Edit", "Team", "Add a coworker", "Retired coworkers"]) {
      expect(html, phrase).toContain(phrase);
    }
    expect(html).toContain(AUTOMATIC_PREVIEW);
    for (const change of RECENT_CHANGES) expect(html).toContain(change);
    // Twelve voices as the app's picker lists them; six colors and three glasses as the app offers them.
    expect(VOICES).toHaveLength(12);
    for (const voice of VOICES) expect(html).toContain(voice);
    expect(AVATAR_COLORS).toHaveLength(6);
    expect(GLASSES).toEqual(["round", "square", "none"]);
    expect((html.match(/<svg/g) ?? []).length).toBeGreaterThanOrEqual(AVATAR_COLORS.length + GLASSES.length + 3);
    // The app's ink, not the site's light tokens, and nothing the app cannot do.
    expect(html).toContain("#0b0e14");
    for (const phrase of ["upload", "fine-tune", "train", "plugin store", "marketplace", "engine", "MCP", "session"]) {
      expect(html.toLowerCase(), phrase).not.toContain(phrase.toLowerCase());
    }
  });

  test("the site chrome can sit on the product-dark page without changing its light default", () => {
    const light = renderToStaticMarkup(createElement(SiteFooter));
    const dark = renderToStaticMarkup(createElement(SiteFooter, { tone: "dark" }));
    expect(light).toContain('data-tone="light"');
    expect(light).toContain("hover:text-gray-800");
    expect(light).not.toContain("hover:text-white");
    expect(dark).toContain('data-tone="dark"');
    expect(dark).toContain("hover:text-white");
    expect(dark).not.toContain("hover:text-gray-800");
    expect(dark).toContain('href="/coworker"');
    // The page scope and the css that flips the tokens exist and agree on the app's ink.
    const page = readFileSync(join(root, "app", "coworker", "page.tsx"), "utf8");
    expect(page).toMatch(/className="lp-dark /);
    expect(page).toContain('tone="dark"');
    expect(page).toContain("#0b0e14");
    const css = readFileSync(join(root, "app", "globals.css"), "utf8");
    const darkScope = css.slice(css.indexOf(".lp-dark {"), css.indexOf(".lp-pill-primary,\n.lp-pill-secondary,"));
    expect(darkScope).toContain("--lp-ink: #f4f6fa;");
    expect(darkScope).toContain("--lp-page: #0b0e14;");
    expect(darkScope).toContain("--lp-tonal: #141924;");
    expect(darkScope).toMatch(/\.lp-dark \.lp-pill-primary,[\s\S]*color: #0b0e14;/);
    // No cream, beige, or warm-white anywhere the coworker page draws from — the app's ink, panel, snow, and mist only.
    const coworkerSources = [
      page,
      darkScope,
      readFileSync(join(root, "components", "coworker-settings-vignette.tsx"), "utf8"),
      readFileSync(join(root, "components", "coworker-vignette.tsx"), "utf8"),
      readFileSync(join(root, "components", "coworker-brand.tsx"), "utf8"),
    ].join("\n");
    const warm = /#(?:f[5-9a-f][0-9a-f]{2}[c-e][0-9a-f]|e[c-f]e[0-9a-f]d[0-9a-f]|fdf[0-9a-f]{3}|faf[0-9a-f]{3}|fff[0-9a-f]e[0-9a-f]|fef3c7|fffbeb|fef9c3)\b/gi;
    expect(coworkerSources.match(warm) ?? []).toEqual([]);
  });

  test("the site links to /coworker from its footer", () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));
    expect(html).toContain('href="/coworker"');
  });
});
