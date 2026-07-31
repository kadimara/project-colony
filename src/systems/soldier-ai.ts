// Soldier AI: a behavior tree, mirroring worker-ai.ts's shape. Attacking and
// FollowingAlertScent are driven directly off the aggroTarget/alertTarget
// blackboard fields (only ever set by one branch, cleared by whichever
// branch finishes with them) rather than an explicit soldierState enum, the
// same way worker-ai derives its branches from carrying/forageTarget.
// Idle — no aggro target, no alert trail — is the tree's default branch: it
// scans for an alarm trail first (so a soldier mid-return still notices one),
// then guarantees a soldier away from the nest heads back before it resumes
// patrol, so any finished errand (a kill, an evaporated alert trail) always
// routes home instead of possibly idling wherever it happened to stop.
// Combat is always fought to resolution — soldiers never retreat on their
// own HP, unlike Scout/Worker's attack interrupt, which this file never
// checks.
import type { Colonist, Enemy, GameState, HudRefs } from '../types/types';
import {
  COLONIST_AGGRO_RADIUS, COLONIST_ATK_COOLDOWN, COLONIST_ATK_DAMAGE, COLONIST_REPATH_MS,
  COLONIST_WANDER_MAX_MS, COLONIST_WANDER_MIN_MS, SOLDIER_ALERT_SCENT_RADIUS, SOLDIER_PATROL_RADIUS,
} from '../constants';
import { effectiveNestFoodRadius, nearestAlarmSource, nestDistance, randomOpenTileNear, spawnFloatingText } from '../state/state';
import { dirBetween, startStep } from '../entities/entities';
import { bfsToAdjacent, findPath, isAdjacent, type Walkable } from './pathfinding';
import { killEnemy } from './combat';
import { action, condition, selector, sequence, type BTNode } from './behavior-tree';

interface SoldierCtx {
  state: GameState;
  hud: HudRefs;
  colonist: Colonist;
  now: number;
  walkable: Walkable;
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

// shared "walk one step toward a random open tile near the nest" — same
// shape as worker-ai's stepTowardNest, used whenever a soldier has nothing
// more specific to do than head home
function stepTowardNest({ state, colonist, walkable }: SoldierCtx): void {
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

// engaged in combat until resolved — soldiers do not retreat, so there is
// no HP-based check on the colonist itself here
const attackingBranch: BTNode<SoldierCtx> = sequence(
  condition(({ colonist }) => colonist.aggroTarget !== null),
  action(({ state, hud, colonist, now, walkable }) => {
    const t = colonist.aggroTarget!;
    if (t.hp <= 0) { colonist.aggroTarget = null; colonist.path = []; return; }
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
  }),
);

// alert trail detected: head toward its source, but peel off toward any
// enemy that comes into sighting range along the way
const followingAlertScentBranch: BTNode<SoldierCtx> = sequence(
  condition(({ colonist }) => colonist.alertTarget !== null),
  action(({ state, colonist, walkable }) => {
    const sighted = nearestEnemyTo(state, colonist.tileX, colonist.tileY, COLONIST_AGGRO_RADIUS);
    if (sighted) {
      colonist.aggroTarget = sighted;
      colonist.alertTarget = null;
      colonist.path = [];
      return;
    }
    const target = colonist.alertTarget!;
    if (isAdjacent(colonist.tileX, colonist.tileY, target.x, target.y)) {
      // reached the alarm's source with nothing left to fight — stand down,
      // falls through to idleBranch next tick, which heads home
      colonist.alertTarget = null;
      colonist.path = [];
      return;
    }
    if (colonist.path.length === 0) {
      colonist.path = bfsToAdjacent(colonist.tileX, colonist.tileY, target.x, target.y, walkable);
      if (colonist.path.length === 0) { colonist.alertTarget = null; return; }
    }
    const next = colonist.path.shift()!;
    if (walkable(next.x, next.y)) startStep(colonist, next.x, next.y, dirBetween(colonist.tileX, colonist.tileY, next.x, next.y));
    else colonist.path = [];
  }),
);

// nothing to fight and no trail to follow: this is the tree's default
// branch (no condition), reached whenever nothing else applies. Scans for
// an alarm trail first — even mid-return, a soldier should still notice
// one — then guarantees a soldier that isn't near the nest heads back
// there (covering a kill or an evaporated alert trail that left it far from
// home) before it resumes its usual patrol wander
const idleBranch: BTNode<SoldierCtx> = action((ctx) => {
  const { state, colonist, now, walkable } = ctx;

  const alarmSrc = nearestAlarmSource(state, colonist.tileX, colonist.tileY, SOLDIER_ALERT_SCENT_RADIUS);
  if (alarmSrc) {
    colonist.alertTarget = alarmSrc;
    colonist.path = [];
    return;
  }

  const nearNest = nestDistance(state, colonist.tileX, colonist.tileY) <= effectiveNestFoodRadius(state);
  if (!nearNest) { stepTowardNest(ctx); return; }

  if (now >= colonist.nextWanderAt && colonist.path.length === 0) {
    const tx = state.nest.x + Math.floor(Math.random() * (SOLDIER_PATROL_RADIUS * 2 + 1)) - SOLDIER_PATROL_RADIUS;
    const ty = state.nest.y + Math.floor(Math.random() * (SOLDIER_PATROL_RADIUS * 2 + 1)) - SOLDIER_PATROL_RADIUS;
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
});

const soldierTree: BTNode<SoldierCtx> = selector(attackingBranch, followingAlertScentBranch, idleBranch);

export function updateSoldier(state: GameState, hud: HudRefs, colonist: Colonist, now: number, walkable: Walkable): void {
  soldierTree({ state, hud, colonist, now, walkable });
}
