// Worker AI: a behavior tree. A worker with nothing to forage prefers
// picking up a scent trail it detects, then food it can see nearby with no
// trail at all — regardless of how far it is from the nest — then a wall
// sitting on some other trail it isn't chasing, then, as the tree's true
// default, walking home if it isn't near the nest or else the wall tile
// closest to the nest, and only then just waiting. FindingFood/CarryingFood/
// CarryingWall handle an errand to completion; an attack at any point during
// one drops whatever's held (restored to the world, never lost) and reroutes
// home laying an alarm trail (see handleAttackFlag / fleeBranch).
// There's no explicit state field — every branch's guard condition (or, for
// findingFoodBranch/findingWallBranch/nestBranch, internal logic) reads
// blackboard fields (carrying/forageTarget/wallTarget/scentActive+scentType
// /attacked) that are cleared by whichever branch finishes with them, so the
// tree re-derives "what to do" from those fields fresh every tick instead of
// tracking a redundant enum. wallTarget is the one field two branches can
// write — nestBranch only ever hands it off, findingWallBranch (which
// always runs first) is what actually pursues it either way.
// Workers are deliberately not autonomous foragers — they only ever act on
// a scent trail, food they can see, or the nearest wall material.
import type { Colonist, FoodItem, GameState, HudRefs } from '../types/types';
import {
  COLONIST_FORAGE_RADIUS,
  COLONIST_MOVE_DUR,
  COLONIST_WANDER_MAX_MS,
  COLONIST_WANDER_MIN_MS,
  SCOUT_DIG_MOVE_DUR,
  WORKER_FRONTIER_SEARCH_RADIUS,
  WORKER_WANDER_RADIUS,
} from '../constants';
import {
  claimedForageTargets,
  claimedWallTargets,
  dropCarried,
  effectiveNestFoodRadius,
  findFrontierDropSite,
  foodAt,
  isFrontierDropCandidate,
  nearestDiggableWallNearNest,
  nearestFoodTo,
  nearestFoodViaTrail,
  nearestTrailWall,
  nestDistance,
  placeFoodNear,
  randomOpenTileNear,
  removeScentTrailForFood,
  setWall,
  spawnFloatingText,
  triggerAlarm,
  updateScent,
  walkable as stateWalkable,
  walkableIgnoringActors,
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

// wander to a small random nearby spot — used by carryingWallBranch while no
// frontier drop site qualifies, so the worker doesn't sit frozen mid-tunnel
// blocking every other worker while it keeps searching. Cooldown-gated the
// same way as the enemy/soldier wander behaviors (see ai.ts/soldier-ai.ts)
// so it doesn't replan a path every single tick.
function wanderStep({ state, colonist, now, walkable }: WorkerCtx): void {
  if (now >= colonist.nextWanderAt && colonist.path.length === 0) {
    const spot = randomOpenTileNear(
      state,
      colonist.tileX,
      colonist.tileY,
      WORKER_WANDER_RADIUS,
    );
    const p = spot
      ? findPath(colonist.tileX, colonist.tileY, spot.x, spot.y, walkable)
      : [];
    if (p.length) colonist.path = p;
    colonist.nextWanderAt =
      now +
      COLONIST_WANDER_MIN_MS +
      Math.random() * (COLONIST_WANDER_MAX_MS - COLONIST_WANDER_MIN_MS);
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
    colonist.wallTarget = null;
    colonist.carryOrigin = null;
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
  action((ctx) => {
    const { state, colonist, walkable } = ctx;
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
      if (!colonist.dropTarget) {
        // nothing qualifies right now — wander instead of freezing in place
        // (which would just block the tunnel for everyone else) and retry
        // the search again next tick from wherever that leaves it
        wanderStep(ctx);
        return;
      }
      colonist.path = [];
    }
    const d = colonist.dropTarget;
    if (isAdjacent(colonist.tileX, colonist.tileY, d.x, d.y)) {
      if (!isFrontierDropCandidate(state, d.x, d.y)) {
        // site stopped qualifying between selection and arrival — keep
        // carrying, pick a fresh site next tick instead of losing the block
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
        colonist.carryOrigin === 'forage' &&
        colonist.forageTarget &&
        foodAt(state, colonist.forageTarget.x, colonist.forageTarget.y)
      ) {
        // leave forageTarget set — findingFoodBranch resumes it next tick
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

// repeatedly calls a food-candidate query (nearestFoodViaTrail/nearestFoodTo),
// skipping any candidate with no flat walkable path in, from the colonist's
// current tile, until a reachable candidate turns up or the query runs out
// of candidates to exclude. Digging toward not-yet-reachable food isn't
// this branch's job anymore (see findingWallBranch), so a candidate that
// requires digging through even one wall is simply skipped rather than
// tentatively accepted.
function nextReachableFood(
  state: GameState,
  colonist: Colonist,
  find: (exclude: Set<string>) => FoodItem | null,
  claimed: Set<string>,
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
      ).length > 0
    )
      return candidate;
    exclude.add(candidate.x + ',' + candidate.y);
  }
}

// find-or-pursue the closest food: if already chasing a target, walk toward
// it; otherwise look for a new one from wherever the worker currently is —
// a scent trail first, then food merely in sight with no trail — and commit
// to it, deferring the first step of pursuit to next tick. Never digs — a
// target that turns out to be blocked is simply dropped (see
// findingWallBranch and nestBranch for wall clearing). Reports failure when
// there's an existing wall errand to defer to, or when nothing to forage
// turns up, so the selector falls through to wall handling.
const findingFoodBranch: BTNode<WorkerCtx> = action((ctx) => {
  const { state, colonist, walkable } = ctx;
  if (colonist.forageTarget) {
    const f = colonist.forageTarget;
    if (isAdjacent(colonist.tileX, colonist.tileY, f.x, f.y)) {
      const idx = state.foodItems.findIndex(
        (fi) => fi.x === f.x && fi.y === f.y,
      );
      if (idx !== -1) {
        state.foodItems.splice(idx, 1);
        colonist.carrying = 'food';
        removeScentTrailForFood(state, f.x, f.y);
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
      if (colonist.path.length === 0) {
        // became unreachable since it was selected (e.g. a wall went back
        // up in the way) — give up rather than dig; findingWallBranch/
        // nestBranch own wall-clearing, not this branch
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
    return;
  }

  // already committed to a wall errand (findingWallBranch/nestBranch) — defer
  // to it rather than distracting the worker into foraging mid-errand
  if (colonist.wallTarget) return 'failure';

  const claimed = claimedForageTargets(state, colonist);

  // nearestFoodViaTrail/nearestFoodTo only judge distance, not reachability,
  // so a candidate can be walled off from every side by occupied tiles with
  // no path in or out. Reject those here (same flat-walkable check this
  // branch uses to actually walk there) and keep falling back to the
  // next-nearest instead of committing to a target the worker would just
  // have to drop next tick.
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
  );
  if (sightFood) {
    colonist.forageTarget = sightFood;
    return;
  }

  return 'failure'; // nothing to forage — fall through to wall handling
});

// find-or-pursue a wall to dig: if already committed to one (wallTarget),
// walk to it and dig it — this is the only branch that ever moves toward a
// wall, whether it picked the target itself or nestBranch handed
// one off (that branch always runs after this one, so once it sets
// wallTarget this branch is what actually carries it out starting next
// tick, the same "commit now, pursue next tick" pattern findingFoodBranch
// uses for forageTarget). With nothing pending, looks for the closest wall
// sitting on a live scent trail — clearing one that findingFoodBranch never
// committed to chasing (e.g. the trail's food is out of forage range), so
// it doesn't sit undug forever — ranked by distance to the worker, not any
// specific goal, since there's no food target driving this.
const findingWallBranch: BTNode<WorkerCtx> = action(
  ({ state, colonist, walkable, now }) => {
    if (!colonist.wallTarget) {
      colonist.wallTarget = nearestTrailWall(
        state,
        colonist.tileX,
        colonist.tileY,
        claimedWallTargets(state, colonist),
      );
      if (!colonist.wallTarget) return 'failure'; // no trail wall — fall through to nestBranch
      return; // commit — pursuit starts next tick
    }
    const wall = colonist.wallTarget;

    if (isAdjacent(colonist.tileX, colonist.tileY, wall.x, wall.y)) {
      setWall(state, wall.x, wall.y, false);
      const key = wall.x + ',' + wall.y;
      if (state.scentTrail.has(key)) state.scentTrail.set(key, now);
      colonist.carrying = 'obstacle';
      colonist.carryOrigin = 'nestClean';
      colonist.wallTarget = null;
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
        // only actors (colonists/enemies/player) are in the way — that's a
        // traffic jam, not a real dead end, so leave it off unreachableWalls
        // and let it get re-picked once the jam clears
        const structurallyBlocked =
          bfsToAdjacent(
            colonist.tileX,
            colonist.tileY,
            wall.x,
            wall.y,
            (x, y) => walkableIgnoringActors(state, x, y),
          ).length === 0;
        if (structurallyBlocked)
          state.unreachableWalls.add(wall.x + ',' + wall.y);
        colonist.wallTarget = null;
        return;
      }
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
  },
);

// the tree's true default — nothing to forage or dig off a trail
// (findingFoodBranch/findingWallBranch already came up empty). If the
// worker isn't near the nest, just walk it home (same fallback
// findingFoodBranch used to do itself); otherwise commit to the wall tile
// closest to the nest, from the inside out, rather than whatever happens to
// be underfoot — findingWallBranch (which always runs first) is what
// actually walks to and digs it, starting next tick. If no wall qualifies
// either, the worker just idles.
const nestBranch: BTNode<WorkerCtx> = action((ctx) => {
  const { state, colonist } = ctx;
  if (colonist.wallTarget) return; // already pending — findingWallBranch owns it
  const nearNest =
    nestDistance(state, colonist.tileX, colonist.tileY) <=
    effectiveNestFoodRadius(state);
  if (!nearNest) {
    stepTowardNest(ctx);
    return;
  }
  colonist.wallTarget = nearestDiggableWallNearNest(
    state,
    claimedWallTargets(state, colonist),
  );
});

const workerTree: BTNode<WorkerCtx> = sequence(
  handleAttackFlag,
  selector(
    fleeBranch,
    carryingWallBranch,
    carryingFoodBranch,
    findingFoodBranch,
    findingWallBranch,
    nestBranch,
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
