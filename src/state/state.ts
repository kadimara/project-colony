// GameState lifecycle and terrain/entity-occupancy queries. Entity factories
// and generic actor-movement primitives live in entities/entities.ts instead —
// this module never imports them; `createGameState`/`regenerateWorld` take
// `spawnEnemies` as a callback parameter so the two files don't form an
// import cycle (entities/entities.ts imports randomOpenTile/randomOpenTileNear
// from here, one direction only).
import type { FoodItem, GameRefs, GameState, Point, ScentType } from '../types/types';
import {
  ALARM_SCENT_LIFETIME_MS, INITIAL_FOOD_COUNT, INITIAL_SEED, MAP_H, MAP_W, NEST_FOOD_RADIUS,
  NEST_FOOD_RADIUS_PER_LEVEL, PLAYER_MAX_HP, SCENT_TRAIL_LIFETIME_MS, SCOUT_DIG_COST, SPAWN_X, SPAWN_Y, TILE,
} from '../constants';
import { buildMap, buildWalls, mulberry32 } from '../worldgen/worldgen';
import { buildGroundAtlas, patchGroundAtlasTile } from '../render/ground-atlas';

export function terrainWalkable(state: GameState, x: number, y: number): boolean {
  if (x < 0 || y < 0 || y >= state.map.length || x >= state.map[0].length) return false;
  return true;
}

export function isWall(state: GameState, x: number, y: number): boolean {
  return state.wallSet.has(x + ',' + y);
}

export function setWall(state: GameState, x: number, y: number, solid: boolean): void {
  const key = x + ',' + y;
  if (solid) state.wallSet.add(key); else state.wallSet.delete(key);
  patchGroundAtlasTile(state.refs, state.map, x, y, solid);
}

export function obstacleAt(state: GameState, x: number, y: number): Point | null {
  return isWall(state, x, y) ? { x, y } : null;
}

export function foodAt(state: GameState, x: number, y: number) {
  return state.foodItems.find((f) => f.x === x && f.y === y);
}

export function isEnemyAt(state: GameState, x: number, y: number): boolean {
  return state.enemies.some((e) => e.hp > 0 && e.tileX === x && e.tileY === y);
}

export function isColonistAt(state: GameState, x: number, y: number): boolean {
  return state.colonists.some((c) => c.hp > 0 && c.tileX === x && c.tileY === y);
}

export function isPlayerAt(state: GameState, x: number, y: number): boolean {
  return !!state.player.caste && state.player.tileX === x && state.player.tileY === y;
}

export function nestCells(state: GameState): Point[] {
  const { nest } = state;
  return [
    { x: nest.x, y: nest.y }, { x: nest.x + 1, y: nest.y },
    { x: nest.x, y: nest.y + 1 }, { x: nest.x + 1, y: nest.y + 1 },
  ];
}

export function isNestAt(state: GameState, x: number, y: number): boolean {
  return nestCells(state).some((c) => c.x === x && c.y === y);
}

// Euclidean distance from (x,y) to the nearest occupied nest tile — used
// for the food-fueling radius, which renders as a circular zone
export function nestDistance(state: GameState, x: number, y: number): number {
  let best = Infinity;
  for (const c of nestCells(state)) {
    const d = Math.hypot(x - c.x, y - c.y);
    if (d < best) best = d;
  }
  return best;
}

// the nest's food-catchment radius grows with its level, per idle workers
// relocating wall tiles nearby (see findNestExpansionTarget) — NEST_FOOD_RADIUS
// itself stays the level-0 base value
export function effectiveNestFoodRadius(state: GameState): number {
  return NEST_FOOD_RADIUS + state.nest.level * NEST_FOOD_RADIUS_PER_LEVEL;
}

export function countFoodNearNest(state: GameState): number {
  let count = 0;
  for (const f of state.foodItems) if (nestDistance(state, f.x, f.y) <= effectiveNestFoodRadius(state)) count++;
  return count;
}

