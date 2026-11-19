# Technical Specification — AI-Assisted Testing for a WebXR Game on AMD GPUs

**A self-hosted vision-LLM test-generation pipeline for a WebXR/Three.js game, verified by a deterministic oracle and codegen'd into Playwright CI.**

- **Status:** working reference implementation
- **Hardware used:** AMD Instinct MI300X (192 GB) on AMD Developer Cloud
- **Last updated:** 2026-11-19

---

## 1. Overview

This project demonstrates a scalable pattern for testing graphical / user-generated-content (UGC) applications: **a vision-language model (VLM) proposes test cases by *looking at* the running app; a deterministic oracle verifies them; only verified tests are promoted to CI.** The VLM is self-hosted on an AMD GPU via vLLM, so screenshots never leave your infrastructure.

The subject under test is a small **WebXR game** (Immersive Web SDK + Three.js): floating targets you click to score, three interaction stations (Grab / Select / Spin), and a grab-and-throw mechanic.

### Why this exists

Hand-writing a test per scene does not scale for games or UGC — users generate the content. The only thing that scales is **generation + verification**: let a model propose coverage per scene, and keep only what a deterministic oracle confirms.

---

## 2. Architecture

Four layers, connected by typed contracts:

```
Frontend (React·Vite·TS·Tailwind·TanStack)
   ⇄  Backend (Hono · REST · OpenAPI/Zod)        ← holds the model API key (trust boundary)
        ⇄  AI layer (vLLM · ROCm · MI300X)        ← OpenAI-compatible vision endpoint
             ⇄  Testing (Playwright · scene-graph oracle)
```

| Layer | Tech | Responsibility |
|---|---|---|
| Frontend | React, Vite, TypeScript, Tailwind, TanStack Query/Router | Renders the game (WebGL) + a test dashboard; streams LLM output via SSE |
| Backend | Hono, REST, OpenAPI (via `@hono/zod-openapi`) | Typed endpoints; the only component that holds the vLLM API key |
| AI | vLLM on ROCm, Qwen2.5-VL-7B-Instruct | Self-hosted, OpenAI-compatible vision inference |
| Testing | Playwright, scene-graph hook, (optional) JUnit/Testcontainers | Capture, verify, run generated tests |

> This repository contains the **game + the testing pipeline** (frontend + testing layers, plus the pipeline that talks to the AI layer). The backend (Hono) and model serving are documented here as integration points.

---

## 3. The game (subject under test)

Built with **IWSDK** (Immersive Web SDK) on an Entity-Component-System (ECS) architecture over Three.js.

- `src/target-game.ts` — `TargetGameSystem`: spawns 6 glowing targets (`RayInteractable`); clicking one (`Pressed`) scores +10, disposes it, respawns. 220 ms hit cooldown (the `Pressed` tag re-fires per frame while held).
- `src/throw-game.ts` — `ThrowSystem`: a pedestal with 3 grabbable balls (`DistanceGrabbable`); a custom gravity/bounce integrator throws them on release (the project is scaffolded `--no-physics`).
- `src/hud.ts` — a DOM score overlay (`#score-hud`).
- `src/index.ts` — registers systems and installs the **test hook** (see §4.1).

### 3.1 The test hook (deterministic oracle)

The game exposes a minimal, deterministic snapshot of its state — this is the ground-truth oracle the VLM is checked against:

```ts
window.__GAME__ = {
  counts() {
    let targets = 0, balls = 0;
    world.scene.traverse(o => {
      if (o.name === 'target') targets++;
      else if (o.name === 'ball') balls++;
    });
    const m = document.getElementById('score-hud')?.textContent?.match(/Score:\s*(\d+)/);
    return { targets, balls, score: m ? Number(m[1]) : null };
  },
};
```

Meshes are tagged (`mesh.name = 'target' | 'ball'`) so a `scene.traverse` yields exact counts without reaching into ECS internals.

---

## 4. The testing pipeline — `capture → feedback → verify → continue`

Implemented in `pipeline.mjs` (Node, `playwright` + `openai`).

### Stage 1 — CAPTURE
Playwright loads the game, waits for the world to spawn, and grabs:
- a PNG screenshot, and
- ground-truth metrics via `page.evaluate(() => window.__GAME__.counts())`.

### Stage 2 — FEEDBACK (GPU)
The screenshot is sent to the self-hosted VLM with a prompt that demands **structured JSON** candidates:
```json
{ "id": "...", "type": "SCENE", "check": { "metric": "targets|balls|score", "op": "eq|gt|lt|…", "value": 6 } }
```
Structured output is what makes a suggestion *runnable* rather than prose.

### Stage 3 — VERIFY
Each candidate is checked against the ground truth with a small operator table (`eq/ne/gt/gte/lt/lte`) → `PASS | FAIL | INVALID` (unknown metric/op).

