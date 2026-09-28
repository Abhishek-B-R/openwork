import { readdir, readFile } from 'node:fs/promises';

// Every journey describes itself in its own spec file; there is no list to keep in step.
//   - Readable name: the one-line summary of a JSDoc block at the very top of the file
//     (falls back to the filename).
//   - Journey tags: Vitest `@module-tag` lines in that block. The tag descriptions in
//     evals/vitest.config.ts are the documentation (`pnpm --dir evals exec vitest --list-tags`).
//   - Registered cases: tests whose title starts with a case ID (`HOME-01 …`) and that carry an
//     `engine-v1`/`engine-v2` tag (per test via `{ tags: [...] }`, or for the whole file).
//   - Raw-desktop specs (they import `desktop` from @openwork/hosts) are manual, as before.
// Specs are parsed as text, never imported: the required-verification controller reads PR
// source as data only, and the CI planners run without evals dependencies installed.

// `needs` is what a journey requires beyond its placement (an env var the lane must provide, an
// opt-in, or a platform), in the TestNeeds vocabulary the specs use. It is a WHOLE-FILE blocker:
// a prerequisite only some cases need stays in that case's own `needs` and skips with its own
// reason. The planner reports a journey whose needs the lane cannot meet as "skipped: lane cannot
// satisfy prerequisites" instead of scheduling a guaranteed skip. journey-ci.test.mjs checks the
// tags against what each spec and its worlds actually guard.
const TAG_NEEDS = Object.freeze({
  packaged: { env: ['OPENWORK_EVAL_ELECTRON_BINARY'] },
  'live-openai': { env: ['OPENAI_API_KEY'], optIn: ['OPENWORK_EVAL_LIVE_OPENAI'] },
  macos: { platform: 'darwin' },
});
const ENGINES = ['v1', 'v2'];
const CASE_ID = /^[A-Z][A-Z0-9]*(?:-[A-Za-z0-9]+)+(?=[\s:]|$)/;

// Same grammar Vitest uses for `@module-tag` (any `//` or `*` comment line in the file).
export function moduleTags(source) {
  return [...source.matchAll(/(?:\/\/|\*)\s*@module-tag\s+([\w\-/]+)\b/g)].map(match => match[1]);
}

export function journeyName(source) {
  const block = source.match(/^\s*\/\*\*([\s\S]*?)\*\//)?.[1];
  const summary = block?.split('\n').map(line => line.replace(/^\s*\*?\s?/, '').trim()).find(line => line !== '');
  return summary && !summary.startsWith('@') ? summary : undefined;
}

// Index just past the string literal that opens at `start`, following `${…}` in template literals.
function literalEnd(source, start) {
  const quote = source[start];
  let depth = 0;
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index];
    if (char === '\\') { index++; continue; }
    if (quote === '`' && depth === 0 && char === '$' && source[index + 1] === '{') { depth = 1; index++; continue; }
    if (depth > 0) { if (char === '{') depth++; else if (char === '}') depth--; continue; }
    if (char === quote) return index + 1;
  }
  return source.length;
}

