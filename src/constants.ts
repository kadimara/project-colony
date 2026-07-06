import type { CasteDef, CasteKey, ZoomLevel } from './types/types';

export const TILE = 16;
export const MAP_W = 100;
export const MAP_H = 80;
export const SPAWN_X = Math.floor(MAP_W / 2);
export const SPAWN_Y = Math.floor(MAP_H / 2);
export const INITIAL_SEED = 393845991;

export const CASTES: Record<CasteKey, CasteDef> = {
  worker:  { name: 'Worker',  color: '#d99a3f', edge: '#8f5f1f', moveDur: 240, inset: 3 },
  soldier: { name: 'Soldier', color: '#b23a3a', edge: '#6e2020', moveDur: 260, inset: 1 },
  scout:   { name: 'Scout',   color: '#3fae9e', edge: '#1f6b5f', moveDur: 190, inset: 3 },
};

// each zoom level uses a clean integer CSS scale so tiles stay crisp
export const ZOOM_LEVELS: ZoomLevel[] = [
  { vpw: 13, vph: 9, scale: 4 },   // zoomed in
  { vpw: 17, vph: 12, scale: 3 },  // default
  { vpw: 26, vph: 18, scale: 2 },  // zoomed out
  { vpw: 52, vph: 36, scale: 1 },  // far — for scanning the bigger world
];
export const DEFAULT_ZOOM_INDEX = 1;

export const WORLD_TILE = 4;
export const INITIAL_FOOD_COUNT = 40;

// ---- player ----
export const PLAYER_MAX_HP = 20;
export const PLAYER_HIT_INVULN_MS = 500;
export const PLAYER_RESPAWN_INVULN_MS = 1200;

// ---- soldier attack tuning ----
export const SOLDIER_ATK_DAMAGE = 3;
export const SOLDIER_ATK_COOLDOWN = 650;

// ---- roaming enemies: wander until they see you, then chase and attack ----
export const ENEMY_COUNT = 5;
export const ENEMY_MAX_HP = 10;
export const ENEMY_MOVE_DUR = 280;
export const ENEMY_ATK_DAMAGE = 2;
export const ENEMY_ATK_COOLDOWN = 900;
export const ENEMY_AGGRO_RADIUS = 5;
export const ENEMY_LOSE_AGGRO_MS = 4000;
export const ENEMY_WANDER_MIN_MS = 1200;
export const ENEMY_WANDER_MAX_MS = 3000;
export const ENEMY_WANDER_RADIUS = 4;
export const ENEMY_REPATH_MS = 500;
export const ENEMY_SPAWN_MIN_DIST = 10; // keep initial spawns away from the player's start

// ---- nest: fixed 2x2 structure. Player manually spawns ants here,
// consuming food that must be sitting within NEST_FOOD_RADIUS tiles ----
export const NEST_SIZE = 2;
export const NEST_FOOD_RADIUS = 3;    // (Chebyshev/Euclidean) distance food must be within to fuel a spawn
export const NEST_FOOD_COST = 1;      // 1 ant costs 1 food, consumed from the radius
export const NEST_INCUBATE_MS = 3000; // time between consuming food and the ant appearing
export const MAX_COLONISTS = 15;

// ---- colonists: autonomous NPC ants belonging to the colony ----
export const COLONIST_MAX_HP: Record<CasteKey, number> = { worker: 10, soldier: 16, scout: 8 };
export const COLONIST_MOVE_DUR: Record<CasteKey, number> = { worker: 260, soldier: 280, scout: 200 };
export const COLONIST_ATK_DAMAGE = 3;
export const COLONIST_ATK_COOLDOWN = 700;
export const COLONIST_AGGRO_RADIUS = 5;
export const COLONIST_FORAGE_RADIUS = 12;
export const COLONIST_WANDER_MIN_MS = 1000;
export const COLONIST_WANDER_MAX_MS = 2600;
export const COLONIST_WANDER_RADIUS = 4;
export const COLONIST_REPATH_MS = 500;

export const CASTE_DESCRIPTIONS: Record<CasteKey, string> = {
  worker: 'Pick up and relocate obstacles and food',
  soldier: 'Bigger. Attacks enemies',
  scout: 'Lays a scent trail on the way to anything it finds',
};

export const NEST_CASTE_DESCRIPTIONS: Record<CasteKey, string> = {
  worker: 'Forages food and hauls it back',
  soldier: 'Defends the colony from enemies',
  scout: 'Explores and lays scent trails',
};
