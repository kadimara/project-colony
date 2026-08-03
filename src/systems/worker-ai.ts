// Worker AI: a behavior tree. AtNest is idle/home base — a worker there
// prefers heading out on a scent trail it detects, then food it can see
// nearby with no trail at all, then clearing the wall tile closest to the
// nest, then helping tunnel toward an alarm a soldier can't otherwise reach,
// and only then just waiting. FollowingScent/CarryingFood/CarryingWall/
// HelpingSoldier handle an errand to completion; an attack at any point
// during one drops whatever's held (restored to the world, never lost) and
// reroutes home laying an alarm trail (see handleAttackFlag / fleeBranch).
// There's no explicit state field — every branch's guard condition reads
// blackboard fields (carrying/forageTarget/tunnelTarget/scentActive+scentType
// /attacked) that are only ever set by one branch and cleared by whichever
// branch finishes with them, so the tree re-derives "what to do" from those
// fields fresh every tick instead of tracking a redundant enum. Workers are
// deliberately not autonomous foragers — they only ever act on a scent
// trail, food they can see, the nearest wall material, or an alarm.
import type { Colonist, FoodItem, GameState, HudRefs } from '../types/types';
import {
  COLONIST_FORAGE_RADIUS,
  COLONIST_MOVE_DUR,
  SCOUT_DIG_MOVE_DUR,
  SOLDIER_ALERT_SCENT_RADIUS,
  WORKER_FRONTIER_SEARCH_RADIUS,
} from '../constants';
import {
  claimedForageTargets,
  dropCarried,
  effectiveNestFoodRadius,
  findFrontierDropSite,
  foodAt,
  nearestAlarmSource,
  nearestDiggableWall,
  nearestDiggableWallNearNest,
  nearestFoodTo,
  nearestFoodViaTrail,
  nestDistance,
  placeFoodNear,
  randomOpenTileNear,
  setWall,
  spawnFloatingText,
  triggerAlarm,
  updateScent,
  walkable as stateWalkable,
} from '../state/state';
import { dirBetween, startStep } from '../entities/entities';
import {
  bfsToAdjacent,
  findPath,
  isAdjacent,
  type Walkable,
} from './pathfinding';
import {
  action,
  condition,
  selector,
  sequence,
  type BTNode,
} from './behavior-tree';

interface WorkerCtx {
  state: GameState;
  colonist: Colonist;
  now: number;
  walkable: Walkable;
}

// shared "walk one step toward a random open tile near the nest" used by
// several branches when they have no more specific destination in mind
function stepTowardNest({ state, colonist, walkable }: WorkerCtx): void {
  if (colonist.path.length === 0) {
    const spot = randomOpenTileNear(
      state,
      state.nest.x,
      state.nest.y,
      effectiveNestFoodRadius(state) - 1,
    );
    const p = spot
      ? findPath(colonist.tileX, colonist.tileY, spot.x, spot.y, walkable)
      : [];
    if (p.length) colonist.path = p;
  }
  if (colonist.path.length) {
    const next = colonist.path.shift()!;
    if (walkable(next.x, next.y))
      startStep(
        colonist,
        next.x,
        next.y,
        dirBetween(colonist.tileX, colonist.tileY, next.x, next.y),
      );
    else colonist.path = [];
  }
}

// consumes the attack interrupt: drop whatever's held, clear errand targets,
// and lay an alarm trail — always runs first, unconditionally, each tick
const handleAttackFlag: BTNode<WorkerCtx> = action(
  ({ state, colonist, now }) => {
    if (!colonist.attacked) return;
    colonist.attacked = false;
    dropCarried(state, colonist);
    colonist.forageTarget = null;
    colonist.dropTarget = null;
    colonist.carryOrigin = null;
    colonist.tunnelTarget = null;
    colonist.path = [];
    triggerAlarm(state, colonist, now);
  },
);