// The `{ … }` options object right after a test title, if any.
function optionsAfter(source, index) {
  const open = source.slice(index).match(/^\s*,\s*\{/);
  if (!open) return '';
  const start = index + open[0].length - 1;
  let depth = 0;
  for (let cursor = start; cursor < source.length; cursor++) {
    if (source[cursor] === '{') depth++;
    else if (source[cursor] === '}' && --depth === 0) return source.slice(start, cursor + 1);
  }
  return '';
}

// Tests (`test(`, `it(`, and fixtures such as `latencyTest(`) with their title and own tags.
export function specTests(source) {
  return [...source.matchAll(/(?<![\w.])(?:it|test|\w+Test)\s*\(\s*(?=["'`])/g)].map(match => {
    const start = match.index + match[0].length;
    const end = literalEnd(source, start);
    const options = optionsAfter(source, end);
    const list = options.match(/\btags:\s*(\[[^\]]*\]|["'][^"']*["'])/)?.[1] ?? '';
    return { title: source.slice(start + 1, end - 1), tags: [...list.matchAll(/["']([^"']+)["']/g)].map(tag => tag[1]) };
  });
}

// `optIn` literals the spec declares; a registered case consents to these plus the e2e opt-in.
function declaredOptIns(source) {
  const names = [...source.matchAll(/optIn\s*:\s*\[([^\]]*)\]/g)]
    .flatMap(match => [...match[1].matchAll(/["'](OPENWORK_EVAL_[A-Z0-9_]+)["']/g)].map(name => name[1]));
  return [...new Set(names)].sort();
}

function needsFor(tags) {
  const needs = {};
  for (const tag of tags) {
    for (const [key, value] of Object.entries(TAG_NEEDS[tag] ?? {})) {
      needs[key] = Array.isArray(value) ? [...new Set([...(needs[key] ?? []), ...value])] : value;
    }
  }
  const ordered = Object.fromEntries(['env', 'optIn', 'platform'].filter(key => key in needs).map(key => [key, needs[key]]));
  return Object.keys(ordered).length ? ordered : undefined;
}

export function journeyEntry(spec, source) {
  const tags = new Set(moduleTags(source));
  const rawDesktop = /import\s*\{[^}]*\bdesktop\b[^}]*\}\s*from\s*["']@openwork\/hosts["']/s.test(source);
  const placement = tags.has('local-only') ? 'local' : rawDesktop ? 'manual' : 'daytona';
  const entry = {
    spec,
    name: journeyName(source) ?? spec.replace('.e2e.test.ts', '').replaceAll('-', ' '),
    critical: tags.has('critical'),
    model: tags.has('live-model') ? 'live' : 'mock',
    placement,
  };
  const needs = needsFor(tags);
  if (needs) entry.needs = needs;
  const optIns = ['OPENWORK_EVAL_E2E_TESTS', ...declaredOptIns(source).filter(name => name !== 'OPENWORK_EVAL_E2E_TESTS')];
  const cases = specTests(source).flatMap(({ title, tags: own }) => {
    const id = title.match(CASE_ID)?.[0];
    const engines = ENGINES.filter(engine => tags.has(`engine-${engine}`) || own.includes(`engine-${engine}`));
    // Examples run locally (every placement can) on the newest engine the case supports.
    return id && engines.length ? [{ id, engines, optIns, example: { placement: '--local', engine: engines.at(-1) } }] : [];
  });
  if (cases.length) entry.cases = cases;
  return entry;
}

export async function catalog(root = new URL('../specs/', import.meta.url)) {
  const files = (await readdir(root)).filter(file => file.endsWith('.e2e.test.ts')).sort();
  return Promise.all(files.map(async spec => journeyEntry(spec, await readFile(new URL(spec, root), 'utf8'))));
}

export const registeredCases = Object.freeze((await catalog())
  .flatMap(entry => (entry.cases ?? []).map(value => Object.freeze({ spec: entry.spec, ...value }))));

// For callers that read untrusted spec sources (the required-verification controller): a spec that
// already exists on the trusted ref keeps the trusted ref's disposition, so a PR cannot drop its own
// requirement by retagging it, and a PR cannot remove a critical journey. PR-only specs use their own tags.
export function withTrustedMetadata(candidates, trusted) {
  const present = new Set(candidates.map(entry => entry.spec));
  const missing = trusted.filter(entry => entry.critical && !present.has(entry.spec)).map(entry => entry.spec);
  if (missing.length) throw new Error(`Critical journey missing: ${missing.join(', ')}`);
  const known = new Map(trusted.map(entry => [entry.spec, entry]));
  return candidates.map(entry => known.get(entry.spec) ?? entry);
}

// `only` is a comma-separated list of filename substrings; empty matches everything.
// Delimiters alone (", ,") are a typo, not "everything": refuse them instead of running the whole suite.
export function selectJourneys(entries, { critical = false, only = '', changed = [] } = {}) {
  const filters = only.split(',').map(value => value.trim()).filter(Boolean);
  if (filters.length === 0 && only.trim() !== '') throw new Error(`The only filter "${only}" names no journey; give comma-separated filename substrings or leave it empty to select everything.`);
  return entries.filter(entry => (!critical || entry.critical || changed.includes(entry.spec))
    && (filters.length === 0 || filters.some(filter => entry.spec.includes(filter))));
}

// What the CI lane provides to every job: Linux runners and no packaged desktop binary.
// Keep in step with the e2e and local-journey jobs in .github/workflows/daytona-e2e.yml.
export const ciLane = Object.freeze({ platform: 'linux', env: Object.freeze([]) });

// Needs the lane cannot meet, phrased as the action that would meet them; empty when the journey is applicable.
export function unmetLaneNeeds(entry, lane = ciLane) {
  const missing = (entry.needs?.env ?? []).filter(name => !lane.env.includes(name)).map(name => `set ${name}`);
  missing.push(...(entry.needs?.optIn ?? []).filter(name => !lane.optIns?.includes(name)).map(name => `set ${name}=1`));
  if (entry.needs?.platform && entry.needs.platform !== lane.platform) missing.push(`run on ${entry.needs.platform}`);
  return missing;
}
