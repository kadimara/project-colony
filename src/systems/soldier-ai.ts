// Soldier AI: a 4-state finite state machine. Patrolling keeps a soldier
// near the nest (unlike other castes' wander, this one is anchored at the
// nest's position, not the soldier's current position) until it picks up an
// alarm trail, at which point it heads toward the trail's source
// (FollowingAlertScent) and locks onto the first enemy it actually sees
// along the way (Attacking). Combat is always fought to resolution — a
// soldier never retreats on its own HP, unlike Scout/Worker's attack
// interrupt, which this file never checks. Once the enemy is dead it heads
// home (ReturningToNest) and resumes patrol on arrival.
import type { Colonist, Enemy, GameState, HudRefs } from '../types/types';
import {
  COLONIST_AGGRO_RADIUS, COLONIST_ATK_COOLDOWN, COLONIST_ATK_DAMAGE, COLONIST_REPATH_MS,
  COLONIST_WANDER_MAX_MS, COLONIST_WANDER_MIN_MS, SOLDIER_ALERT_SCENT_RADIUS, SOLDIER_PATROL_RADIUS,
} from '../constants';
import { effectiveNestFoodRadius, nearestAlarmSource, nestDistance, randomOpenTileNear, spawnFloatingText } from '../state/state';
import { dirBetween, startStep } from '../entities/entities';
import { bfsToAdjacent, findPath, isAdjacent, type Walkable } from './pathfinding';
import { killEnemy } from './combat';

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

// default guarding/wandering, anchored near the nest rather than wherever
// the soldier currently happens to be
function runPatrolling(state: GameState, colonist: Colonist, now: number, walkable: Walkable): void {
  const alarmSrc = nearestAlarmSource(state, colonist.tileX, colonist.tileY, SOLDIER_ALERT_SCENT_RADIUS);
  if (alarmSrc) {
    colonist.alertTarget = alarmSrc;
    colonist.soldierState = 'followingAlertScent';
    colonist.path = [];
    return;
  }

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
}

// alert trail detected: head toward its source, but peel off toward any
// enemy that comes into sighting range along the way
function runFollowingAlertScent(state: GameState, colonist: Colonist, walkable: Walkable): void {
  const sighted = nearestEnemyTo(state, colonist.tileX, colonist.tileY, COLONIST_AGGRO_RADIUS);
  if (sighted) {
    colonist.aggroTarget = sighted;
    colonist.alertTarget = null;
    colonist.soldierState = 'attacking';
    colonist.path = [];
    return;
  }
  if (!colonist.alertTarget) { colonist.soldierState = 'patrolling'; return; } // trail evaporated
  if (isAdjacent(colonist.tileX, colonist.tileY, colonist.alertTarget.x, colonist.alertTarget.y)) {
    // reached the alarm's source with nothing left to fight — stand down
    colonist.alertTarget = null;
    colonist.soldierState = 'patrolling';
    colonist.path = [];
    return;
  }
  if (colonist.path.length === 0) {
    colonist.path = bfsToAdjacent(colonist.tileX, colonist.tileY, colonist.alertTarget.x, colonist.alertTarget.y, walkable);
    if (colonist.path.length === 0) { colonist.alertTarget = null; colonist.soldierState = 'patrolling'; return; }
  }
  const next = colonist.path.shift()!;
  if (walkable(next.x, next.y)) startStep(colonist, next.x, next.y, dirBetween(colonist.tileX, colonist.tileY, next.x, next.y));
  else colonist.path = [];
}

// engaged in combat until resolved — soldiers do not retreat, so there is
// no HP-based check on the colonist itself here
function runAttacking(state: GameState, hud: HudRefs, colonist: Colonist, now: number, walkable: Walkable): void {
  const t = colonist.aggroTarget;
  if (!t || t.hp <= 0) {
    colonist.aggroTarget = null;
    colonist.soldierState = 'returningToNest';
    colonist.path = [];
    return;
  }
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
}

// combat resolved: head home before resuming patrol
function runReturningToNest(state: GameState, colonist: Colonist, walkable: Walkable): void {
  if (nestDistance(state, colonist.tileX, colonist.tileY) <= effectiveNestFoodRadius(state)) {
    colonist.soldierState = 'patrolling';
    colonist.path = [];
    return;
  }
  if (colonist.path.length === 0) {
    const spot = randomOpenTileNear(state, state.nest.x, state.nest.y, effectiveNestFoodRadius(state) - 1);
    const p = spot ? findPath(colonist.tileX, colonist.tileY, spot.x, spot.y, walkable) : [];
    if (p.length) colonist.path = p; else { colonist.soldierState = 'patrolling'; return; } // can't path home — don't get stuck
  }
  if (colonist.path.length) {
    const next = colonist.path.shift()!;
    if (walkable(next.x, next.y)) startStep(colonist, next.x, next.y, dirBetween(colonist.tileX, colonist.tileY, next.x, next.y));
    else colonist.path = [];
  }
}

export function updateSoldier(state: GameState, hud: HudRefs, colonist: Colonist, now: number, walkable: Walkable): void {
  switch (colonist.soldierState) {
    case 'patrolling': runPatrolling(state, colonist, now, walkable); return;
    case 'followingAlertScent': runFollowingAlertScent(state, colonist, walkable); return;
    case 'attacking': runAttacking(state, hud, colonist, now, walkable); return;
    case 'returningToNest': runReturningToNest(state, colonist, walkable); return;
  }
}
