// GameState lifecycle and terrain/entity-occupancy queries. Entity factories
// and generic actor-movement primitives live in entities/entities.ts instead —
// this module never imports them; `createGameState`/`regenerateWorld` take
// `spawnEnemies` as a callback parameter so the two files don't form an
// import cycle (entities/entities.ts imports randomOpenTile/randomOpenTileNear
// from here, one direction only).
import type { GameRefs, GameState, Point } from '../types/types';
import {
  INITIAL_FOOD_COUNT, INITIAL_SEED, MAP_H, MAP_W, NEST_FOOD_RADIUS, PLAYER_MAX_HP,
  SCOUT_DIG_COST, SPAWN_X, SPAWN_Y, TILE,
} from '../constants';
import { buildMap, buildWalls, mulberry32 } from '../worldgen/worldgen';

export function terrainWalkable(state: GameState, x: number, y: number): boolean {
  if (x < 0 || y < 0 || y >= state.map.length || x >= state.map[0].length) return false;
  return true;
}

export function isWall(state: GameState, x: number, y: number): boolean {
  return state.wallSet.has(x + ',' + y);
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

export function countFoodNearNest(state: GameState): number {
  let count = 0;
  for (const f of state.foodItems) if (nestDistance(state, f.x, f.y) <= NEST_FOOD_RADIUS) count++;
  return count;
}

export function playerInNestRadius(state: GameState): boolean {
  return !!state.player.caste && nestDistance(state, state.player.tileX, state.player.tileY) <= NEST_FOOD_RADIUS;
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
// marks every tile crossed while active, and switches off once back home
export function updateScent(state: GameState, actor: { tileX: number; tileY: number; scentActive: boolean; scentOrigin: Point | null }): void {
  if (!actor.scentActive && foodAt(state, actor.tileX, actor.tileY) && nestDistance(state, actor.tileX, actor.tileY) > NEST_FOOD_RADIUS) {
    actor.scentActive = true;
    actor.scentOrigin = { x: actor.tileX, y: actor.tileY };
  }
  if (actor.scentActive) {
    const key = actor.tileX + ',' + actor.tileY;
    state.scentTrail.add(key);
    if (actor.scentOrigin) state.scentTrailSource.set(key, actor.scentOrigin);
  }
  if (actor.scentActive && nestDistance(state, actor.tileX, actor.tileY) <= NEST_FOOD_RADIUS) {
    actor.scentActive = false;
    actor.scentOrigin = null;
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
  state.foodItems.length = 0;
  for (let i = 0; i < INITIAL_FOOD_COUNT; i++) { const s = randomOpenTile(state); if (s) state.foodItems.push(s); }
  spawnEnemies(state);

  state.nest.x = SPAWN_X + 1; state.nest.y = SPAWN_Y;
  state.nest.pendingCaste = null;
  state.nest.incubating = false; state.nest.incubateStart = 0;
  state.colonists.length = 0;

  state.scentTrail.clear();
  state.scentTrailSource.clear();

  const { player } = state;
  player.caste = null;
  player.carryingType = null;
  player.pendingAction = null;
  player.attackTarget = null;
  player.path = [];
  player.scentActive = false;
  player.scentOrigin = null;
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
    nest: { x: SPAWN_X + 1, y: SPAWN_Y, incubating: false, incubateStart: 0, pendingCaste: null },
    player: {
      tileX: SPAWN_X, tileY: SPAWN_Y, px: SPAWN_X * TILE, py: SPAWN_Y * TILE,
      dir: 'down', moving: false, moveStart: 0, moveDur: 240,
      fromX: 0, fromY: 0, toX: 0, toY: 0, path: [],
      caste: null, carryingType: null, pendingAction: null, scentActive: false, scentOrigin: null,
      attackTarget: null, lastAttack: 0,
      hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP, invulnUntil: 0, digTile: null,
    },
    scentTrail: new Set(),
    scentTrailSource: new Map(),
    floatingTexts: [],
    zoomIndex: 0,
    VP_W: 0,
    VP_H: 0,
    mapOpen: false,
    hoveredTile: null,
  };

  for (let i = 0; i < INITIAL_FOOD_COUNT; i++) { const s = randomOpenTile(state); if (s) state.foodItems.push(s); }
  spawnEnemies(state);

  return state;
}
