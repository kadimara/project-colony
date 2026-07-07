// Worker AI: a small job-priority finite state machine. Each tick, a worker
// picks the highest-priority job it currently qualifies for (selectWorkerJob)
// and runs that job's handler. Jobs 'returnFood'/'returnObstacle' are
// "must-finish" — once a worker is carrying something, nothing else is even
// considered until the corresponding run* handler clears colonist.carrying.
import type { Colonist, GameState, HudRefs, WorkerJob } from '../types/types';
import {
  COLONIST_FORAGE_RADIUS, NEST_EXPAND_MAX_LEVEL, NEST_EXPAND_SEARCH_RADIUS, NEST_EXPAND_WORK_PER_LEVEL,
  WORKER_FRONTIER_SEARCH_RADIUS,
} from '../constants';
import {
  effectiveNestFoodRadius, findFrontierDropSite, findNestExpansionTarget, foodAt, isWall, nearestFoodTo,
  nearestFoodViaTrail, nestDistance, randomOpenTileNear, scoutCost, setWall, spawnFloatingText,
} from '../state/state';
import { dirBetween, startStep } from '../entities/entities';
import { bfsToAdjacent, findPath, findWeightedPathToAdjacent, isAdjacent, type Walkable } from './pathfinding';

function selectWorkerJob(state: GameState, colonist: Colonist): WorkerJob {
  if (colonist.carrying === 'food') return 'returnFood';
  if (colonist.carrying === 'obstacle') return 'returnObstacle';

  // already committed to a target — keep pursuing it with whichever pathing
  // it started with (forageViaTrail persists across a returnObstacle/
  // returnFood detour, unlike colonist.job, which those jobs overwrite; using
  // colonist.job here would make a worker abandon a trail errand it had
  // already started digging into just because relocating a dug block carried
  // it out of scent-trail range in the meantime)
  if (colonist.forageTarget && foodAt(state, colonist.forageTarget.x, colonist.forageTarget.y)) {
    return colonist.forageViaTrail ? 'followTrail' : 'forage';
  }

  // Follow Scent Trail takes priority over plain forage every tick it's
  // available, so workers proactively open up tunnels along trails instead
  // of just picking off whatever food is nearest to walk to.
  const trailFood = nearestFoodViaTrail(state, colonist.tileX, colonist.tileY, COLONIST_FORAGE_RADIUS);
  if (trailFood) { colonist.forageTarget = trailFood; colonist.forageViaTrail = true; return 'followTrail'; }

  const spotted = nearestFoodTo(state, colonist.tileX, colonist.tileY, COLONIST_FORAGE_RADIUS);
  if (spotted) { colonist.forageTarget = spotted; colonist.forageViaTrail = false; return 'forage'; }

  // nothing to forage — put idle hands to work expanding the nest, unless
  // it's already maxed out or there's nothing diggable nearby right now
  if (state.nest.level < NEST_EXPAND_MAX_LEVEL) {
    if (colonist.digTarget && isWall(state, colonist.digTarget.x, colonist.digTarget.y)) return 'expandNest';
    const target = findNestExpansionTarget(state, NEST_EXPAND_SEARCH_RADIUS);
    if (target) { colonist.digTarget = target; return 'expandNest'; }
  }

  colonist.forageTarget = null;
  return 'wander';
}

// carrying food back to drop it within range of the nest
function runReturnFood(state: GameState, colonist: Colonist, walkable: Walkable): void {
  const nearNest = nestDistance(state, colonist.tileX, colonist.tileY) <= effectiveNestFoodRadius(state);
  if (nearNest) {
    if (!foodAt(state, colonist.tileX, colonist.tileY)) state.foodItems.push({ x: colonist.tileX, y: colonist.tileY });
    colonist.carrying = null;
    colonist.path = [];
    return;
  }
  if (colonist.path.length === 0) {
    const spot = randomOpenTileNear(state, state.nest.x, state.nest.y, effectiveNestFoodRadius(state) - 1);
    const p = spot ? findPath(colonist.tileX, colonist.tileY, spot.x, spot.y, walkable) : [];
    if (p.length) colonist.path = p; else { colonist.carrying = null; }
  }
  if (colonist.path.length) {
    const next = colonist.path.shift()!;
    if (walkable(next.x, next.y)) startStep(colonist, next.x, next.y, dirBetween(colonist.tileX, colonist.tileY, next.x, next.y));
    else colonist.path = [];
  }
}