export function playerInNestRadius(state: GameState): boolean {
  return !!state.player.caste && nestDistance(state, state.player.tileX, state.player.tileY) <= effectiveNestFoodRadius(state);
}

export function walkable(state: GameState, x: number, y: number): boolean {
  return terrainWalkable(state, x, y) && !isWall(state, x, y) && !isEnemyAt(state, x, y)
    && !isNestAt(state, x, y) && !isColonistAt(state, x, y) && !isPlayerAt(state, x, y);
}

// cost for a scout (player or colonist) to enter (x,y): open ground is
// cheap, a wall tile can be tunneled through at a steep price, anything
// else (bounds/nest/an entity) stays impassable — a weighted pathfinder
// then naturally prefers all-open routes and only pays to dig when
// there's no cheaper way, or the target is otherwise unreachable at all
export function scoutCost(state: GameState, x: number, y: number): number | null {
  if (!terrainWalkable(state, x, y)) return null;
  if (isEnemyAt(state, x, y) || isNestAt(state, x, y) || isColonistAt(state, x, y) || isPlayerAt(state, x, y)) return null;
  return isWall(state, x, y) ? SCOUT_DIG_COST : 1;
}

// call once per tick for any scout (player or colonist) at its current tile:
// turns scent on the moment it finds food outside the nest's own radius,
// marks every tile crossed while active (stamping/refreshing its lay time so
// it decays from the tail as it ages — see pruneScentTrail), and switches off
// once back home. Also used to keep laying an alarm trail once triggerAlarm
// has turned scentActive on for that reason instead — this function doesn't
// care which flavor is active, it just keeps stamping whatever scentType is
// already set until arrival clears it. While an active food trail is being
// laid, any further food tile the actor happens to cross (not sought out,
// just stepped on) gets appended to scentOrigins too, so the resulting trail
// can report more than one food location.
export function updateScent(state: GameState, actor: { tileX: number; tileY: number; scentActive: boolean; scentOrigins: Point[]; scentType: ScentType | null }, now: number): void {
  if (actor.scentActive && actor.scentType === 'food') {
    const food = foodAt(state, actor.tileX, actor.tileY);
    if (food && nestDistance(state, food.x, food.y) > effectiveNestFoodRadius(state)
        && !actor.scentOrigins.some((o) => o.x === food.x && o.y === food.y)) {
      actor.scentOrigins.push({ x: food.x, y: food.y });
    }
  } else if (!actor.scentActive && foodAt(state, actor.tileX, actor.tileY) && nestDistance(state, actor.tileX, actor.tileY) > effectiveNestFoodRadius(state)) {
    actor.scentActive = true;
    actor.scentOrigins = [{ x: actor.tileX, y: actor.tileY }];
    actor.scentType = 'food';
  }
  if (actor.scentActive) {
    const key = actor.tileX + ',' + actor.tileY;
    state.scentTrail.set(key, now);
    if (actor.scentOrigins.length) state.scentTrailSource.set(key, actor.scentOrigins.slice());
    if (actor.scentType) state.scentTrailType.set(key, actor.scentType);
  }
  if (actor.scentActive && nestDistance(state, actor.tileX, actor.tileY) <= effectiveNestFoodRadius(state)) {
    actor.scentActive = false;
    actor.scentOrigins = [];
    actor.scentType = null;
  }
}

// called when a scout/worker is attacked or sights an enemy: immediately
// starts an alarm trail at the actor's current tile, the same way
// updateScent's food branch starts a food trail — a subsequent updateScent
// call each tick then keeps stamping it (and clears it on arrival) exactly
// like the food case. Alarm trails always report a single origin (the
// trigger point), unlike food trails.
export function triggerAlarm(state: GameState, actor: { tileX: number; tileY: number; scentActive: boolean; scentOrigins: Point[]; scentType: ScentType | null }, now: number): void {
  actor.scentActive = true;
  actor.scentOrigins = [{ x: actor.tileX, y: actor.tileY }];
  actor.scentType = 'alarm';
  const key = actor.tileX + ',' + actor.tileY;
  state.scentTrail.set(key, now);
  state.scentTrailSource.set(key, actor.scentOrigins.slice());
  state.scentTrailType.set(key, 'alarm');
}

