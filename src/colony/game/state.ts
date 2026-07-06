// World/entity state: the GameState factory, terrain & occupancy queries,
// entity factories, and the generic actor-movement primitives shared by the
// player, enemies, and colonists. Behavior (AI decisions, player input,
// combat resolution) lives in ai.ts / player-actions.ts / combat.ts — this
// module only knows how to construct and query state, not decide anything.
import type { Actor, CasteKey, Colonist, Dir, Enemy, FloatingText, GameRefs, GameState, Point } from './types';
import {
  COLONIST_MAX_HP, COLONIST_MOVE_DUR, ENEMY_MAX_HP, ENEMY_MOVE_DUR, ENEMY_SPAWN_MIN_DIST,
  ENEMY_COUNT, ENEMY_WANDER_MAX_MS, ENEMY_WANDER_MIN_MS, INITIAL_FOOD_COUNT, INITIAL_SEED,
  MAP_H, MAP_W, MAX_COLONISTS, NEST_FOOD_RADIUS, PLAYER_MAX_HP,
  SPAWN_X, SPAWN_Y, TILE, COLONIST_WANDER_MAX_MS, COLONIST_WANDER_MIN_MS,
} from './constants';
import { buildMap, buildWalls, mulberry32 } from './worldgen';

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

function makeEnemy(x: number, y: number): Enemy {
  return {
    tileX: x, tileY: y, px: x * TILE, py: y * TILE,
    dir: 'down', moving: false, moveStart: 0, moveDur: ENEMY_MOVE_DUR,
    fromX: x, fromY: y, toX: x, toY: y,
    hp: ENEMY_MAX_HP, maxHp: ENEMY_MAX_HP,
    state: 'wander', target: null, path: [],
    nextWanderAt: performance.now() + ENEMY_WANDER_MIN_MS + Math.random() * (ENEMY_WANDER_MAX_MS - ENEMY_WANDER_MIN_MS),
    nextRepathAt: 0, lastAttack: 0, aggroUntil: 0, flashUntil: 0,
  };
}

export function spawnEnemies(state: GameState): void {
  state.enemies.length = 0;
  for (let i = 0; i < ENEMY_COUNT; i++) {
    let spot: Point | null = null;
    for (let tries = 0; tries < 30; tries++) {
      const s = randomOpenTile(state);
      if (!s) break;
      if (Math.hypot(s.x - SPAWN_X, s.y - SPAWN_Y) >= ENEMY_SPAWN_MIN_DIST) { spot = s; break; }
    }
    if (spot) state.enemies.push(makeEnemy(spot.x, spot.y));
  }
}

function makeColonist(caste: CasteKey, x: number, y: number): Colonist {
  return {
    caste, tileX: x, tileY: y, px: x * TILE, py: y * TILE,
    dir: 'down', moving: false, moveStart: 0, moveDur: COLONIST_MOVE_DUR[caste],
    fromX: x, fromY: y, toX: x, toY: y,
    hp: COLONIST_MAX_HP[caste], maxHp: COLONIST_MAX_HP[caste],
    path: [], carryingFood: false, forageTarget: null, aggroTarget: null,
    nextWanderAt: performance.now() + COLONIST_WANDER_MIN_MS + Math.random() * (COLONIST_WANDER_MAX_MS - COLONIST_WANDER_MIN_MS),
    nextRepathAt: 0, lastAttack: 0, aggroUntil: 0, flashUntil: 0,
  };
}

export function spawnColonist(state: GameState, caste: CasteKey): void {
  if (state.colonists.length >= MAX_COLONISTS) return;
  const spot = randomOpenTileNear(state, state.nest.x, state.nest.y, 4) || randomOpenTile(state);
  if (spot) state.colonists.push(makeColonist(caste, spot.x, spot.y));
}

export function spawnFloatingText(state: GameState, entity: { px: number; py: number }, text: string, color: string): void {
  const ft: FloatingText = { worldX: entity.px + TILE / 2, worldY: entity.py, text, color, born: performance.now() };
  state.floatingTexts.push(ft);
}

// ---- generic actor movement primitives (shared by player/enemy/colonist) ----
export function dirBetween(fromX: number, fromY: number, toX: number, toY: number): Dir {
  if (toX > fromX) return 'right';
  if (toX < fromX) return 'left';
  if (toY > fromY) return 'down';
  return 'up';
}

export function startStep(actor: Actor, nx: number, ny: number, dir: Dir): void {
  actor.dir = dir;
  actor.fromX = actor.tileX; actor.fromY = actor.tileY;
  actor.toX = nx; actor.toY = ny;
  actor.tileX = nx; actor.tileY = ny;
  actor.moving = true;
  actor.moveStart = performance.now();
}

export function updateActorAnimation(actor: Actor, now: number): void {
  if (!actor.moving) return;
  const t = Math.min(1, (now - actor.moveStart) / actor.moveDur);
  actor.px = (actor.fromX + (actor.toX - actor.fromX) * t) * TILE;
  actor.py = (actor.fromY + (actor.toY - actor.fromY) * t) * TILE;
  if (t >= 1) {
    actor.moving = false;
    actor.px = actor.toX * TILE; actor.py = actor.toY * TILE;
  }
}

// rebuilds the whole world in place from a new seed — no reload needed,
// since navigating/rewriting the URL isn't available in this environment.
// Purely mutates state; callers are responsible for refreshing any HUD/DOM.
export function regenerateWorld(state: GameState, newSeed: number): void {
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

  const { player } = state;
  player.caste = null;
  player.carryingType = null;
  player.pendingAction = null;
  player.attackTarget = null;
  player.path = [];
  player.pathHistory = [];
  player.moving = false;
  player.tileX = SPAWN_X; player.tileY = SPAWN_Y;
  player.px = SPAWN_X * TILE; player.py = SPAWN_Y * TILE;
  player.hp = player.maxHp;
  player.invulnUntil = 0;
}

export function createGameState(refs: GameRefs): GameState {
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
      caste: null, carryingType: null, pendingAction: null, pathHistory: [],
      attackTarget: null, lastAttack: 0,
      hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP, invulnUntil: 0,
    },
    scentTrail: new Set(),
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
