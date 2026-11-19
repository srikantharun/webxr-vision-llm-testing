/**
 * Self-generating test pipeline:  CAPTURE → FEEDBACK (vLLM) → VERIFY → CONTINUE
 * ---------------------------------------------------------------------------
 * The automated version of the "LLM proposes, deterministic oracle disposes"
 * loop — built for AR/VR/UGC games where you can't hand-write a test per scene.
 *
 *   1. CAPTURE   Playwright drives the live game → screenshot + ground-truth
 *                scene-graph metrics (window.__GAME__.counts()).
 *   2. FEEDBACK  The screenshot goes to the self-hosted vision LLM (Qwen2.5-VL
 *                on the MI300X) which PROPOSES machine-checkable test candidates
 *                as structured JSON.
 *   3. VERIFY    Each candidate is checked against the deterministic ground
 *                truth → PASS / FAIL / INVALID.
 *   4. CONTINUE  FAILs are fed BACK to the LLM to classify REAL_BUG vs
 *                BAD_SUGGESTION (hallucination). PASSes are promoted to the
 *                verified suite. Loop until no new verified tests appear.
 *
 * Verified tests are written to verified-tests.json — those run deterministically
 * in CI with NO GPU. The GPU is used only for steps 2 and 4.
 *
 * Run:
 *   set -a; source ~/vllm-llama-service/.env; set +a
 *   node pipeline.mjs
 */
import { chromium } from 'playwright';
import OpenAI from 'openai';
import fs from 'node:fs';

const GAME_URL = process.env.GAME_URL ?? 'https://localhost:8081/';
const MODEL = process.env.SERVED_NAME ?? 'qwen2.5-vl';
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const METRICS = ['targets', 'balls', 'score']; // observable scene-graph metrics

const vllm = new OpenAI({ baseURL: process.env.VLLM_URL, apiKey: process.env.VLLM_API_KEY });

// WebGL needs a GL backend in headless chromium; the dev server is self-signed HTTPS.
const CHROME_ARGS = [
  '--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
];

const log = (...a) => console.log(...a);
const keyOf = (c) => `${c?.check?.metric}:${c?.check?.op}:${c?.check?.value}`;

function parseJsonArray(text) {
  const m = text.match(/\[[\s\S]*\]/); // tolerate prose / ```json fences around it
  if (!m) return [];
  try { return JSON.parse(m[0]); } catch { return []; }
}

// ── 1. CAPTURE ──────────────────────────────────────────────────────────────
async function capture(page) {
  await page.goto(GAME_URL, { waitUntil: 'load' });
  await page.waitForFunction(
    () => window.__GAME__ && window.__GAME__.counts().targets > 0,
    null, { timeout: 30_000 },
  );
  const shot = await page.screenshot();                       // PNG buffer
  const truth = await page.evaluate(() => window.__GAME__.counts()); // {targets,balls,score}
  return { shot, truth };
}

// ── 2. FEEDBACK (vision LLM proposes structured candidates) ──────────────────
async function review(shot, truth, knownKeys) {
  const b64 = shot.toString('base64');
  const prompt =
    `You generate automated tests for a WebXR game from a screenshot.\n` +
    `Return ONLY a JSON array. Each item:\n` +
    `  {"id":"short-id","desc":"human text","type":"SCENE",` +
    `   "check":{"metric":"targets|balls|score","op":"eq|ne|gt|gte|lt|lte","value":<integer>}}\n` +
    `Only use these observable metrics: targets (count of target shapes), ` +
    `balls (count of throwable balls), score (current score number).\n` +
    `Do NOT repeat these already-known checks: ${JSON.stringify(knownKeys)}.\n` +
    `Propose up to 4 NEW, concrete candidates. JSON array only, no prose.`;
  const r = await vllm.chat.completions.create({
    model: MODEL, max_tokens: 600,
    messages: [{ role: 'user', content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
    ]}],
  });
  return parseJsonArray(r.choices[0].message.content);
}

// ── 3. VERIFY against the deterministic oracle ───────────────────────────────
const OPS = {
  eq: (a, b) => a === b, ne: (a, b) => a !== b,
  gt: (a, b) => a > b, gte: (a, b) => a >= b,
  lt: (a, b) => a < b, lte: (a, b) => a <= b,
};
function verify(cand, truth) {
  const c = cand.check ?? {};
  if (!METRICS.includes(c.metric)) return { ...cand, result: 'INVALID', reason: `unknown metric '${c.metric}'` };
  if (!OPS[c.op]) return { ...cand, result: 'INVALID', reason: `unsupported op '${c.op}'` };
  const actual = truth[c.metric];
  return { ...cand, result: OPS[c.op](actual, c.value) ? 'PASS' : 'FAIL', actual, expected: c.value };
}