// drop any trail tile that hasn't been (re-)walked within its lifetime —
// called once per frame regardless of whether any scout is currently active.
// alarm tiles use a much shorter lifetime than food tiles (see
// ALARM_SCENT_LIFETIME_MS) so a stale danger signal doesn't keep pulling
// soldiers toward a long-gone threat.
export function pruneScentTrail(state: GameState, now: number): void {
  for (const [key, laidAt] of state.scentTrail) {
    const lifetime = state.scentTrailType.get(key) === 'alarm' ? ALARM_SCENT_LIFETIME_MS : SCENT_TRAIL_LIFETIME_MS;
    if (now - laidAt > lifetime) {
      state.scentTrail.delete(key);
      state.scentTrailSource.delete(key);
      state.scentTrailType.delete(key);
    }
  }
}

export function randomOpenTile(state: GameState): Point | null {
  for (let tries = 0; tries < 300; tries++) {
    const x = 1 + Math.floor(state.rng() * (MAP_W - 2));
    const y = 1 + Math.floor(state.rng() * (MAP_H - 2));
    if (!isWall(state, x, y) && !foodAt(state, x, y) && !isEnemyAt(state, x, y)
      && !isNestAt(state, x, y) && !isColonistAt(state, x, y) && !isPlayerAt(state, x, y)) return { x, y };
  }
  return null;
}

export function randomOpenTileNear(state: GameState, cx: number, cy: number, radius: number): Point | null {
  for (let tries = 0; tries < 40; tries++) {
    const x = cx + Math.floor(Math.random() * (radius * 2 + 1)) - radius;
    const y = cy + Math.floor(Math.random() * (radius * 2 + 1)) - radius;
    if (walkable(state, x, y) && !foodAt(state, x, y)) return { x, y };
  }
  return null;
}

// nearest food within radius of (x,y), excluding food already close enough
// to the nest to fuel spawning and food sitting exactly at (x,y) — the
// latter matters for scouts, which never remove food from state.foodItems,
// so once one is standing on a food tile it must look past that tile to
// notice the next one in a cluster. Scouts also pass excludeScented=true so
// they don't keep re-discovering (and re-round-tripping to) food that
// already has a trail leading to it — that food's already reported; it's a
// worker's job to actually go fetch it, however long that takes. avoidPos
// lets a worker skip a specific food tile it just found unreachable, so it
// tries the next-nearest instead of picking the exact same one right back
// (nearestFoodTo is plain Euclidean distance, with no reachability check).
export function nearestFoodTo(state: GameState, x: number, y: number, radius: number, excludeScented = false, avoidPos?: Point | null): FoodItem | null {
  let best: FoodItem | null = null, bestDist = Infinity;
  for (const f of state.foodItems) {
    if (f.x === x && f.y === y) continue;
    if (nestDistance(state, f.x, f.y) <= effectiveNestFoodRadius(state)) continue;
    if (excludeScented && state.scentTrailSource.has(f.x + ',' + f.y)) continue;
    if (avoidPos && f.x === avoidPos.x && f.y === avoidPos.y) continue;
    const d = Math.hypot(f.x - x, f.y - y);
    if (d <= radius && d < bestDist) { best = f; bestDist = d; }
  }
  return best;
}

