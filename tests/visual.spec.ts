import { test, expect, type Page } from '@playwright/test';

/**
 * Visual-regression — the PIXEL-DIFF half of UGC testing.
 *
 * Important lesson: a full-frame pixel diff of a 3D scene is FLAKY here, because
 * targets spawn at random positions and bob/rotate every frame. So:
 *
 *  1. We snapshot the STABLE UI chrome (the score HUD) deterministically. This
 *     catches regressions in the 2D overlay reliably.
 *  2. For the 3D canvas itself, see the commented test below + TESTING.md: you
 *     make rendering deterministic first (seed Math.random, freeze the update
 *     loop via a `?test=1` mode), THEN pixel-diff. Don't diff a live, random scene.
 *
 * First run: `npm run test:e2e:update` generates the baseline PNGs. Commit them.
 * Later runs compare against the baseline and fail on visual drift.
 */

async function waitForGame(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('#score-hud', { timeout: 30_000 });
  await page.waitForFunction(
    () => !!(window as unknown as { __GAME__?: unknown }).__GAME__,
    null,
    { timeout: 30_000 },
  );
}

test('score HUD renders consistently (deterministic region)', async ({ page }) => {
  await waitForGame(page);
  // Stable 2D overlay — safe to pixel-diff.
  await expect(page.locator('#score-hud')).toHaveScreenshot('score-hud.png');
});

/*
 * FULL-SCENE visual regression — enable once the app has a deterministic test mode.
 * The recipe (see TESTING.md):
 *   - On `?test=1`: seed Math.random with a fixed value, disable the per-frame
 *     bob/rotate, and spawn targets at fixed positions.
 *   - Then the whole canvas is reproducible and safe to diff:
 *
 * test('full scene renders consistently', async ({ page }) => {
 *   await page.goto('/?test=1');
 *   await page.waitForFunction(() => (window as any).__GAME__);
 *   await page.waitForTimeout(500); // let one deterministic frame settle
 *   await expect(page).toHaveScreenshot('full-scene.png', { maxDiffPixelRatio: 0.01 });
 * });
 */
