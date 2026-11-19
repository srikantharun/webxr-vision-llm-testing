# WebXR game + AI-assisted test pipeline

A small **WebXR / Three.js game** (Immersive Web SDK) plus a **self-hosted vision-LLM test-generation pipeline**: a vision model *looks at* the running game and proposes test cases, a **deterministic oracle verifies** them, and only verified tests are codegen'd into Playwright CI (which runs with **no GPU**).

The vision model is served on an **AMD Instinct MI300X** with **vLLM** (OpenAI-compatible), so screenshots never leave your infrastructure.

```
capture (Playwright screenshot + scene-graph truth)
  → feedback (vision LLM proposes JSON test candidates)   [GPU]
  → verify (checked against ground truth)
  → continue (failures → bug vs hallucination; passes promoted)  [GPU]
  → codegen → tests/generated.spec.ts  (deterministic, GPU-free CI)
```

## Quick start

```bash
npm install
npm run dev:runtime     # game at https://localhost:8081/ (self-signed)

# deterministic tests (no GPU)
npm i -D @playwright/test && npx playwright install chromium
npm run test:e2e

# generation pipeline (needs an OpenAI-compatible VLM endpoint)
npm i -D playwright openai
export VLLM_URL=http://<host>:8001/v1 VLLM_API_KEY=<key> SERVED_NAME=qwen2.5-vl
node pipeline.mjs       # → verified-tests.json + tests/generated.spec.ts
```

## Full documentation

See **[TECHNICAL_SPEC.md](./TECHNICAL_SPEC.md)** for the architecture, the game's ECS systems, the pipeline design, how to serve the model on an MI300X (including the Llama 3.2 Vision / `mllama` caveat and the Qwen2.5-VL pivot), measured GPU performance, the GPU-usage strategy, and the TypeScript/LLM engineering notes.

## Key idea

**The LLM proposes, a deterministic oracle disposes.** The model generates coverage; ground truth decides what's real. That's the only thing that scales to UGC / AR-VR, where you can't hand-write a test per scene.
