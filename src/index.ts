/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { PanelSystem } from './panel.js';
import { RobotSystem } from './robot.js';
import { TargetGameSystem } from './target-game.js';
import { ThrowSystem } from './throw-game.js';
import { initHud } from './hud.js';

initHud();

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  world.registerSystem(RobotSystem);
  world.registerSystem(PanelSystem);
  world.registerSystem(TargetGameSystem);
  world.registerSystem(ThrowSystem);

  // Test hook (used by Playwright scene-graph assertions). Exposes a deterministic
  // snapshot of game state without reaching into ECS internals.
  (window as unknown as { __GAME__?: unknown }).__GAME__ = {
    world,
    counts() {
      let targets = 0;
      let balls = 0;
      world.scene.traverse((o) => {
        if (o.name === 'target') targets++;
        else if (o.name === 'ball') balls++;
      });
      const hud = document.getElementById('score-hud');
      const m = hud?.textContent?.match(/Score:\s*(\d+)/);
      return { targets, balls, score: m ? Number(m[1]) : null };
    },
  };
});
