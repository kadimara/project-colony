// Scout AI: a 2-state finite state machine. Scouting roams (pulled toward
// any food that comes within forage radius, otherwise picking a random
// far-off point and weighted-pathing to it, tunneling through walls at a
// cost along the way) until it finds food or is attacked, either of which
// starts a scent trail and flips it to ReturningToNest — a straight,
// scent-laying shot back to the nest. Arrival flips it back to Scouting.
import type { Colonist, GameState, HudRefs, Point } from '../types/types';
import { COLONIST_FORAGE_RADIUS, COLONIST_MOVE_DUR, SCOUT_DIG_MOVE_DUR, SCOUT_EXPLORE_MAX_DIST, SCOUT_EXPLORE_MIN_DIST } from '../constants';
import {
  effectiveNestFoodRadius, foodAt, isWall, nearestFoodTo, randomOpenTileNear, scoutCost, setWall,
  triggerAlarm, updateScent,
} from '../state/state';
import { dirBetween, startStep } from '../entities/entities';
import { findWeightedPath, type Walkable } from './pathfinding';

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

// roam: pulled toward nearby food, else random explore
function runScouting(state: GameState, colonist: Colonist, walkable: Walkable): void {
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

// returning to the nest, laying scent the whole way — ignore food until home
function runReturningToNest(state: GameState, colonist: Colonist): void {
  colonist.forageTarget = null;
  if (colonist.path.length === 0) {
    const spot = randomOpenTileNear(state, state.nest.x, state.nest.y, effectiveNestFoodRadius(state) - 1);
    const path = spot ? findWeightedPath(colonist.tileX, colonist.tileY, spot.x, spot.y, (x, y) => scoutCost(state, x, y)) : [];
    if (path.length) { colonist.exploreTarget = spot; colonist.path = path; }
  }
}

function movePathStep(state: GameState, colonist: Colonist, walkable: Walkable): void {
  if (colonist.path.length === 0) return;
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
    colonist.path = [];
    colonist.exploreTarget = null;
  }
}

export function updateScout(state: GameState, _hud: HudRefs, colonist: Colonist, now: number, walkable: Walkable): void {
  // standing on a dug tile means it's about to move on — put the wall
  // block back down now that it's leaving
  if (colonist.digTile) {
    setWall(state, colonist.digTile.x, colonist.digTile.y, true);
    colonist.digTile = null;
  }

  if (colonist.attacked) {
    colonist.attacked = false;
    colonist.forageTarget = null;
    colonist.path = [];
    triggerAlarm(state, colonist, now);
    colonist.scoutState = 'returningToNest';
  }

  updateScent(state, colonist, now);

  // scentActive is the single source of truth for which side of the FSM
  // we're on — both the food-discovery trigger (inside updateScent) and the
  // attack interrupt (above) turn it on; arrival turns it off (also inside
  // updateScent), so these two lines are the entire transition logic
  if (colonist.scoutState === 'scouting' && colonist.scentActive) colonist.scoutState = 'returningToNest';
  if (colonist.scoutState === 'returningToNest' && !colonist.scentActive) colonist.scoutState = 'scouting';

  if (colonist.scoutState === 'returningToNest') runReturningToNest(state, colonist);
  else runScouting(state, colonist, walkable);

  movePathStep(state, colonist, walkable);
}