// fleeing home while an alarm trail is active (only ever active after
// handleAttackFlag triggers it, or while one is still decaying)
const fleeBranch: BTNode<WorkerCtx> = sequence(
  condition(
    ({ colonist }) => colonist.scentActive && colonist.scentType === 'alarm',
  ),
  action((ctx) => {
    updateScent(ctx.state, ctx.colonist, ctx.now);
    if (!ctx.colonist.scentActive) return; // decayed/arrived — next tick falls through to atNest
    stepTowardNest(ctx);
  }),
);

// carrying a dug-up wall block: find a frontier tile (open ground bordering
// a wall) farther from the nest than where it was dug, and wall it back up
// there — relocating the block outward instead of resealing the hole
const carryingWallBranch: BTNode<WorkerCtx> = sequence(
  condition(({ colonist }) => colonist.carrying === 'obstacle'),
  action(({ state, colonist, walkable }) => {
    if (!colonist.dropTarget) {
      colonist.dropTarget =
        findFrontierDropSite(
          state,
          colonist.tileX,
          colonist.tileY,
          WORKER_FRONTIER_SEARCH_RADIUS,
        ) ??
        findFrontierDropSite(
          state,
          colonist.tileX,
          colonist.tileY,
          WORKER_FRONTIER_SEARCH_RADIUS * 2,
        ) ??
        findFrontierDropSite(
          state,
          colonist.tileX,
          colonist.tileY,
          WORKER_FRONTIER_SEARCH_RADIUS * 4,
        );
      colonist.path = [];
      if (!colonist.dropTarget) return; // nothing qualified this tick — try again next tick
    }
    const d = colonist.dropTarget;
    if (isAdjacent(colonist.tileX, colonist.tileY, d.x, d.y)) {
      if (!walkable(d.x, d.y) || foodAt(state, d.x, d.y)) {
        // site got blocked between selection and arrival — keep carrying,
        // pick a fresh site next tick instead of losing the block
        colonist.dropTarget = null;
        colonist.path = [];
        return;
      }
      setWall(state, d.x, d.y, true);
      spawnFloatingText(state, colonist, 'placed block', '#b0aaa0');
      colonist.carrying = null;
      colonist.dropTarget = null;
      colonist.path = [];
      if (
        colonist.carryOrigin === 'followingScent' &&
        colonist.forageTarget &&
        foodAt(state, colonist.forageTarget.x, colonist.forageTarget.y)
      ) {
        // leave forageTarget set — followingScentBranch resumes it next tick
      } else {
        colonist.forageTarget = null;
      }
      colonist.carryOrigin = null;
      return;
    }
    if (colonist.path.length === 0) {
      colonist.path = bfsToAdjacent(
        colonist.tileX,
        colonist.tileY,
        d.x,
        d.y,
        walkable,
      );
      if (colonist.path.length === 0) {
        colonist.dropTarget = null;
        return;
      } // became unreachable — pick a new site next tick
    }
    const next = colonist.path.shift()!;
    if (walkable(next.x, next.y))
      startStep(
        colonist,
        next.x,
        next.y,
        dirBetween(colonist.tileX, colonist.tileY, next.x, next.y),
      );
    else colonist.path = [];
  }),
);

// carrying food back to drop it within range of the nest
const carryingFoodBranch: BTNode<WorkerCtx> = sequence(
  condition(({ colonist }) => colonist.carrying === 'food'),
  action((ctx) => {
    const { state, colonist } = ctx;
    const nearNest =
      nestDistance(state, colonist.tileX, colonist.tileY) <=
      effectiveNestFoodRadius(state);
    if (nearNest) {
      placeFoodNear(state, colonist.tileX, colonist.tileY);
      colonist.carrying = null;
      colonist.path = [];
      return;
    }
    if (colonist.path.length === 0) {
      const spot = randomOpenTileNear(
        state,
        state.nest.x,
        state.nest.y,
        effectiveNestFoodRadius(state) - 1,
      );
      const p = spot
        ? findPath(colonist.tileX, colonist.tileY, spot.x, spot.y, ctx.walkable)
        : [];
      // no path home found yet — keep carrying and retry next tick rather than losing the food
      if (p.length) colonist.path = p;
      else return;
    }
    if (colonist.path.length) {
      const next = colonist.path.shift()!;
      if (ctx.walkable(next.x, next.y))
        startStep(
          colonist,
          next.x,
          next.y,
          dirBetween(colonist.tileX, colonist.tileY, next.x, next.y),
        );
      else colonist.path = [];
    }
  }),
);

