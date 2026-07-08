// Worker AI: a 5-state finite state machine. AtNest is idle/home base —
// a worker there either grabs wall material right next to it or heads out
// on a scent trail it detects. FollowingScent/CarryingFood/CarryingWall
// handle an errand to completion; an attack at any point during one drops
// whatever's held and reroutes home via ReturningToNest, laying an alarm
// trail the whole way (see the attack-interrupt check at the top of
// updateWorker). Workers are deliberately not autonomous foragers — they
// only ever act on a scent trail or on wall material immediately at hand.
import type { Colonist, GameState, HudRefs } from '../types/types';
import { COLONIST_FORAGE_RADIUS, WORKER_FRONTIER_SEARCH_RADIUS } from '../constants';
import {
  effectiveNestFoodRadius, findFrontierDropSite, foodAt, isWall, nearestFoodViaTrail,
  nestDistance, randomOpenTileNear, scoutCost, setWall, spawnFloatingText, triggerAlarm, updateScent,
} from '../state/state';
import { dirBetween, startStep } from '../entities/entities';
import { bfsToAdjacent, findPath, findWeightedPathToAdjacent, isAdjacent, type Walkable } from './pathfinding';

const NEST_NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

// stationed at the nest: grab any wall material immediately adjacent, or
// pick up a scent trail if one's in range; otherwise just wait
function runAtNest(state: GameState, colonist: Colonist, walkable: Walkable): void {
  const nearNest = nestDistance(state, colonist.tileX, colonist.tileY) <= effectiveNestFoodRadius(state);
  if (!nearNest) {
    if (colonist.path.length === 0) {
      const spot = randomOpenTileNear(state, state.nest.x, state.nest.y, effectiveNestFoodRadius(state) - 1);
      const p = spot ? findPath(colonist.tileX, colonist.tileY, spot.x, spot.y, walkable) : [];
      if (p.length) colonist.path = p;
    }
    if (colonist.path.length) {
      const next = colonist.path.shift()!;
      if (walkable(next.x, next.y)) startStep(colonist, next.x, next.y, dirBetween(colonist.tileX, colonist.tileY, next.x, next.y));
      else colonist.path = [];
    }
    return;
  }

  for (const [dx, dy] of NEST_NEIGHBORS) {
    const wx = colonist.tileX + dx, wy = colonist.tileY + dy;
    if (isWall(state, wx, wy)) {
      setWall(state, wx, wy, false);
      colonist.carrying = 'obstacle';
      colonist.carryOrigin = 'atNest';
      colonist.workerState = 'carryingWall';
      spawnFloatingText(state, colonist, 'dug through wall', '#b0aaa0');
      return;
    }
  }

  const trailFood = nearestFoodViaTrail(state, colonist.tileX, colonist.tileY, COLONIST_FORAGE_RADIUS);
  if (trailFood) {
    colonist.forageTarget = trailFood;
    colonist.workerState = 'followingScent';
  }
}

// following an active scent trail toward the food it reports, tunneling
// permanently through any wall tile in the way (unlike a scout's temporary dig)
function runFollowingScent(state: GameState, colonist: Colonist): void {
  const f = colonist.forageTarget!;
  if (isAdjacent(colonist.tileX, colonist.tileY, f.x, f.y)) {
    const idx = state.foodItems.findIndex((fi) => fi.x === f.x && fi.y === f.y);
    if (idx !== -1) { state.foodItems.splice(idx, 1); colonist.carrying = 'food'; }
    colonist.forageTarget = null;
    colonist.path = [];
    colonist.workerState = 'carryingFood';
    return;
  }
  if (colonist.path.length === 0) {
    colonist.path = findWeightedPathToAdjacent(colonist.tileX, colonist.tileY, f.x, f.y, (x, y) => scoutCost(state, x, y));
    if (colonist.path.length === 0) { colonist.forageTarget = null; colonist.workerState = 'atNest'; return; }
  }
  const next = colonist.path[0];
  if (isWall(state, next.x, next.y)) {
    setWall(state, next.x, next.y, false);
    colonist.carrying = 'obstacle';
    colonist.carryOrigin = 'followingScent';
    colonist.path = [];
    colonist.workerState = 'carryingWall';
    spawnFloatingText(state, colonist, 'dug through wall', '#b0aaa0');
    return;
  }
  colonist.path.shift();
  startStep(colonist, next.x, next.y, dirBetween(colonist.tileX, colonist.tileY, next.x, next.y));
}

