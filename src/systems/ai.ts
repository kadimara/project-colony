// Enemy + colonist AI: wander/chase/attack behavior, targeting, and nest
// production (spawning a new colonist once the player requests one).
import type { Colonist, Enemy, GameState, HudRefs, Point, Target } from '../types/types';
import {
  CASTES, COLONIST_AGGRO_RADIUS, COLONIST_ATK_COOLDOWN, COLONIST_ATK_DAMAGE, COLONIST_FORAGE_RADIUS,
  COLONIST_MOVE_DUR, COLONIST_REPATH_MS, COLONIST_WANDER_MAX_MS, COLONIST_WANDER_MIN_MS, COLONIST_WANDER_RADIUS,
  ENEMY_AGGRO_RADIUS, ENEMY_ATK_COOLDOWN, ENEMY_ATK_DAMAGE, ENEMY_LOSE_AGGRO_MS, ENEMY_REPATH_MS,
  ENEMY_WANDER_MAX_MS, ENEMY_WANDER_MIN_MS, ENEMY_WANDER_RADIUS, MAX_COLONISTS, NEST_FOOD_COST,
  NEST_INCUBATE_MS, SCOUT_DIG_MOVE_DUR, SCOUT_EXPLORE_MAX_DIST,
  SCOUT_EXPLORE_MIN_DIST,
} from '../constants';
import {
  effectiveNestFoodRadius, foodAt, isWall, nearestFoodTo, nestDistance, playerInNestRadius, randomOpenTileNear,
  scoutCost, setWall, spawnFloatingText, updateScent,
} from '../state/state';
import { dirBetween, spawnColonist, startStep, updateActorAnimation } from '../entities/entities';
import { bfsToAdjacent, findPath, findWeightedPath, hasLineOfSight, isAdjacent, type Walkable } from './pathfinding';
import { damageColonist, damagePlayer, killEnemy } from './combat';
import { showToast, updateHud } from '../ui/hud';
import { updateWorker } from './worker-ai';

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

// ---- colonist AI: workers forage food back toward the nest (their own
// forage radius, or a food source they've noticed via a scent trail),
// soldiers fight nearby enemies, scouts roam far afield, get pulled toward
// any food that comes within forage radius, then commit to a straight shot
// back to the nest laying scent the whole way once they find it — unlike a
// player-controlled scout, which gets the same scent on/off toggle but is
// never auto-piloted; the player keeps walking manually the whole time ----
function attemptColonistAttack(state: GameState, hud: HudRefs, colonist: Colonist, now: number): void {
  const t = colonist.aggroTarget;
  if (!t || t.hp <= 0) return;
  if (now - colonist.lastAttack < COLONIST_ATK_COOLDOWN) return;
  colonist.lastAttack = now;
  colonist.flashUntil = now + 140;
  t.hp -= COLONIST_ATK_DAMAGE;
  t.flashUntil = now + 140;
  spawnFloatingText(state, { px: t.px, py: t.py }, '-' + COLONIST_ATK_DAMAGE, '#e8a838');
  if (t.hp <= 0) { t.hp = 0; killEnemy(state, hud, t); colonist.aggroTarget = null; }
}

function nearestEnemyTo(state: GameState, x: number, y: number, radius: number): Enemy | null {
  let best: Enemy | null = null, bestDist = Infinity;
  for (const en of state.enemies) {
    if (en.hp <= 0) continue;
    const d = Math.hypot(en.tileX - x, en.tileY - y);
    if (d <= radius && d < bestDist) { best = en; bestDist = d; }
  }
  return best;
}

// picks a random far-off point to roam toward, in a random direction and
// distance band, and returns a path to it (or null if nothing panned out) —
// the path may tunnel through walls, but the target itself must be real
// open ground
function pickExploreTarget(state: GameState, colonist: Colonist, walkable: Walkable): { target: Point; path: Point[] } | null {
  for (let tries = 0; tries < 10; tries++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = SCOUT_EXPLORE_MIN_DIST + Math.random() * (SCOUT_EXPLORE_MAX_DIST - SCOUT_EXPLORE_MIN_DIST);
    const tx = Math.round(colonist.tileX + Math.cos(angle) * dist);
    const ty = Math.round(colonist.tileY + Math.sin(angle) * dist);
    if (!walkable(tx, ty)) continue;
    const path = findWeightedPath(colonist.tileX, colonist.tileY, tx, ty, (x, y) => scoutCost(state, x, y));
    if (path.length) return { target: { x: tx, y: ty }, path };
  }
  return null;
}

