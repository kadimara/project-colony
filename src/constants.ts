import type { CasteDef, CasteKey, ZoomLevel } from './types/types';

export const TILE = 16;
export const MAP_W = 100;
export const MAP_H = 80;
export const SPAWN_X = Math.floor(MAP_W / 2);
export const SPAWN_Y = Math.floor(MAP_H / 2);
export const INITIAL_SEED = 393845991;

// all three castes share one base move speed (worker's) so no caste is
// simply faster than another outside of situational modifiers (a scout
// digging, or a worker hauling something — see SCOUT_DIG_MOVE_DUR)
export const BASE_MOVE_DUR = 240;

export const CASTES: Record<CasteKey, CasteDef> = {
  worker: {
    name: 'Worker',
    color: '#d99a3f',
    edge: '#8f5f1f',
    moveDur: BASE_MOVE_DUR,
    inset: 3,
  },
  soldier: {
    name: 'Soldier',
    color: '#b23a3a',
    edge: '#6e2020',
    moveDur: BASE_MOVE_DUR,
    inset: 1,
  },
  scout: {
    name: 'Scout',
    color: '#3fae9e',
    edge: '#1f6b5f',
    moveDur: BASE_MOVE_DUR,
    inset: 3,
  },
};

// vpw × vph tiles visible at each zoom level — kept square (vpw === vph) so
// the on-screen canvas is always a square that can be fit to the viewport
export const ZOOM_LEVELS: ZoomLevel[] = [
  { vpw: 16, vph: 16 }, // zoomed in
  { vpw: 21, vph: 21 }, // default
  { vpw: 32, vph: 32 }, // zoomed out
  { vpw: 64, vph: 64 }, // far
];
export const DEFAULT_ZOOM_INDEX = 1;

export const WORLD_TILE = 4;
export const INITIAL_FOOD_COUNT = 100;

// ---- player ----
export const PLAYER_MAX_HP = 20;
export const PLAYER_HIT_INVULN_MS = 500;
export const PLAYER_RESPAWN_INVULN_MS = 1200;

// ---- soldier attack tuning ----
export const SOLDIER_ATK_DAMAGE = 3;
export const SOLDIER_ATK_COOLDOWN = 650;

// ---- roaming enemies: wander until they see you, then chase and attack ----
export const ENEMY_COUNT = 0;
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
// consuming food that must be sitting within effectiveNestFoodRadius tiles ----
export const NEST_SIZE = 2;
export const NEST_FOOD_COST = 1; // 1 ant costs 1 food, consumed from the radius
export const NEST_INCUBATE_MS = 3000; // time between consuming food and the ant appearing
export const MAX_COLONISTS = 30;

// the food radius is derived (see effectiveNestFoodRadius) from a target
// *tile count*, not a target distance — the rendered food zone is a filled
// area, and a linear-in-population tile count is what keeps that area's
// visible growth linear. Target total tiles (including the nest's own
// NEST_SIZE x NEST_SIZE footprint) = colonists.length * NEST_TOTAL_TILES_PER_COLONIST,
// floored so population 0 still has NEST_FREE_TILES_FLOOR free tiles (a
// literal 0 would be a soft-lock — nest tiles are unwalkable, so no food
// could ever sit at exactly distance 0)
export const NEST_TOTAL_TILES_PER_COLONIST = 3;
export const NEST_FREE_TILES_FLOOR = 8;

// ---- colonists: autonomous NPC ants belonging to the colony ----
export const COLONIST_MAX_HP: Record<CasteKey, number> = {
  worker: 10,
  soldier: 16,
  scout: 8,
};
// colonist AI shares one base move speed too, using the worker's prior value
export const COLONIST_BASE_MOVE_DUR = 260;
export const COLONIST_MOVE_DUR: Record<CasteKey, number> = {
  worker: COLONIST_BASE_MOVE_DUR,
  soldier: COLONIST_BASE_MOVE_DUR,
  scout: COLONIST_BASE_MOVE_DUR,
};
export const COLONIST_ATK_DAMAGE = 3;
export const COLONIST_ATK_COOLDOWN = 700;
export const COLONIST_AGGRO_RADIUS = 5;
export const COLONIST_FORAGE_RADIUS = 12;
export const COLONIST_WANDER_MIN_MS = 1000;
export const COLONIST_WANDER_MAX_MS = 2600;
export const COLONIST_REPATH_MS = 500;

// ---- soldiers: patrol near the nest until an alarm trail leads them to a fight ----
export const SOLDIER_PATROL_RADIUS = 6; // how far from the nest a patrolling soldier wanders
export const SOLDIER_ALERT_SCENT_RADIUS = 12; // scan range for detecting an alarm-tagged trail tile

// how far out to flood-fill when a worker looks for a frontier tile (open
// ground bordering a wall) to relocate a dug-up obstacle block to — see
// findFrontierDropSite
export const WORKER_FRONTIER_SEARCH_RADIUS = 10;

// how far a worker carrying a wall block wanders while no frontier drop site
// is found, so it doesn't sit frozen in the middle of a tunnel blocking
// everyone else — deliberately tighter than SOLDIER_PATROL_RADIUS since this
// is just "get out of the way," not an actual patrol
export const WORKER_WANDER_RADIUS = 3;

// ---- scouts: roam far from the nest, detour toward any food that comes
// within COLONIST_FORAGE_RADIUS, then commit to a straight shot back to the
// nest laying scent the whole way once they find it — a player-controlled
// scout gets the same scent on/off toggle but is never auto-piloted there ----
export const SCOUT_EXPLORE_MIN_DIST = 8;
export const SCOUT_EXPLORE_MAX_DIST = 20;

// scouts can tunnel through a wall tile (removing it, then restoring it once
// they've moved past) to reach pockets otherwise sealed off entirely — the
// weighted pathfinder only pays this cost when there's no cheaper all-open
// route, or the destination is unreachable any other way
export const SCOUT_DIG_COST = 10;
export const SCOUT_DIG_MOVE_DUR = COLONIST_MOVE_DUR.scout * 3;

// alarm trails fade after this long — a stale danger signal is worse than a
// stale food lead, since it keeps pulling soldiers off patrol toward a
// threat that's long since moved on or been dealt with. Food trails don't
// decay by time at all; they're only cleared once their food is picked up.
export const ALARM_SCENT_LIFETIME_MS = 20000;

// how far a scout can spot an enemy at, with line of sight required (no
// seeing through walls) — see handleEnemySighted in scout-ai.ts
export const SCOUT_VISION_RADIUS = 6;

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
