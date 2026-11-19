/**
 * Target shooting mini-game.
 *
 * Spawns a set of glowing shapes floating in front of the player. Clicking one
 * (mouse/touch on desktop, or the controller/hand ray + trigger in XR) pops it,
 * adds to the score, and spawns a fresh one somewhere else.
 *
 * Interaction model: `RayInteractable` makes an entity targetable by both the
 * canvas pointer and XR rays; the InputSystem then adds the transient `Pressed`
 * tag on a click/trigger. We watch for `Pressed` appearing on a `Target`.
 */
import { createSystem, Pressed, RayInteractable } from '@iwsdk/core';
import * as THREE from 'three';
import { Target } from './target-component.js';
import { setScore } from './hud.js';

const TARGET_COUNT = 6;

const PALETTE = [
  0xff4d6d, 0x4dd2ff, 0xffd166, 0x8aff80, 0xc08bff, 0xff9f45,
];

export class TargetGameSystem extends createSystem({
  targets: { required: [Target] },
  hits: { required: [Target, Pressed] },
}) {
  private score = 0;
  // The `Pressed` tag re-qualifies every frame while the button/trigger is
  // held, and a respawned target can land under a held pointer. Without a guard
  // one physical click racks up dozens of hits. This cooldown makes one press =
  // one pop (and caps rapid clicking to a sane rate).
  private nextHitAllowedAt = 0;
  private static readonly HIT_COOLDOWN_MS = 220;

  init(): void {
    for (let i = 0; i < TARGET_COUNT; i++) {
      this.spawnTarget();
    }

    // Fire once each time a Target gains the transient `Pressed` tag.
    this.queries.hits.subscribe('qualify', (entity) => {
      const now = performance.now();
      if (now < this.nextHitAllowedAt) {
        return;
      }
      this.nextHitAllowedAt = now + TargetGameSystem.HIT_COOLDOWN_MS;

      const points = (entity.getValue(Target, 'points') as number) ?? 10;
      this.score += points;
      setScore(this.score);

      // Pop: remove this target (unique geo/material -> safe to dispose) and
      // replace it so the game keeps going.
      entity.dispose();
      this.spawnTarget();
    });
  }

  update(delta: number, time: number): void {
    for (const entity of this.queries.targets.entities) {
      const obj = entity.object3D;
      if (!obj) continue;
      const phase = entity.getValue(Target, 'phase') as number;
      const baseY = entity.getValue(Target, 'baseY') as number;
      obj.position.y = baseY + Math.sin(time * 1.8 + phase) * 0.12;
      obj.rotation.y += delta * 0.8;
      obj.rotation.x += delta * 0.3;
    }
  }

  private spawnTarget(): void {
    const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    const geometry = new THREE.IcosahedronGeometry(0.17, 1);
    const material = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.6,
      roughness: 0.35,
      metalness: 0.1,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'target'; // test hook: scene-graph assertions count these

    const x = (Math.random() - 0.5) * 3.2;
    const y = 1.1 + Math.random() * 1.1;
    const z = -1.4 - Math.random() * 2.6;

    const entity = this.world.createTransformEntity(mesh);
    entity.object3D!.position.set(x, y, z);
    entity.addComponent(Target, {
      points: 10,
      phase: Math.random() * Math.PI * 2,
      baseY: y,
    });
    entity.addComponent(RayInteractable);
  }
}
