// Enemy + colonist AI: wander/chase/attack behavior for enemies, dispatch to
// the per-caste colonist FSMs (worker-ai.ts/scout-ai.ts/soldier-ai.ts), and
// nest production (spawning a new colonist once the player requests one).
import type { Colonist, Enemy, GameState, HudRefs, Target } from '../types/types';
import {
  CASTES, ENEMY_AGGRO_RADIUS, ENEMY_ATK_COOLDOWN, ENEMY_ATK_DAMAGE, ENEMY_LOSE_AGGRO_MS, ENEMY_REPATH_MS,
  ENEMY_WANDER_MAX_MS, ENEMY_WANDER_MIN_MS, ENEMY_WANDER_RADIUS, MAX_COLONISTS, NEST_FOOD_COST,
  NEST_INCUBATE_MS,
} from '../constants';
import { effectiveNestFoodRadius, isWall, nestDistance, playerInNestRadius } from '../state/state';
import { dirBetween, spawnColonist, startStep, updateActorAnimation } from '../entities/entities';
import { bfsToAdjacent, findPath, hasLineOfSight, isAdjacent, type Walkable } from './pathfinding';
import { damageColonist, damagePlayer } from './combat';
import { showToast, updateHud } from '../ui/hud';
import { updateWorker } from './worker-ai';
import { updateScout } from './scout-ai';
import { updateSoldier } from './soldier-ai';

function targetPos(target: Target) {
  return { x: target.ref.tileX, y: target.ref.tileY };
}

function targetAlive(target: Target): boolean {
  if (target.kind === 'player') return target.ref.hp > 0 && target.ref.caste !== null;
  return target.ref.hp > 0;
}

// finds the nearest valid target (player or a living colonist) within
// aggro range and line of sight — enemies aren't picky about who they bite
function findNearestTarget(state: GameState, fromX: number, fromY: number, radius: number): Target | null {
  const losCheck = (tx: number, ty: number) => hasLineOfSight(fromX, fromY, tx, ty, (x, y) => isWall(state, x, y));
  let best: Target | null = null, bestDist = Infinity;
  const { player } = state;
  if (player.caste && player.hp > 0) {
    const d = Math.hypot(player.tileX - fromX, player.tileY - fromY);
    if (d <= radius && losCheck(player.tileX, player.tileY)) {
      best = { kind: 'player', ref: player }; bestDist = d;
    }
  }
  for (const c of state.colonists) {
    if (c.hp <= 0) continue;
    const d = Math.hypot(c.tileX - fromX, c.tileY - fromY);
    if (d <= radius && d < bestDist && losCheck(c.tileX, c.tileY)) {
      best = { kind: 'colonist', ref: c }; bestDist = d;
    }
  }
  return best;
}

function attemptEnemyAttack(state: GameState, hud: HudRefs, enemy: Enemy, target: Target, now: number): void {
  if (now - enemy.lastAttack < ENEMY_ATK_COOLDOWN) return;
  enemy.lastAttack = now;
  enemy.flashUntil = now + 140;
  if (target.kind === 'player') damagePlayer(state, hud, ENEMY_ATK_DAMAGE, now);
  else damageColonist(state, hud, target.ref, ENEMY_ATK_DAMAGE, now);
}