// extends a worker's food awareness beyond its forage radius: if a
// scent-trail tile is within range, treat the food at any of that trail's
// origins as spotted too (as long as it's still actually there) — a trail
// can report more than one food location (see updateScent), so this checks
// every origin on the nearest qualifying tile, not just the first
export function nearestFoodViaTrail(state: GameState, x: number, y: number, radius: number): FoodItem | null {
  let best: FoodItem | null = null, bestDist = Infinity;
  for (const key of state.scentTrail.keys()) {
    if (state.scentTrailType.get(key) !== 'food') continue;
    const [tx, ty] = key.split(',').map(Number);
    const d = Math.hypot(tx - x, ty - y);
    if (d > radius || d >= bestDist) continue;
    for (const origin of state.scentTrailSource.get(key) ?? []) {
      if (!foodAt(state, origin.x, origin.y)) continue;
      best = origin; bestDist = d;
    }
  }
  return best;
}

// mirrors nearestFoodViaTrail for the alarm trail: nearest alarm-tagged
// trail tile within radius, returning its stored source point (a location,
// not an item, so no liveness check is needed) — this is what a patrolling
// soldier scans for. Alarm trails always have exactly one origin.
export function nearestAlarmSource(state: GameState, x: number, y: number, radius: number): Point | null {
  let best: Point | null = null, bestDist = Infinity;
  for (const key of state.scentTrail.keys()) {
    if (state.scentTrailType.get(key) !== 'alarm') continue;
    const [tx, ty] = key.split(',').map(Number);
    const d = Math.hypot(tx - x, ty - y);
    if (d > radius || d >= bestDist) continue;
    const origin = state.scentTrailSource.get(key)?.[0];
    if (!origin) continue;
    best = origin; bestDist = d;
  }
  return best;
}

// true for a tile that's open on both ends of one axis and walled on both
// sides of the other — i.e. a straight-through corridor cell rather than a
// genuine frontier. A 1-tile-wide tunnel is walled on both sides for its
// entire length, so every interior tile "borders a wall"; without this
// check findFrontierDropSite would happily wall one of them back up,
// resealing the very passage a worker just dug through (and trapping any
// other colonist using that tunnel behind/ahead of it).
function isThroughCorridorTile(state: GameState, x: number, y: number): boolean {
  const upWall = isWall(state, x, y - 1), downWall = isWall(state, x, y + 1);
  const leftWall = isWall(state, x - 1, y), rightWall = isWall(state, x + 1, y);
  return (!upWall && !downWall && leftWall && rightWall) || (!leftWall && !rightWall && upWall && downWall);
}

// picks a walkable, empty tile that borders at least one wall without being
// a mere pass-through point in a corridor (a genuine "frontier" tile, at the
// edge of open space) and is farther from the nest than (originX,originY) —
// used when a worker needs to relocate a dug-up obstacle block "outward,"
// away from the colony, instead of just resealing the hole it came from or
// blocking the passage it's part of. Same bounded random-sample-then-filter
// shape as randomOpenTileNear, but scans around the dig site rather than the
// nest, and keeps the farthest-out candidate found within the try budget so
// it drifts genuinely outward rather than stopping at the very next
// qualifying tile.
export function findFrontierDropSite(state: GameState, originX: number, originY: number, radius: number): Point | null {
  const originDist = nestDistance(state, originX, originY);
  let best: Point | null = null, bestDist = -Infinity;
  for (let tries = 0; tries < 60; tries++) {
    const x = originX + Math.floor(Math.random() * (radius * 2 + 1)) - radius;
    const y = originY + Math.floor(Math.random() * (radius * 2 + 1)) - radius;
    if (!walkable(state, x, y) || foodAt(state, x, y)) continue;
    // never wall up a tile that's part of a known scent trail — it's a route
    // that needs to stay open, even where it's only a frontier tile *today*
    // (the through-corridor check below is a snapshot at selection time; a
    // tile mid-tunnel can still look like a dead end here if the far side
    // hasn't been dug yet, but placing a wall on any trail tile would sooner
    // or later reseal the passage once digging continues past it)
    if (state.scentTrail.has(x + ',' + y)) continue;
    const bordersWall = isWall(state, x + 1, y) || isWall(state, x - 1, y) || isWall(state, x, y + 1) || isWall(state, x, y - 1);
    if (!bordersWall || isThroughCorridorTile(state, x, y)) continue;
    const d = nestDistance(state, x, y);
    if (d <= originDist) continue;
    if (d > bestDist) { best = { x, y }; bestDist = d; }
  }
  return best;
}