### Stage 4 — CONTINUE (GPU)
`FAIL`ing candidates are fed **back** to the model with the ground truth, which classifies each as `REAL_BUG` (the app is wrong) or `BAD_SUGGESTION` (the model's proposal was wrong). `PASS`ing candidates are promoted. The loop repeats until no new verified tests appear.

### Harden + codegen
- **Harden:** collapse loose bounds (`targets>5`, `>2`, …) into one **exact** assertion per metric (`targets===6`); dedup.
- **Codegen:** emit `tests/generated.spec.ts` — a Playwright spec that runs the verified tests deterministically, **with no GPU**.

> **Design invariant:** the generator is never its own only judge. A deterministic oracle decides pass/fail; the model only proposes and (separately) triages failures.

---

## 5. Serving the vision model (AI layer)

The pipeline expects an OpenAI-compatible endpoint (`VLLM_URL`, `VLLM_API_KEY`). To reproduce the self-hosted setup on an AMD MI300X:

```bash
docker run -d --name vllm-llama \
  --device=/dev/kfd --device=/dev/dri \
  --group-add "$(getent group video|cut -d: -f3)" \
  --group-add "$(getent group render|cut -d: -f3)" \
  --ipc=host --shm-size=16g -p 8001:8000 \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  vllm/vllm-openai-rocm:latest \
  --model Qwen/Qwen2.5-VL-7B-Instruct \
  --served-model-name qwen2.5-vl \
  --host 0.0.0.0 --port 8000 --api-key "$KEY" \
  --trust-remote-code --enforce-eager \
  --max-model-len 16384 --gpu-memory-utilization 0.90
```

### ⚠️ Known issue: Llama 3.2 Vision (`mllama`) does not load on current vLLM+ROCm

Across vLLM 0.11rc / 0.27.1 / 0.34.0 and transformers 4.56 / 5.15 / 5.22 it crashes with
`AttributeError: 'MllamaProcessor' object has no attribute '_get_num_multimodal_tokens'`.
Root cause: vLLM dropped native `MllamaForConditionalGeneration` (last present ~v0.6.6), so mllama falls back to the generic transformers multimodal backend, which calls a processor method `MllamaProcessor` never implements. **Pre-flight check before pulling a multi-GB image:**

```bash
docker run --rm --entrypoint python3 <image> -c \
 "from vllm.model_executor.models.registry import ModelRegistry as R; \
  print('native:', 'MllamaForConditionalGeneration' in R.get_supported_archs())"
```

Use a natively-supported VLM (Qwen2.5-VL) instead.

### Measured performance (MI300X, 1× GPU)

| Metric | Value |
|---|---|
| Latency / image request | 2.27 s (end-to-end) |
| Throughput | ~71 completion tok/s |
| Vision tokens / screenshot | ~1,593 |
| GPU utilization (idle → inference) | 0% → 100% |
| Power / VRAM | 233 W / ~173 GB of 192 |

---

## 6. How to run

### Prerequisites
- Node.js ≥ 20, npm
- (For generation) an OpenAI-compatible VLM endpoint — hosted or self-hosted per §5

### 6.1 Run the game
```bash
npm install
npm run dev:runtime          # Vite dev server → https://localhost:8081/ (self-signed)
```
Open `https://localhost:8081/` in Chrome. Click the glowing shapes to score; "Enter XR" opens the Immersive Web Emulator.

### 6.2 Run the deterministic tests (no GPU)
```bash
npm i -D @playwright/test && npx playwright install chromium
npm run test:e2e             # scene-graph + generated specs
```

### 6.3 Run the generation pipeline (needs the VLM)
```bash
npm i -D playwright openai
export VLLM_URL=http://<host>:8001/v1
export VLLM_API_KEY=<key>
export SERVED_NAME=qwen2.5-vl
node pipeline.mjs            # → verified-tests.json + tests/generated.spec.ts
```

---

## 7. GPU usage strategy

Spend the GPU only where it earns its place:

| Tier | What | GPU? | Cadence |
|---|---|---|---|
| 1 · Deterministic | Playwright / scene-graph — the real CI gate | No | every commit |
| 2 · Generate | VLM proposes coverage from screenshots | Yes | on UI/content change |
| 3 · Judge | VLM answers "does this look broken?" — the un-codifiable | Yes | sampled / selective |

At ~2.3 s + 100% GPU per image, do **not** run the VLM on every test on every commit. Let Tier 1 carry the volume.

---

## 8. Engineering notes

### TypeScript
- **Validate the model's JSON at runtime** (e.g. Zod). TS types are compile-time; LLM output is untrusted runtime data. `z.infer` gives the type *and* the guard from one schema.
- Model test candidates as a **discriminated union** on `type` and use a `never` exhaustiveness check so a new kind fails to compile until handled.
- ESM import gotcha: relative imports end in `.js` even for `.ts` sources.
- Type `window.__GAME__` via `declare global { interface Window { … } }`.

### LLM
- **Model ≠ engine ≠ vendor.** Verify native engine support before committing to a model.
- **LLM output is non-deterministic** — never trust a suggestion because it "looks right"; verify it.
- **Images are expensive input** (~1,600 tokens each); downsample when fidelity isn't needed.
- **Knowledge → RAG, behavior → fine-tune, actions → tools.** Don't retrain to inject facts.

---

## 9. File map

| Path | Purpose |
|---|---|
| `src/index.ts` | World setup, system registration, test hook |
| `src/target-game.ts` | Target spawn/score/respawn system |
| `src/throw-game.ts` | Grab-and-throw balls + custom physics |
| `src/hud.ts` | DOM score overlay |
| `pipeline.mjs` | capture→feedback→verify→continue generator |
| `verified-tests.json` | Hardened, verified test set (pipeline output) |
| `tests/generated.spec.ts` | Auto-generated Playwright spec (GPU-free) |
| `tests/scene-graph.spec.ts` | Hand-written deterministic assertions |
| `tests/visual.spec.ts` | Visual-regression (stable-region) |
| `playwright.config.ts` | WebGL + self-signed HTTPS test config |