export function updateColonist(state: GameState, hud: HudRefs, colonist: Colonist, now: number, walkable: Walkable): void {
  if (colonist.hp <= 0) return;
  if (colonist.moving) { updateActorAnimation(colonist, now); return; }

  if (colonist.caste === 'soldier') {
    if (colonist.aggroTarget && colonist.aggroTarget.hp <= 0) colonist.aggroTarget = null;
    if (!colonist.aggroTarget) colonist.aggroTarget = nearestEnemyTo(state, colonist.tileX, colonist.tileY, COLONIST_AGGRO_RADIUS);
    if (colonist.aggroTarget) {
      const t = colonist.aggroTarget;
      if (isAdjacent(colonist.tileX, colonist.tileY, t.tileX, t.tileY)) {
        colonist.dir = dirBetween(colonist.tileX, colonist.tileY, t.tileX, t.tileY);
        attemptColonistAttack(state, hud, colonist, now);
        return;
      }
      if (now >= colonist.nextRepathAt || colonist.path.length === 0) {
        colonist.path = bfsToAdjacent(colonist.tileX, colonist.tileY, t.tileX, t.tileY, walkable);
        colonist.nextRepathAt = now + COLONIST_REPATH_MS;
      }
      if (colonist.path.length) {
        const next = colonist.path.shift()!;
        if (walkable(next.x, next.y)) startStep(colonist, next.x, next.y, dirBetween(colonist.tileX, colonist.tileY, next.x, next.y));
        else colonist.path = [];
      }
      return;
    }
  }

  if (colonist.caste === 'worker') {
    if (updateWorker(state, hud, colonist, now, walkable)) return;
    // job === 'wander' falls through to the shared wander block below
  }

  if (colonist.caste === 'scout') {
    // standing on a dug tile means it's about to move on — put the wall
    // block back down now that it's leaving
    if (colonist.digTile) {
      setWall(state, colonist.digTile.x, colonist.digTile.y, true);
      colonist.digTile = null;
    }

    updateScent(state, colonist, now);

    if (colonist.scentActive) {
      // returning to the nest, laying scent the whole way — ignore food until home
      colonist.forageTarget = null;
      if (colonist.path.length === 0) {
        const spot = randomOpenTileNear(state, state.nest.x, state.nest.y, effectiveNestFoodRadius(state) - 1);
        const path = spot ? findWeightedPath(colonist.tileX, colonist.tileY, spot.x, spot.y, (x, y) => scoutCost(state, x, y)) : [];
        if (path.length) { colonist.exploreTarget = spot; colonist.path = path; }
      }
    } else {
      // roam: pulled toward nearby food, else random explore
      if (colonist.forageTarget && (!foodAt(state, colonist.forageTarget.x, colonist.forageTarget.y) || colonist.path.length === 0)) {
        colonist.forageTarget = null;
      }
      if (!colonist.forageTarget) {
        const pull = nearestFoodTo(state, colonist.tileX, colonist.tileY, COLONIST_FORAGE_RADIUS, true);
        if (pull) {
          const path = findWeightedPath(colonist.tileX, colonist.tileY, pull.x, pull.y, (x, y) => scoutCost(state, x, y));
          if (path.length) { colonist.forageTarget = pull; colonist.exploreTarget = pull; colonist.path = path; }
        }
      }
      if (!colonist.forageTarget && colonist.path.length === 0) {
        const found = pickExploreTarget(state, colonist, walkable);
        if (found) { colonist.exploreTarget = found.target; colonist.path = found.path; }
      }
    }
    if (colonist.path.length) {
      const next = colonist.path.shift()!;
      const dir = dirBetween(colonist.tileX, colonist.tileY, next.x, next.y);
      if (walkable(next.x, next.y)) {
        colonist.moveDur = COLONIST_MOVE_DUR.scout;
        startStep(colonist, next.x, next.y, dir);
      } else if (isWall(state, next.x, next.y)) {
        setWall(state, next.x, next.y, false);
        colonist.digTile = { x: next.x, y: next.y };
        colonist.moveDur = SCOUT_DIG_MOVE_DUR;
        startStep(colonist, next.x, next.y, dir);
      } else {
        colonist.path = []; colonist.exploreTarget = null;
      }
    }
    return;
  }

  // wander (fallback for workers/soldiers when there's nothing to do)
  if (now >= colonist.nextWanderAt && colonist.path.length === 0) {
    const tx = colonist.tileX + Math.floor(Math.random() * (COLONIST_WANDER_RADIUS * 2 + 1)) - COLONIST_WANDER_RADIUS;
    const ty = colonist.tileY + Math.floor(Math.random() * (COLONIST_WANDER_RADIUS * 2 + 1)) - COLONIST_WANDER_RADIUS;
    if (walkable(tx, ty)) {
      const p = findPath(colonist.tileX, colonist.tileY, tx, ty, walkable);
      if (p.length) colonist.path = p;
    }
    colonist.nextWanderAt = now + COLONIST_WANDER_MIN_MS + Math.random() * (COLONIST_WANDER_MAX_MS - COLONIST_WANDER_MIN_MS);
  }
  if (colonist.path.length) {
    const next = colonist.path.shift()!;
    if (walkable(next.x, next.y)) startStep(colonist, next.x, next.y, dirBetween(colonist.tileX, colonist.tileY, next.x, next.y));
    else colonist.path = [];
  }
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