export function spawnFloatingText(state: GameState, entity: { px: number; py: number }, text: string, color: string): void {
  state.floatingTexts.push({ worldX: entity.px + TILE / 2, worldY: entity.py, text, color, born: performance.now() });
}

// rebuilds the whole world in place from a new seed — no reload needed,
// since navigating/rewriting the URL isn't available in this environment.
// Purely mutates state; callers are responsible for refreshing any HUD/DOM.
export function regenerateWorld(state: GameState, newSeed: number, spawnEnemies: (state: GameState) => void): void {
  state.seed = newSeed;
  state.rng = mulberry32(newSeed);

  state.wallSet = buildWalls(newSeed, MAP_W, MAP_H, SPAWN_X, SPAWN_Y);
  buildGroundAtlas(state.refs, state.map, state.wallSet);
  state.foodItems.length = 0;
  for (let i = 0; i < INITIAL_FOOD_COUNT; i++) { const s = randomOpenTile(state); if (s) state.foodItems.push(s); }
  spawnEnemies(state);

  state.nest.x = SPAWN_X + 1; state.nest.y = SPAWN_Y;
  state.nest.pendingCaste = null;
  state.nest.incubating = false; state.nest.incubateStart = 0;
  state.nest.level = 0; state.nest.workProgress = 0;
  state.colonists.length = 0;

  state.scentTrail.clear();
  state.scentTrailSource.clear();
  state.scentTrailType.clear();

  const { player } = state;
  player.caste = null;
  player.carryingType = null;
  player.pendingAction = null;
  player.attackTarget = null;
  player.path = [];
  player.scentActive = false;
  player.scentOrigins = [];
  player.scentType = null;
  player.moving = false;
  player.tileX = SPAWN_X; player.tileY = SPAWN_Y;
  player.px = SPAWN_X * TILE; player.py = SPAWN_Y * TILE;
  player.hp = player.maxHp;
  player.invulnUntil = 0;
  player.digTile = null;
}

export function createGameState(refs: GameRefs, spawnEnemies: (state: GameState) => void): GameState {
  const seed = INITIAL_SEED;
  const rng = mulberry32(seed);
  const map = buildMap(MAP_W, MAP_H);
  const wallSet = buildWalls(seed, MAP_W, MAP_H, SPAWN_X, SPAWN_Y);

  const state: GameState = {
    refs,
    seed,
    rng,
    map,
    wallSet,
    foodItems: [],
    enemies: [],
    colonists: [],
    nest: { x: SPAWN_X + 1, y: SPAWN_Y, incubating: false, incubateStart: 0, pendingCaste: null, level: 0, workProgress: 0 },
    player: {
      tileX: SPAWN_X, tileY: SPAWN_Y, px: SPAWN_X * TILE, py: SPAWN_Y * TILE,
      dir: 'down', moving: false, moveStart: 0, moveDur: 240,
      fromX: 0, fromY: 0, toX: 0, toY: 0, path: [],
      caste: null, carryingType: null, pendingAction: null, scentActive: false, scentOrigins: [], scentType: null,
      attackTarget: null, lastAttack: 0,
      hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP, invulnUntil: 0, digTile: null,
    },
    scentTrail: new Map(),
    scentTrailSource: new Map(),
    scentTrailType: new Map(),
    floatingTexts: [],
    zoomIndex: 0,
    VP_W: 0,
    VP_H: 0,
    mapOpen: false,
    hoveredTile: null,
  };

  buildGroundAtlas(refs, map, wallSet);
  for (let i = 0; i < INITIAL_FOOD_COUNT; i++) { const s = randomOpenTile(state); if (s) state.foodItems.push(s); }
  spawnEnemies(state);

  return state;
}
