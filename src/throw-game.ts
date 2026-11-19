/**
 * Grab & Throw station.
 *
 * Builds a pedestal (a "table") in the scene and stocks it with grabbable balls.
 * This is the Grab-station pattern from the starter, extended with a tiny custom
 * physics system so releasing a ball actually throws it.
 *
 * How the pieces fit together (the lesson):
 *  - `RayInteractable` makes each ball targetable by the pointer ray.
 *  - `DistanceGrabbable` (MoveTowardsTarget) is what IWSDK's GrabSystem reads to
 *    pull the ball to your hand while you hold the trigger/pinch. We don't write
 *    the grab logic — we declare the component.
 *  - `Grabbed` is a transient tag the GrabSystem adds/removes. We only READ it.
 *  - We measure the ball's velocity while it's held, and on release we integrate
 *    gravity ourselves (the project was scaffolded with physics off) so the ball
 *    flies, bounces, settles, and then restocks onto the pedestal.
 */
import {
  createSystem,
  DistanceGrabbable,
  Grabbed,
  MovementMode,
  RayInteractable,
  Vector3,
  type Entity,
} from '@iwsdk/core';
import * as THREE from 'three';
import { Ball } from './ball-component.js';

const BALL_COUNT = 3;
const BALL_RADIUS = 0.11;
const GRAVITY = 9.8; // m/s^2
const RESTITUTION = 0.45; // bounciness
const GROUND_FRICTION = 0.7; // horizontal damping per bounce
const SETTLE_SPEED = 0.35; // m/s below which a grounded ball stops
const THROW_BOOST = 1.6; // amplify the measured release velocity a little
const MAX_THROW_SPEED = 12; // clamp so a fast flick can't launch to infinity
const RESPAWN_DELAY_MS = 1400;
const FLOOR_Y = 0;

// Pedestal placement — a new "table" in the open foreground, front-and-center
// so it's unmistakable in the default view, clear of the Grab/Select/Spin arc.
const PEDESTAL = { x: -0.4, z: -1.3, topY: 0.95 };

const BALL_COLORS = [0xff7a1a, 0x1ad1ff, 0xffe14d];

interface BallState {
  vel: Vector3;
  prev: Vector3;
  thrown: boolean;
  wasGrabbed: boolean;
  respawnAt: number; // 0 = not scheduled
}