// following an active scent trail toward the food it reports, tunneling
// permanently through any wall tile in the way (unlike a scout's temporary dig)
const followingScentBranch: BTNode<WorkerCtx> = sequence(
  condition(({ colonist }) => colonist.forageTarget !== null),
  action(({ state, colonist, walkable, now }) => {
    const f = colonist.forageTarget!;
    if (isAdjacent(colonist.tileX, colonist.tileY, f.x, f.y)) {
      const idx = state.foodItems.findIndex(
        (fi) => fi.x === f.x && fi.y === f.y,
      );
      if (idx !== -1) {
        state.foodItems.splice(idx, 1);
        colonist.carrying = 'food';
      }
      colonist.forageTarget = null;
      colonist.path = [];
      return;
    }
    if (colonist.path.length === 0) {
      colonist.path = bfsToAdjacent(
        colonist.tileX,
        colonist.tileY,
        f.x,
        f.y,
        walkable,
      );
    }
    if (colonist.path.length === 0) {
      // no flat route in — dig toward the target one known wall at a time
      // instead of a weighted pathfinder committing to a whole multi-wall
      // route (see wallsToDig in state.ts for how walls get queued)
      const wall = nearestDiggableWall(state, f.x, f.y);
      if (!wall) {
        colonist.forageTarget = null;
        return;
      }
      if (isAdjacent(colonist.tileX, colonist.tileY, wall.x, wall.y)) {
        setWall(state, wall.x, wall.y, false);
        const key = wall.x + ',' + wall.y;
        // digging can un-pin a scent trail entry that was frozen while this
        // wall stood (see pruneScentTrail) — refresh its timestamp so it
        // doesn't get pruned before anyone benefits from the tile opening up
        if (state.scentTrail.has(key)) state.scentTrail.set(key, now);
        colonist.carrying = 'obstacle';
        colonist.carryOrigin = 'followingScent';
        colonist.path = [];
        spawnFloatingText(state, colonist, 'dug through wall', '#b0aaa0');
        return;
      }
      colonist.path = bfsToAdjacent(
        colonist.tileX,
        colonist.tileY,
        wall.x,
        wall.y,
        walkable,
      );
      if (colonist.path.length === 0) {
        colonist.forageTarget = null;
        return;
      }
    }
    const next = colonist.path.shift()!;
    if (walkable(next.x, next.y)) {
      startStep(
        colonist,
        next.x,
        next.y,
        dirBetween(colonist.tileX, colonist.tileY, next.x, next.y),
      );
    } else {
      colonist.path = []; // occupied/blocked since planning — force a replan next tick
    }
  }),
);

