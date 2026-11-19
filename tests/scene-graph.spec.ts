import { test, expect, type Page } from '@playwright/test';

/**
 * Scene-graph assertions — the DETERMINISTIC half of UGC testing.
 *
 * Instead of diffing pixels (flaky for a 3D scene), we assert on the actual
 * state of the world: how many game objects exist, and what the HUD says.
 * The app exposes `window.__GAME__.counts()` as a test hook (see src/index.ts).
 *
 * This is the pattern that scales to user-generated content: you can't eyeball
 * every user's scene, but you CAN assert invariants ("exactly N targets spawn",
 * "score starts at 0", "no orphaned objects").
 */

// Narrow typing for the test hook the app installs on window.
type GameCounts = { targets: number; balls: number; score: number | null };
declare global {
  interface Window {
    __GAME__?: { counts(): GameCounts };
  }
}

async function waitForGame(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('#score-hud', { timeout: 30_000 });
  // World.create is async; wait until the ECS world has spawned entities.
  await page.waitForFunction(
    () => !!window.__GAME__ && window.__GAME__.counts().targets > 0,
    null,
    { timeout: 30_000 },
  );
}

test.describe('scene-graph assertions (deterministic)', () => {
  test('spawns exactly the expected game objects', async ({ page }) => {
    await waitForGame(page);
    const counts = await page.evaluate(() => window.__GAME__!.counts());
    expect(counts.targets).toBe(6); // TargetGameSystem spawns TARGET_COUNT
    expect(counts.balls).toBe(3); // ThrowSystem spawns BALL_COUNT
  });

  test('score starts at zero and the HUD is visible', async ({ page }) => {
    await waitForGame(page);
    const hud = page.locator('#score-hud');
    await expect(hud).toBeVisible();
    await expect(hud).toContainText('Score: 0');
    const { score } = await page.evaluate(() => window.__GAME__!.counts());
    expect(score).toBe(0);
  });

  test('object count stays stable while targets bob/respawn', async ({ page }) => {
    await waitForGame(page);
    const before = await page.evaluate(() => window.__GAME__!.counts());
    await page.waitForTimeout(1500); // let the bob/rotate update loop run
    const after = await page.evaluate(() => window.__GAME__!.counts());
    // Targets animate but are never leaked or duplicated.
    expect(after.targets).toBe(before.targets);
    expect(after.balls).toBe(before.balls);
  });
});