export class ThrowSystem extends createSystem({
  balls: { required: [Ball] },
  grabbed: { required: [Ball, Grabbed] },
}) {
  private state = new Map<object, BallState>();
  private tmp = new Vector3();

  init(): void {
    this.buildPedestal();
    for (let i = 0; i < BALL_COUNT; i++) {
      this.spawnBall(i);
    }
  }

  update(delta: number, _time: number): void {
    // Guard against pathological frame times (tab refocus, breakpoints).
    const dt = Math.min(delta, 1 / 30);
    if (dt <= 0) return;
    const now = performance.now();

    for (const entity of this.queries.balls.entities) {
      const obj = entity.object3D;
      if (!obj) continue;
      const s = this.state.get(entity as unknown as object);
      if (!s) continue;

      const isGrabbed = entity.hasComponent(Grabbed);

      if (isGrabbed) {
        // GrabSystem owns the position while held. We just measure velocity
        // from how far the ball moved since last frame.
        this.tmp.copy(obj.position).sub(s.prev).divideScalar(dt);
        s.vel.lerp(this.tmp, 0.6); // smooth out jitter
        s.thrown = false;
        s.respawnAt = 0;
      } else {
        if (s.wasGrabbed) {
          // Just released → launch it.
          s.vel.multiplyScalar(THROW_BOOST);
          if (s.vel.length() > MAX_THROW_SPEED) {
            s.vel.setLength(MAX_THROW_SPEED);
          }
          s.thrown = true;
        }

        if (s.thrown) {
          s.vel.y -= GRAVITY * dt;
          obj.position.x += s.vel.x * dt;
          obj.position.y += s.vel.y * dt;
          obj.position.z += s.vel.z * dt;

          // Floor collision.
          if (obj.position.y <= FLOOR_Y + BALL_RADIUS) {
            obj.position.y = FLOOR_Y + BALL_RADIUS;
            if (s.vel.length() < SETTLE_SPEED) {
              // Came to rest on the floor — settle and schedule a restock.
              s.vel.set(0, 0, 0);
              s.thrown = false;
              s.respawnAt = now + RESPAWN_DELAY_MS;
            } else {
              s.vel.y = -s.vel.y * RESTITUTION;
              s.vel.x *= GROUND_FRICTION;
              s.vel.z *= GROUND_FRICTION;
            }
          }

          // Flew out of bounds → restock sooner.
          if (
            Math.abs(obj.position.x) > 8 ||
            Math.abs(obj.position.z) > 8 ||
            obj.position.y > 6
          ) {
            s.vel.set(0, 0, 0);
            s.thrown = false;
            s.respawnAt = now + RESPAWN_DELAY_MS;
          }
        }

        // Restock back onto the pedestal.
        if (s.respawnAt !== 0 && now >= s.respawnAt) {
          this.resetBallToHome(entity, obj, s);
        }
      }

      s.wasGrabbed = isGrabbed;
      s.prev.copy(obj.position);
    }
  }

  private resetBallToHome(
    entity: Entity,
    obj: THREE.Object3D,
    s: BallState,
  ): void {
    const hx = entity.getValue(Ball, 'homeX') as number;
    const hy = entity.getValue(Ball, 'homeY') as number;
    const hz = entity.getValue(Ball, 'homeZ') as number;
    obj.position.set(hx, hy, hz);
    s.vel.set(0, 0, 0);
    s.thrown = false;
    s.respawnAt = 0;
    s.prev.copy(obj.position);
  }

  private spawnBall(index: number): void {
    const color = BALL_COLORS[index % BALL_COLORS.length];
    const geometry = new THREE.SphereGeometry(BALL_RADIUS, 20, 16);
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.4,
      metalness: 0.15,
      emissive: color,
      emissiveIntensity: 0.12,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'ball'; // test hook: scene-graph assertions count these
    mesh.castShadow = true;

    // Line the balls up along the pedestal top.
    const spread = (index - (BALL_COUNT - 1) / 2) * (BALL_RADIUS * 2.6);
    const home = new Vector3(
      PEDESTAL.x + spread,
      PEDESTAL.topY + BALL_RADIUS,
      PEDESTAL.z,
    );

    const entity = this.world.createTransformEntity(mesh);
    entity.object3D!.position.copy(home);
    entity.addComponent(Ball, { homeX: home.x, homeY: home.y, homeZ: home.z });
    entity.addComponent(RayInteractable);
    // The grab behavior: pull the ball to the hand while the trigger is held.
    entity.addComponent(DistanceGrabbable, {
      movementMode: MovementMode.MoveTowardsTarget,
      returnToOrigin: false,
      moveSpeedFactor: 1,
    });

    this.state.set(entity as unknown as object, {
      vel: new Vector3(),
      prev: home.clone(),
      thrown: false,
      wasGrabbed: false,
      respawnAt: 0,
    });
  }

  private buildPedestal(): void {
    const group = new THREE.Group();

    const topColor = 0xd9d4cc;
    const standColor = 0xb9b3a8;

    const stand = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.08, PEDESTAL.topY - 0.03, 16),
      new THREE.MeshStandardMaterial({ color: standColor, roughness: 0.8 }),
    );
    stand.position.y = (PEDESTAL.topY - 0.03) / 2;
    stand.castShadow = true;
    group.add(stand);

    const top = new THREE.Mesh(
      new THREE.CylinderGeometry(0.36, 0.36, 0.05, 24),
      new THREE.MeshStandardMaterial({ color: topColor, roughness: 0.7 }),
    );
    top.position.y = PEDESTAL.topY - 0.02;
    top.castShadow = true;
    top.receiveShadow = true;
    group.add(top);

    group.position.set(PEDESTAL.x, 0, PEDESTAL.z);
    // Non-interactive decor — no components, just a visual in the scene.
    this.world.createTransformEntity(group);
  }
}
