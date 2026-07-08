// Scout AI: a behavior tree, mirroring worker-ai.ts's shape. There's no
// explicit state field — scentActive/scentType is the single source of truth
// for whether a scout is out roaming or heading home, exactly as the old FSM
// noted. handleAttackFlag and handleEnemySighted are interrupt-handlers that
// always run first, each tick: an actual hit, or just spotting an enemy at
// range with line of sight, both immediately lay an alarm trail and clear
// any errand, so the very next branch check (returningToNestBranch) picks it
// up the same tick. Otherwise a scout either follows scentActive home
// (returningToNestBranch) or roams (scoutingBranch, the tree's default) —
// pulled toward nearby food, else picking a random far-off point and
// weighted-pathing to it, tunneling through walls at a cost (and restoring
// them once past) along the way.
import type { Colonist, Enemy, GameState, HudRefs, Point } from '../types/types';
import {
  COLONIST_FORAGE_RADIUS, COLONIST_MOVE_DUR, SCOUT_DIG_MOVE_DUR, SCOUT_EXPLORE_MAX_DIST, SCOUT_EXPLORE_MIN_DIST,
  SCOUT_VISION_RADIUS,
} from '../constants';
import {
  effectiveNestFoodRadius, foodAt, isWall, nearestFoodTo, randomOpenTileNear, scoutCost, setWall,
  triggerAlarm, updateScent,
} from '../state/state';
import { dirBetween, startStep } from '../entities/entities';
import { findWeightedPath, hasLineOfSight, type Walkable } from './pathfinding';
import { action, condition, selector, sequence, type BTNode } from './behavior-tree';

interface ScoutCtx {
  state: GameState;
  colonist: Colonist;
  now: number;
  walkable: Walkable;
}

// nearest living enemy within radius that the scout actually has line of
// sight to — no seeing through walls
function nearestVisibleEnemy(state: GameState, x: number, y: number, radius: number): Enemy | null {
  const losCheck = (tx: number, ty: number) => hasLineOfSight(x, y, tx, ty, (wx, wy) => isWall(state, wx, wy));
  let best: Enemy | null = null, bestDist = Infinity;
  for (const en of state.enemies) {
    if (en.hp <= 0) continue;
    const d = Math.hypot(en.tileX - x, en.tileY - y);
    if (d <= radius && d < bestDist && losCheck(en.tileX, en.tileY)) { best = en; bestDist = d; }
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

// one path step, shared by both branches: handles restoring a tile dug on
// the previous step, then either a normal step, a temporary dig-through, or
// giving up on the path if the next tile turns out unusable
function movePathStep({ state, colonist, walkable }: ScoutCtx): void {
  if (colonist.digTile) {
    setWall(state, colonist.digTile.x, colonist.digTile.y, true);
    colonist.digTile = null;
  }
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

// consumes the attack interrupt: clear the errand and lay an alarm trail —
// always runs first, unconditionally, each tick
const handleAttackFlag: BTNode<ScoutCtx> = action(({ state, colonist, now }) => {
  if (!colonist.attacked) return;
  colonist.attacked = false;
  colonist.forageTarget = null;
  colonist.path = [];
  triggerAlarm(state, colonist, now);
});

// proactive enemy vision: spotting an enemy at range (with line of sight)
// lays an alarm trail just like actually being hit, so the scout retreats
// before contact. Skipped while an alarm is already active to avoid
// re-triggering every tick.
const handleEnemySighted: BTNode<ScoutCtx> = action(({ state, colonist, now }) => {
  if (colonist.scentActive && colonist.scentType === 'alarm') return;
  const sighted = nearestVisibleEnemy(state, colonist.tileX, colonist.tileY, SCOUT_VISION_RADIUS);
  if (!sighted) return;
  colonist.forageTarget = null;
  colonist.path = [];
  triggerAlarm(state, colonist, now);
});

// turns scent on the moment food is found (or keeps stamping an already
// active trail) — unconditional, runs before the selector every tick so
// discovering food flips a scout to returningToNestBranch the same tick,
// not one tick late
const handleScentUpdate: BTNode<ScoutCtx> = action(({ state, colonist, now }) => {
  updateScent(state, colonist, now);
});

// heading home, laying scent the whole way — ignore food until home
const returningToNestBranch: BTNode<ScoutCtx> = sequence(
  condition(({ colonist }) => colonist.scentActive),
  action((ctx) => {
    const { state, colonist } = ctx;
    colonist.forageTarget = null;
    if (colonist.path.length === 0) {
      const spot = randomOpenTileNear(state, state.nest.x, state.nest.y, effectiveNestFoodRadius(state) - 1);
      const path = spot ? findWeightedPath(colonist.tileX, colonist.tileY, spot.x, spot.y, (x, y) => scoutCost(state, x, y)) : [];
      if (path.length) { colonist.exploreTarget = spot; colonist.path = path; }
    }
    movePathStep(ctx);
  }),
);

// roam: pulled toward nearby food, else random explore — the tree's
// default branch (no condition), reached whenever nothing else applies
const scoutingBranch: BTNode<ScoutCtx> = action((ctx) => {
  const { state, colonist, walkable } = ctx;

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

  movePathStep(ctx);
});

const scoutTree: BTNode<ScoutCtx> = sequence(
  handleAttackFlag,
  handleEnemySighted,
  handleScentUpdate,
  selector(returningToNestBranch, scoutingBranch),
);

export function updateScout(state: GameState, _hud: HudRefs, colonist: Colonist, now: number, walkable: Walkable): void {
  scoutTree({ state, colonist, now, walkable });
}