// ---- enemy AI: wander, then chase + attack on sight ----
export function updateEnemy(state: GameState, hud: HudRefs, enemy: Enemy, now: number, walkable: Walkable): void {
  if (enemy.hp <= 0) return;
  if (enemy.moving) { updateActorAnimation(enemy, now); return; }

  if (enemy.target && !targetAlive(enemy.target)) enemy.target = null;
  const sighted = findNearestTarget(state, enemy.tileX, enemy.tileY, ENEMY_AGGRO_RADIUS);
  if (sighted) {
    enemy.target = sighted;
    enemy.state = 'chase';
    enemy.aggroUntil = now + ENEMY_LOSE_AGGRO_MS;
  } else if (enemy.state === 'chase' && now > enemy.aggroUntil) {
    enemy.state = 'wander';
    enemy.target = null;
    enemy.path = [];
    enemy.nextWanderAt = now + 300;
  }

  if (enemy.state === 'chase' && enemy.target) {
    const pos = targetPos(enemy.target);
    if (isAdjacent(enemy.tileX, enemy.tileY, pos.x, pos.y)) {
      enemy.dir = dirBetween(enemy.tileX, enemy.tileY, pos.x, pos.y);
      attemptEnemyAttack(state, hud, enemy, enemy.target, now);
      return;
    }
    if (now >= enemy.nextRepathAt || enemy.path.length === 0) {
      enemy.path = bfsToAdjacent(enemy.tileX, enemy.tileY, pos.x, pos.y, walkable);
      enemy.nextRepathAt = now + ENEMY_REPATH_MS;
    }
    if (enemy.path.length) {
      const next = enemy.path.shift()!;
      if (walkable(next.x, next.y)) startStep(enemy, next.x, next.y, dirBetween(enemy.tileX, enemy.tileY, next.x, next.y));
      else enemy.path = [];
    }
    return;
  }

  // wander: occasionally pick a nearby spot and walk to it
  if (now >= enemy.nextWanderAt && enemy.path.length === 0) {
    const tx = enemy.tileX + Math.floor(Math.random() * (ENEMY_WANDER_RADIUS * 2 + 1)) - ENEMY_WANDER_RADIUS;
    const ty = enemy.tileY + Math.floor(Math.random() * (ENEMY_WANDER_RADIUS * 2 + 1)) - ENEMY_WANDER_RADIUS;
    if (walkable(tx, ty)) {
      const p = findPath(enemy.tileX, enemy.tileY, tx, ty, walkable);
      if (p.length) enemy.path = p;
    }
    enemy.nextWanderAt = now + ENEMY_WANDER_MIN_MS + Math.random() * (ENEMY_WANDER_MAX_MS - ENEMY_WANDER_MIN_MS);
  }
  if (enemy.path.length) {
    const next = enemy.path.shift()!;
    if (walkable(next.x, next.y)) startStep(enemy, next.x, next.y, dirBetween(enemy.tileX, enemy.tileY, next.x, next.y));
    else enemy.path = [];
  }
}

// ---- colonist AI: dispatch by caste to the per-caste FSM ----
export function updateColonist(state: GameState, hud: HudRefs, colonist: Colonist, now: number, walkable: Walkable): void {
  if (colonist.hp <= 0) return;
  if (colonist.moving) { updateActorAnimation(colonist, now); return; }

  if (colonist.caste === 'soldier') { updateSoldier(state, hud, colonist, now, walkable); return; }
  if (colonist.caste === 'worker') { updateWorker(state, hud, colonist, now, walkable); return; }
  updateScout(state, hud, colonist, now, walkable); // only 'scout' remains
}

// ---- nest: spawning only happens when the player explicitly requests it
// (via the nest overlay). updateNest() just resolves an in-progress one. ----
export function startNestSpawn(state: GameState, hud: HudRefs, casteKey: Colonist['caste']): boolean {
  const { nest } = state;
  if (nest.incubating) return false;
  if (!playerInNestRadius(state)) { showToast(hud, 'Stand within the nest\'s food circle to spawn an ant'); return false; }
  if (state.colonists.length >= MAX_COLONISTS) { showToast(hud, 'Colony is at full population'); return false; }
  const nearbyIdx: number[] = [];
  for (let i = 0; i < state.foodItems.length; i++) {
    if (nestDistance(state, state.foodItems[i].x, state.foodItems[i].y) <= effectiveNestFoodRadius(state)) nearbyIdx.push(i);
  }
  if (nearbyIdx.length < NEST_FOOD_COST) { showToast(hud, 'Not enough food near the nest'); return false; }
  for (const idx of nearbyIdx.slice(0, NEST_FOOD_COST).sort((a, b) => b - a)) state.foodItems.splice(idx, 1);
  nest.incubating = true;
  nest.incubateStart = performance.now();
  nest.pendingCaste = casteKey;
  showToast(hud, 'Nest producing a ' + CASTES[casteKey].name.toLowerCase());
  return true;
}

export function updateNest(state: GameState, hud: HudRefs, now: number): void {
  const { nest } = state;
  if (!nest.incubating) return;
  if (now - nest.incubateStart >= NEST_INCUBATE_MS) {
    nest.incubating = false;
    spawnColonist(state, nest.pendingCaste!);
    nest.pendingCaste = null;
    updateHud(state, hud);
  }
}