// helping a soldier reach an alarm source that a wall is blocking: paths
// toward the alarm the same way followingScentBranch paths toward food,
// tunneling permanently through whatever wall is in the way. Only ever
// committed to by atNestBranch, and only once a flat (non-digging) route was
// already tried and failed — if a soldier can already get there unaided,
// workers stay out of it.
const helpingSoldierBranch: BTNode<WorkerCtx> = sequence(
  condition(({ colonist }) => colonist.tunnelTarget !== null),
  action(({ state, colonist, walkable, now }) => {
    const t = colonist.tunnelTarget!;
    if (
      isAdjacent(colonist.tileX, colonist.tileY, t.x, t.y) ||
      !nearestAlarmSource(
        state,
        colonist.tileX,
        colonist.tileY,
        SOLDIER_ALERT_SCENT_RADIUS,
      )
    ) {
      colonist.tunnelTarget = null;
      colonist.path = [];
      return;
    }
    if (colonist.path.length === 0) {
      colonist.path = bfsToAdjacent(
        colonist.tileX,
        colonist.tileY,
        t.x,
        t.y,
        walkable,
      );
    }
    if (colonist.path.length === 0) {
      const wall = nearestDiggableWall(state, t.x, t.y);
      if (!wall) {
        colonist.tunnelTarget = null;
        return;
      }
      if (isAdjacent(colonist.tileX, colonist.tileY, wall.x, wall.y)) {
        setWall(state, wall.x, wall.y, false);
        const key = wall.x + ',' + wall.y;
        if (state.scentTrail.has(key)) state.scentTrail.set(key, now);
        colonist.carrying = 'obstacle';
        colonist.carryOrigin = 'helpingSoldier';
        colonist.path = [];
        spawnFloatingText(state, colonist, 'dug through wall', '#b0aaa0');
        return;
      }
      colonist.path = bfsToAdjacent(
        colonist.tileX,
        colonist.tileY,
        wall.x,
        wall.y,
        walkable,
      );
      if (colonist.path.length === 0) {
        colonist.tunnelTarget = null;
        return;
      }
    }
    const next = colonist.path.shift()!;
    if (walkable(next.x, next.y)) {
      startStep(
        colonist,
        next.x,
        next.y,
        dirBetween(colonist.tileX, colonist.tileY, next.x, next.y),
      );
    } else {
      colonist.path = [];
    }
  }),
);

// repeatedly calls a food-candidate query (nearestFoodViaTrail/nearestFoodTo),
// skipping any candidate with no path in — including a tunneling one, when
// allowDig is set — from the colonist's current tile, until a reachable
// candidate turns up or the query runs out of candidates to exclude.
// allowDig should only be true for trail-reported food: bfsToAdjacent never
// crosses walls, so a trail candidate that requires digging through even one
// resealed wall would otherwise always get rejected here, even though
// followingScentBranch can (and is meant to) tunnel through it. Sight-only
// food (no trail) gets no such benefit of the doubt — see atNestBranch.
function nextReachableFood(
  state: GameState,
  colonist: Colonist,
  find: (exclude: Set<string>) => FoodItem | null,
  claimed: Set<string>,
  allowDig: boolean,
): FoodItem | null {
  const exclude = new Set(claimed);
  for (;;) {
    const candidate = find(exclude);
    if (!candidate) return null;
    if (
      isAdjacent(colonist.tileX, colonist.tileY, candidate.x, candidate.y) ||
      bfsToAdjacent(
        colonist.tileX,
        colonist.tileY,
        candidate.x,
        candidate.y,
        (x, y) => stateWalkable(state, x, y),
      ).length > 0 ||
      (allowDig &&
        nearestDiggableWall(state, candidate.x, candidate.y) !== null)
    )
      return candidate;
    exclude.add(candidate.x + ',' + candidate.y);
  }
}