// carrying food back to drop it within range of the nest
function runCarryingFood(state: GameState, colonist: Colonist, walkable: Walkable): void {
  const nearNest = nestDistance(state, colonist.tileX, colonist.tileY) <= effectiveNestFoodRadius(state);
  if (nearNest) {
    if (!foodAt(state, colonist.tileX, colonist.tileY)) state.foodItems.push({ x: colonist.tileX, y: colonist.tileY });
    colonist.carrying = null;
    colonist.path = [];
    colonist.workerState = 'atNest';
    return;
  }
  if (colonist.path.length === 0) {
    const spot = randomOpenTileNear(state, state.nest.x, state.nest.y, effectiveNestFoodRadius(state) - 1);
    const p = spot ? findPath(colonist.tileX, colonist.tileY, spot.x, spot.y, walkable) : [];
    if (p.length) colonist.path = p; else { colonist.carrying = null; colonist.workerState = 'atNest'; return; }
  }
  if (colonist.path.length) {
    const next = colonist.path.shift()!;
    if (walkable(next.x, next.y)) startStep(colonist, next.x, next.y, dirBetween(colonist.tileX, colonist.tileY, next.x, next.y));
    else colonist.path = [];
  }
}

// carrying a dug-up wall block: find a frontier tile (open ground bordering
// a wall) farther from the nest than where it was dug, and wall it back up
// there — relocating the block outward instead of resealing the hole
function runCarryingWall(state: GameState, colonist: Colonist, walkable: Walkable): void {
  if (!colonist.dropTarget) {
    colonist.dropTarget = findFrontierDropSite(state, colonist.tileX, colonist.tileY, WORKER_FRONTIER_SEARCH_RADIUS)
      ?? findFrontierDropSite(state, colonist.tileX, colonist.tileY, WORKER_FRONTIER_SEARCH_RADIUS * 2)
      ?? findFrontierDropSite(state, colonist.tileX, colonist.tileY, WORKER_FRONTIER_SEARCH_RADIUS * 4);
    colonist.path = [];
    if (!colonist.dropTarget) return; // nothing qualified this tick — try again next tick
  }
  const d = colonist.dropTarget;
  if (isAdjacent(colonist.tileX, colonist.tileY, d.x, d.y)) {
    if (walkable(d.x, d.y) && !foodAt(state, d.x, d.y)) {
      setWall(state, d.x, d.y, true);
      spawnFloatingText(state, colonist, 'placed block', '#b0aaa0');
    }
    colonist.carrying = null;
    colonist.dropTarget = null;
    colonist.path = [];
    if (colonist.carryOrigin === 'followingScent' && colonist.forageTarget && foodAt(state, colonist.forageTarget.x, colonist.forageTarget.y)) {
      colonist.workerState = 'followingScent'; // resume the trail it was on
    } else {
      colonist.forageTarget = null;
      colonist.workerState = 'atNest';
    }
    colonist.carryOrigin = null;
    return;
  }
  if (colonist.path.length === 0) {
    colonist.path = bfsToAdjacent(colonist.tileX, colonist.tileY, d.x, d.y, walkable);
    if (colonist.path.length === 0) { colonist.dropTarget = null; return; } // became unreachable — pick a new site next tick
  }
  const next = colonist.path.shift()!;
  if (walkable(next.x, next.y)) startStep(colonist, next.x, next.y, dirBetween(colonist.tileX, colonist.tileY, next.x, next.y));
  else colonist.path = [];
}

// only reachable via the attack interrupt: walk home laying an alarm trail
// the whole way, mirroring a scout's scent-active homeward pathing
function runReturningToNest(state: GameState, colonist: Colonist, now: number, walkable: Walkable): void {
  updateScent(state, colonist, now);
  if (!colonist.scentActive) { colonist.workerState = 'atNest'; return; }
  if (colonist.path.length === 0) {
    const spot = randomOpenTileNear(state, state.nest.x, state.nest.y, effectiveNestFoodRadius(state) - 1);
    const p = spot ? findPath(colonist.tileX, colonist.tileY, spot.x, spot.y, walkable) : [];
    if (p.length) colonist.path = p;
  }
  if (colonist.path.length) {
    const next = colonist.path.shift()!;
    if (walkable(next.x, next.y)) startStep(colonist, next.x, next.y, dirBetween(colonist.tileX, colonist.tileY, next.x, next.y));
    else colonist.path = [];
  }
}

export function updateWorker(state: GameState, _hud: HudRefs, colonist: Colonist, now: number, walkable: Walkable): void {
  if (colonist.attacked) {
    colonist.attacked = false;
    if (colonist.workerState !== 'atNest') {
      colonist.carrying = null;
      colonist.forageTarget = null;
      colonist.dropTarget = null;
      colonist.carryOrigin = null;
      colonist.path = [];
      triggerAlarm(state, colonist, now);
      colonist.workerState = 'returningToNest';
    }
  }

  switch (colonist.workerState) {
    case 'atNest': runAtNest(state, colonist, walkable); return;
    case 'followingScent': runFollowingScent(state, colonist); return;
    case 'carryingFood': runCarryingFood(state, colonist, walkable); return;
    case 'carryingWall': runCarryingWall(state, colonist, walkable); return;
    case 'returningToNest': runReturningToNest(state, colonist, now, walkable); return;
  }
}