// ── 4. CONTINUE: feed FAILs back → bug vs hallucination ──────────────────────
async function classify(failed, truth) {
  if (!failed.length) return [];
  const r = await vllm.chat.completions.create({
    model: MODEL, max_tokens: 500,
    messages: [{ role: 'user', content:
      `Ground-truth scene metrics: ${JSON.stringify(truth)}.\n` +
      `These proposed tests FAILED verification: ` +
      `${JSON.stringify(failed.map(f => ({ id: f.id, desc: f.desc, check: f.check, actual: f.actual })))}.\n` +
      `For EACH, decide if it is a REAL_BUG (the app is wrong) or a BAD_SUGGESTION ` +
      `(your proposal was wrong given the ground truth). Return ONLY a JSON array of ` +
      `{"id","verdict":"REAL_BUG|BAD_SUGGESTION","note"}.`,
    }],
  });
  return parseJsonArray(r.choices[0].message.content);
}

// ── LOOP ─────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ headless: true, args: CHROME_ARGS });
const page = await browser.newContext({ ignoreHTTPSErrors: true }).then((c) => c.newPage());

const verified = new Map(); // key → candidate
let lastTruth = {};
let dryRounds = 0;

for (let round = 1; round <= ROUNDS && dryRounds < 1; round++) {
  log(`\n━━━ ROUND ${round} ━━━`);
  const { shot, truth } = await capture(page);
  lastTruth = truth;
  log(`1. CAPTURE   ground truth = ${JSON.stringify(truth)}`);

  const candidates = await review(shot, truth, [...verified.keys()]);
  log(`2. FEEDBACK  vLLM proposed ${candidates.length} candidate(s)`);

  const checked = candidates.map((c) => verify(c, truth));
  const passed = checked.filter((c) => c.result === 'PASS');
  const failed = checked.filter((c) => c.result === 'FAIL');
  const invalid = checked.filter((c) => c.result === 'INVALID');
  for (const c of checked) {
    log(`3. VERIFY    [${c.result.padEnd(7)}] ${c.desc}  (${keyOf(c)}; actual=${c.actual ?? '-'})`);
  }

  const verdicts = await classify(failed, truth);
  for (const v of verdicts) log(`4. CONTINUE  ${v.id}: ${v.verdict} — ${v.note}`);

  let added = 0;
  for (const c of passed) if (!verified.has(keyOf(c))) { verified.set(keyOf(c), c); added++; }
  log(`   → +${added} newly verified (total ${verified.size}); ${failed.length} failed, ${invalid.length} invalid`);
  if (added === 0) dryRounds++;
}

// ── HARDEN: prefer EXACT assertions, one per covered metric, deduped ──────────
// The LLM proposes loose bounds (targets>5, targets>2, …). For a stable CI suite
// we collapse every metric that had a passing candidate into ONE exact assertion
// against ground truth (targets===6), dropping redundant/subsumed loose checks.
const coveredMetrics = [...new Set([...verified.values()].map((c) => c.check.metric))];
const hardened = coveredMetrics.map((m) => ({
  id: m,
  desc: `${m} === ${lastTruth[m]}`,
  type: 'SCENE',
  check: { metric: m, op: 'eq', value: lastTruth[m] },
}));
fs.writeFileSync('verified-tests.json', JSON.stringify(hardened, null, 2));
log(`\n✅ ${verified.size} raw passes → hardened to ${hardened.length} exact, deduped tests → verified-tests.json`);

// ── CODEGEN: emit a Playwright spec that runs these GPU-free in CI ────────────
function genSpec(cases) {
  const body = cases.map((c) => `
  test(${JSON.stringify(c.desc)}, async ({ page }) => {
    await gotoGame(page);
    const actual = await page.evaluate(() => window.__GAME__.counts().${c.check.metric});
    expect(actual).toBe(${JSON.stringify(c.check.value)});
  });`).join('\n');
  return `/* AUTO-GENERATED by pipeline.mjs — proposed by the vision LLM, verified against
 * ground truth. These run deterministically in CI with NO GPU. Do not hand-edit;
 * re-run \`node pipeline.mjs\` to regenerate. */
import { test, expect } from '@playwright/test';

async function gotoGame(page) {
  await page.goto('/');
  await page.waitForFunction(
    () => window.__GAME__ && window.__GAME__.counts().targets > 0,
    null, { timeout: 30_000 },
  );
}

test.describe('auto-generated verified scene-graph tests', () => {${body}
});
`;
}
fs.writeFileSync('tests/generated.spec.ts', genSpec(hardened));
log(`✅ Playwright spec written to tests/generated.spec.ts (run: npm run test:e2e)`);
await browser.close();