// stationed at the nest: pick up a scent trail if one's in range, else food
// it can see nearby with no trail leading to it — foraging takes priority
// since food waiting to be fetched matters more than nest upkeep — otherwise
// walk to and clear the wall tile closest to the nest (clearing the nest's
// surroundings from the inside out, rather than whatever happens to be
// underfoot), otherwise commit to tunneling toward an alarm a soldier can't
// reach unaided, otherwise just wait. This is the tree's default branch (no
// condition), reached whenever nothing else applies
const atNestBranch: BTNode<WorkerCtx> = action((ctx) => {
  const { state, colonist, walkable, now } = ctx;
  const nearNest =
    nestDistance(state, colonist.tileX, colonist.tileY) <=
    effectiveNestFoodRadius(state);
  if (!nearNest) {
    stepTowardNest(ctx);
    return;
  }

  const claimed = claimedForageTargets(state, colonist);

  // nearestFoodViaTrail/nearestFoodTo only judge distance, not reachability,
  // so a candidate can be walled off from every side by occupied tiles with
  // no path in or out. Reject those here (same weighted, tunnel-capable
  // search followingScentBranch uses to actually walk there) and keep
  // falling back to the next-nearest instead of committing to a target the
  // worker would just have to drop next tick.
  const trailFood = nextReachableFood(
    state,
    colonist,
    (exclude) =>
      nearestFoodViaTrail(
        state,
        colonist.tileX,
        colonist.tileY,
        COLONIST_FORAGE_RADIUS,
        exclude,
      ),
    claimed,
    true,
  );
  if (trailFood) {
    colonist.forageTarget = trailFood;
    return;
  }

  const sightFood = nextReachableFood(
    state,
    colonist,
    (exclude) =>
      nearestFoodTo(
        state,
        colonist.tileX,
        colonist.tileY,
        COLONIST_FORAGE_RADIUS,
        true,
        undefined,
        exclude,
      ),
    claimed,
    false,
  );
  if (sightFood) {
    colonist.forageTarget = sightFood;
    return;
  }

  const wall = nearestDiggableWallNearNest(state);
  if (wall) {
    if (isAdjacent(colonist.tileX, colonist.tileY, wall.x, wall.y)) {
      setWall(state, wall.x, wall.y, false);
      const key = wall.x + ',' + wall.y;
      if (state.scentTrail.has(key)) state.scentTrail.set(key, now);
      colonist.carrying = 'obstacle';
      colonist.carryOrigin = 'atNest';
      colonist.path = [];
      spawnFloatingText(state, colonist, 'dug through wall', '#b0aaa0');
      return;
    }
    if (colonist.path.length === 0) {
      colonist.path = bfsToAdjacent(
        colonist.tileX,
        colonist.tileY,
        wall.x,
        wall.y,
        walkable,
      );
      if (colonist.path.length === 0) {
        state.unreachableWalls.add(wall.x + ',' + wall.y);
        return;
      } // no walkable-only approach — stop re-picking this one
    }
    if (colonist.path.length) {
      const next = colonist.path.shift()!;
      if (walkable(next.x, next.y))
        startStep(
          colonist,
          next.x,
          next.y,
          dirBetween(colonist.tileX, colonist.tileY, next.x, next.y),
        );
      else colonist.path = [];
    }
    return;
  }

  if (!colonist.tunnelTarget) {
    const alarmSrc = nearestAlarmSource(
      state,
      colonist.tileX,
      colonist.tileY,
      SOLDIER_ALERT_SCENT_RADIUS,
    );
    if (
      alarmSrc &&
      !isAdjacent(colonist.tileX, colonist.tileY, alarmSrc.x, alarmSrc.y)
    ) {
      const flatRoute = bfsToAdjacent(
        colonist.tileX,
        colonist.tileY,
        alarmSrc.x,
        alarmSrc.y,
        walkable,
      );
      if (flatRoute.length === 0) colonist.tunnelTarget = alarmSrc; // no walk-only route — a wall's in the way, commit to tunneling
    }
  }
});

const workerTree: BTNode<WorkerCtx> = sequence(
  handleAttackFlag,
  selector(
    fleeBranch,
    carryingWallBranch,
    carryingFoodBranch,
    followingScentBranch,
    helpingSoldierBranch,
    atNestBranch,
  ),
);

export function updateWorker(
  state: GameState,
  _hud: HudRefs,
  colonist: Colonist,
  now: number,
  walkable: Walkable,
): void {
  // hauling something slows a worker to a digging scout's pace
  colonist.moveDur = colonist.carrying
    ? SCOUT_DIG_MOVE_DUR
    : COLONIST_MOVE_DUR.worker;
  workerTree({ state, colonist, now, walkable });
}
