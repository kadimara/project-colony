// Entity factories (enemies, colonists) and the generic actor-movement
// primitives shared by the player, enemies, and colonists. Placement uses
// state/state.ts's occupancy queries; nothing in state/ imports back from
// here (spawnEnemies is injected into state's createGameState/regenerateWorld
// as a callback instead) so there's no import cycle between the two.
import type { Actor, CasteKey, Colonist, Dir, Enemy, GameState, Point } from '../types/types';
import {
  COLONIST_MAX_HP, COLONIST_MOVE_DUR, COLONIST_WANDER_MAX_MS, COLONIST_WANDER_MIN_MS,
  ENEMY_COUNT, ENEMY_MAX_HP, ENEMY_MOVE_DUR, ENEMY_SPAWN_MIN_DIST, ENEMY_WANDER_MAX_MS,
  ENEMY_WANDER_MIN_MS, MAX_COLONISTS, SPAWN_X, SPAWN_Y, TILE,
} from '../constants';
import { randomOpenTile, randomOpenTileNear } from '../state/state';

function makeEnemy(x: number, y: number): Enemy {
  return {
    tileX: x, tileY: y, px: x * TILE, py: y * TILE,
    dir: 'down', moving: false, moveStart: 0, moveDur: ENEMY_MOVE_DUR,
    fromX: x, fromY: y, toX: x, toY: y,
    hp: ENEMY_MAX_HP, maxHp: ENEMY_MAX_HP,
    state: 'wander', target: null, path: [],
    nextWanderAt: performance.now() + ENEMY_WANDER_MIN_MS + Math.random() * (ENEMY_WANDER_MAX_MS - ENEMY_WANDER_MIN_MS),
    nextRepathAt: 0, lastAttack: 0, aggroUntil: 0, flashUntil: 0,
  };
}

export function spawnEnemies(state: GameState): void {
  state.enemies.length = 0;
  for (let i = 0; i < ENEMY_COUNT; i++) {
    let spot: Point | null = null;
    for (let tries = 0; tries < 30; tries++) {
      const s = randomOpenTile(state);
      if (!s) break;
      if (Math.hypot(s.x - SPAWN_X, s.y - SPAWN_Y) >= ENEMY_SPAWN_MIN_DIST) { spot = s; break; }
    }
    if (spot) state.enemies.push(makeEnemy(spot.x, spot.y));
  }
}

function makeColonist(caste: CasteKey, x: number, y: number): Colonist {
  return {
    caste, tileX: x, tileY: y, px: x * TILE, py: y * TILE,
    dir: 'down', moving: false, moveStart: 0, moveDur: COLONIST_MOVE_DUR[caste],
    fromX: x, fromY: y, toX: x, toY: y,
    hp: COLONIST_MAX_HP[caste], maxHp: COLONIST_MAX_HP[caste],
    path: [], carrying: null,
    workerState: 'atNest', scoutState: 'scouting', soldierState: 'patrolling',
    dropTarget: null, forageTarget: null, carryOrigin: null, alertTarget: null, aggroTarget: null,
    nextWanderAt: performance.now() + COLONIST_WANDER_MIN_MS + Math.random() * (COLONIST_WANDER_MAX_MS - COLONIST_WANDER_MIN_MS),
    nextRepathAt: 0, lastAttack: 0, aggroUntil: 0, flashUntil: 0, attacked: false,
    exploreTarget: null, scentActive: false, scentOrigin: null, scentType: null, digTile: null,
  };
}

export function spawnColonist(state: GameState, caste: CasteKey): void {
  if (state.colonists.length >= MAX_COLONISTS) return;
  const spot = randomOpenTileNear(state, state.nest.x, state.nest.y, 4) || randomOpenTile(state);
  if (spot) state.colonists.push(makeColonist(caste, spot.x, spot.y));
}

// ---- generic actor movement primitives (shared by player/enemy/colonist) ----
export function dirBetween(fromX: number, fromY: number, toX: number, toY: number): Dir {
  if (toX > fromX) return 'right';
  if (toX < fromX) return 'left';
  if (toY > fromY) return 'down';
  return 'up';
}

export function startStep(actor: Actor, nx: number, ny: number, dir: Dir): void {
  actor.dir = dir;
  actor.fromX = actor.tileX; actor.fromY = actor.tileY;
  actor.toX = nx; actor.toY = ny;
  actor.tileX = nx; actor.tileY = ny;
  actor.moving = true;
  actor.moveStart = performance.now();
}

export function updateActorAnimation(actor: Actor, now: number): void {
  if (!actor.moving) return;
  const t = Math.min(1, (now - actor.moveStart) / actor.moveDur);
  actor.px = (actor.fromX + (actor.toX - actor.fromX) * t) * TILE;
  actor.py = (actor.fromY + (actor.toY - actor.fromY) * t) * TILE;
  if (t >= 1) {
    actor.moving = false;
    actor.px = actor.toX * TILE; actor.py = actor.toY * TILE;
  }
}