// carrying a dug-up obstacle block: find a frontier tile (open ground
// bordering a wall) farther from the nest than where it was dug, and wall it
// back up there — relocating the block outward instead of resealing the hole
function runReturnObstacle(state: GameState, colonist: Colonist, walkable: Walkable): void {
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

// following an active scent trail toward the food it reports, tunneling
// through any wall tile in the way — permanently, unlike a scout's dig
function runFollowTrail(state: GameState, colonist: Colonist): void {
  const f = colonist.forageTarget!;
  if (isAdjacent(colonist.tileX, colonist.tileY, f.x, f.y)) {
    const idx = state.foodItems.findIndex((fi) => fi.x === f.x && fi.y === f.y);
    if (idx !== -1) { state.foodItems.splice(idx, 1); colonist.carrying = 'food'; }
    colonist.forageTarget = null;
    colonist.path = [];
    return;
  }
  if (colonist.path.length === 0) {
    colonist.path = findWeightedPathToAdjacent(colonist.tileX, colonist.tileY, f.x, f.y, (x, y) => scoutCost(state, x, y));
    if (colonist.path.length === 0) { colonist.forageTarget = null; return; } // unreachable even with tunneling — reselect next tick
  }
  const next = colonist.path[0];
  if (isWall(state, next.x, next.y)) {
    // permanent dig: an instantaneous pickup from an adjacent tile (like the
    // player's manual doPickup('obstacle')), not a slowed move-through like a
    // scout's dig — the wall never gets put back
    setWall(state, next.x, next.y, false);
    colonist.carrying = 'obstacle';
    colonist.path = [];
    spawnFloatingText(state, colonist, 'dug through wall', '#b0aaa0');
    return;
  }
  colonist.path.shift();
  startStep(colonist, next.x, next.y, dirBetween(colonist.tileX, colonist.tileY, next.x, next.y));
}

// not carrying: look for food outside the nest's radius (no point hauling
// food that's already close enough to fuel production)
function runForage(state: GameState, colonist: Colonist, walkable: Walkable): void {
  const f = colonist.forageTarget!;
  if (isAdjacent(colonist.tileX, colonist.tileY, f.x, f.y)) {
    const idx = state.foodItems.findIndex((fi) => fi.x === f.x && fi.y === f.y);
    if (idx !== -1) { state.foodItems.splice(idx, 1); colonist.carrying = 'food'; }
    colonist.forageTarget = null;
    colonist.path = [];
    return;
  }
  if (colonist.path.length === 0) {
    colonist.path = bfsToAdjacent(colonist.tileX, colonist.tileY, f.x, f.y, walkable);
  }
  if (colonist.path.length) {
    const next = colonist.path.shift()!;
    if (walkable(next.x, next.y)) startStep(colonist, next.x, next.y, dirBetween(colonist.tileX, colonist.tileY, next.x, next.y));
    else colonist.path = [];
  }
}

// idle labor: dig up a wall tile near the nest (an instantaneous pickup, same
// as runFollowTrail's dig) and credit the nest's expansion progress — the
// very next tick, carrying === 'obstacle' hands off to the existing
// runReturnObstacle to relocate the block, exactly like a tunnel dig would
function runExpandNest(state: GameState, colonist: Colonist, walkable: Walkable): void {
  const target = colonist.digTarget!;
  if (isAdjacent(colonist.tileX, colonist.tileY, target.x, target.y)) {
    if (!isWall(state, target.x, target.y)) { colonist.digTarget = null; return; } // another worker beat it here — re-search next tick
    setWall(state, target.x, target.y, false);
    colonist.carrying = 'obstacle';
    colonist.digTarget = null;
    colonist.path = [];
    const { nest } = state;
    nest.workProgress += 1;
    if (nest.workProgress >= NEST_EXPAND_WORK_PER_LEVEL && nest.level < NEST_EXPAND_MAX_LEVEL) {
      nest.level += 1;
      nest.workProgress = 0;
      spawnFloatingText(state, colonist, 'nest expanded!', '#9be89b');
    } else {
      spawnFloatingText(state, colonist, 'dug through wall', '#b0aaa0');
    }
    return;
  }
  if (colonist.path.length === 0) {
    colonist.path = bfsToAdjacent(colonist.tileX, colonist.tileY, target.x, target.y, walkable);
    if (colonist.path.length === 0) { colonist.digTarget = null; return; } // unreachable — pick a new target next tick
  }
  const next = colonist.path.shift()!;
  if (walkable(next.x, next.y)) startStep(colonist, next.x, next.y, dirBetween(colonist.tileX, colonist.tileY, next.x, next.y));
  else colonist.path = [];
}

// returns true if the worker acted this tick (caller should return); false
// only for 'wander', so the caller falls through to the shared wander block
export function updateWorker(state: GameState, _hud: HudRefs, colonist: Colonist, _now: number, walkable: Walkable): boolean {
  const job = selectWorkerJob(state, colonist);
  if (job !== colonist.job) colonist.path = [];
  colonist.job = job;

  switch (job) {
    case 'returnFood': runReturnFood(state, colonist, walkable); return true;
    case 'returnObstacle': runReturnObstacle(state, colonist, walkable); return true;
    case 'followTrail': runFollowTrail(state, colonist); return true;
    case 'forage': runForage(state, colonist, walkable); return true;
    case 'expandNest': runExpandNest(state, colonist, walkable); return true;
    case 'wander': return false;
  }
}
