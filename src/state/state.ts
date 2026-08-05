// GameState lifecycle and terrain/entity-occupancy queries. Entity factories
// and generic actor-movement primitives live in entities/entities.ts instead —
// this module never imports them; `createGameState`/`regenerateWorld` take
// `spawnEnemies` as a callback parameter so the two files don't form an
// import cycle (entities/entities.ts imports randomOpenTile/randomOpenTileNear
// from here, one direction only).
import type {
  CarryType,
  Colonist,
  FoodItem,
  GameRefs,
  GameState,
  Point,
  ScentType,
} from '../types/types';
import {
  ALARM_SCENT_LIFETIME_MS,
  INITIAL_FOOD_COUNT,
  INITIAL_SEED,
  MAP_H,
  MAP_W,
  MAX_COLONISTS,
  NEST_FOOD_RADIUS_MAX,
  NEST_FOOD_RADIUS_MIN,
  PLAYER_MAX_HP,
  SCOUT_DIG_COST,
  SPAWN_X,
  SPAWN_Y,
  TILE,
} from '../constants';
import { buildMap, buildWalls, mulberry32 } from '../worldgen/worldgen';
import { buildGroundAtlas, patchGroundAtlasTile } from '../render/ground-atlas';
import { findWeightedPath } from '../systems/pathfinding';

export function terrainWalkable(
  state: GameState,
  x: number,
  y: number,
): boolean {
  if (x < 0 || y < 0 || y >= state.map.length || x >= state.map[0].length)
    return false;
  return true;
}

export function isWall(state: GameState, x: number, y: number): boolean {
  return state.wallSet.has(x + ',' + y);
}

export function setWall(
  state: GameState,
  x: number,
  y: number,
  solid: boolean,
): void {
  const key = x + ',' + y;
  if (solid) {
    state.wallSet.add(key);
    // flag this wall as worker-diggable if it's within the nest's food
    // radius, and/or if it's resealing a tile that still has a live scent
    // trail on it (the scout tunnel-and-reseal case: a scout digs through,
    // walks onto the open tile — stamping a scent trail there — then this
    // same call reseals it on the next step, so the trail and the resealed
    // wall coincide). A wall can land in both sets.
    if (isNestRadiusWall(state, x, y)) state.nestWallsToDig.add(key);
    if (state.scentTrail.has(key)) state.trailWallsToDig.add(key);
  } else {
    state.wallSet.delete(key);
    state.nestWallsToDig.delete(key);
    state.trailWallsToDig.delete(key);
    // removing any wall can reopen a route to others that were previously
    // unreachable, so a full clear (rather than tracking exactly which
    // entries it affects) is the simplest correct invalidation
    state.unreachableWalls.clear();
  }
  patchGroundAtlasTile(state.refs, state.map, x, y, solid);
}

export function obstacleAt(
  state: GameState,
  x: number,
  y: number,
): Point | null {
  return isWall(state, x, y) ? { x, y } : null;
}

export function foodAt(state: GameState, x: number, y: number) {
  return state.foodItems.find((f) => f.x === x && f.y === y);
}

export function isEnemyAt(state: GameState, x: number, y: number): boolean {
  return state.enemies.some((e) => e.hp > 0 && e.tileX === x && e.tileY === y);
}

export function isColonistAt(state: GameState, x: number, y: number): boolean {
  return state.colonists.some(
    (c) => c.hp > 0 && c.tileX === x && c.tileY === y,
  );
}

export function isPlayerAt(state: GameState, x: number, y: number): boolean {
  return (
    !!state.player.caste && state.player.tileX === x && state.player.tileY === y
  );
}

export function nestCells(state: GameState): Point[] {
  const { nest } = state;
  return [
    { x: nest.x, y: nest.y },
    { x: nest.x + 1, y: nest.y },
    { x: nest.x, y: nest.y + 1 },
    { x: nest.x + 1, y: nest.y + 1 },
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

// the nest's food-catchment radius scales with colony size: a floor of
// NEST_FOOD_RADIUS_MIN tiles at population 0, growing to NEST_FOOD_RADIUS_MAX
// at MAX_COLONISTS. Growing the colony visibly pays off in reach.
export function effectiveNestFoodRadius(state: GameState): number {
  return Math.max(
    NEST_FOOD_RADIUS_MIN,
    (state.colonists.length / MAX_COLONISTS) * NEST_FOOD_RADIUS_MAX,
  );
}

// true if (x,y) lies within the nest's current food-catchment radius — the
// one place this rule lives, shared by setWall's live nestWallsToDig check
// and the worldgen population pass below, so they can't drift apart
function isNestRadiusWall(state: GameState, x: number, y: number): boolean {
  return nestDistance(state, x, y) <= effectiveNestFoodRadius(state);
}

// scans the whole wallSet once and flags every nest-radius wall into
// nestWallsToDig — needed because createGameState/regenerateWorld build
// wallSet directly from worldgen (buildWalls), bypassing setWall entirely,
// so nothing else would populate it for the starting map. No scent trail
// exists yet at this point, so trailWallsToDig needs no equivalent pass.
export function populateWallsToDigNearNest(state: GameState): void {
  for (const key of state.wallSet) {
    const [x, y] = key.split(',').map(Number);
    if (isNestRadiusWall(state, x, y)) state.nestWallsToDig.add(key);
  }
}

// effectiveNestFoodRadius now tracks colonists.length, which changes on
// every spawn/death — but nestWallsToDig is event-driven (see comment on
// GameState.nestWallsToDig), so a population change alone won't re-flag
// walls that just entered or left the radius. Callers that change
// colonists.length must call this afterward to keep the two in sync.
export function refreshNestWallsToDig(state: GameState): void {
  state.nestWallsToDig.clear();
  populateWallsToDigNearNest(state);
}

export function countFoodNearNest(state: GameState): number {
  let count = 0;
  for (const f of state.foodItems)
    if (nestDistance(state, f.x, f.y) <= effectiveNestFoodRadius(state))
      count++;
  return count;
}

export function playerInNestRadius(state: GameState): boolean {
  return (
    !!state.player.caste &&
    nestDistance(state, state.player.tileX, state.player.tileY) <=
      effectiveNestFoodRadius(state)
  );
}

export function walkable(state: GameState, x: number, y: number): boolean {
  return (
    terrainWalkable(state, x, y) &&
    !isWall(state, x, y) &&
    !isEnemyAt(state, x, y) &&
    !isNestAt(state, x, y) &&
    !isColonistAt(state, x, y) &&
    !isPlayerAt(state, x, y)
  );
}

// like walkable, but ignores mobile actors (colonists/enemies/player) —
// only terrain, walls, and the nest itself make a tile impassable. Used to
// tell "structurally walled off" apart from "just someone standing in the
// way right now" before permanently blacklisting a target into
// unreachableWalls: a route that only fails the actor-aware walkable check
// is a traffic jam, not a real dead end, and should be retried rather than
// blacklisted.
export function walkableIgnoringActors(
  state: GameState,
  x: number,
  y: number,
): boolean {
  return (
    terrainWalkable(state, x, y) &&
    !isWall(state, x, y) &&
    !isNestAt(state, x, y)
  );
}

// cost for a scout (player or colonist) to enter (x,y): open ground is
// cheap, a wall tile can be tunneled through at a steep price, anything
// else (bounds/nest/an entity) stays impassable — a weighted pathfinder
// then naturally prefers all-open routes and only pays to dig when
// there's no cheaper way, or the target is otherwise unreachable at all
export function scoutCost(
  state: GameState,
  x: number,
  y: number,
): number | null {
  if (!terrainWalkable(state, x, y)) return null;
  if (
    isEnemyAt(state, x, y) ||
    isNestAt(state, x, y) ||
    isColonistAt(state, x, y) ||
    isPlayerAt(state, x, y)
  )
    return null;
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
export function updateScent(
  state: GameState,
  actor: {
    tileX: number;
    tileY: number;
    scentActive: boolean;
    scentOrigins: Point[];
    scentType: ScentType | null;
  },
  now: number,
): void {
  if (actor.scentActive && actor.scentType === 'food') {
    const food = foodAt(state, actor.tileX, actor.tileY);
    if (
      food &&
      nestDistance(state, food.x, food.y) > effectiveNestFoodRadius(state) &&
      !actor.scentOrigins.some((o) => o.x === food.x && o.y === food.y)
    ) {
      actor.scentOrigins.push({ x: food.x, y: food.y });
    }
  } else if (
    !actor.scentActive &&
    foodAt(state, actor.tileX, actor.tileY) &&
    nestDistance(state, actor.tileX, actor.tileY) >
      effectiveNestFoodRadius(state)
  ) {
    actor.scentActive = true;
    actor.scentOrigins = [{ x: actor.tileX, y: actor.tileY }];
    actor.scentType = 'food';
  }
  if (actor.scentActive) {
    const key = actor.tileX + ',' + actor.tileY;
    state.scentTrail.set(key, now);
    if (actor.scentOrigins.length)
      state.scentTrailSource.set(key, actor.scentOrigins.slice());
    if (actor.scentType) state.scentTrailType.set(key, actor.scentType);
  }
  if (
    actor.scentActive &&
    nestDistance(state, actor.tileX, actor.tileY) <=
      effectiveNestFoodRadius(state)
  ) {
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
export function triggerAlarm(
  state: GameState,
  actor: {
    tileX: number;
    tileY: number;
    scentActive: boolean;
    scentOrigins: Point[];
    scentType: ScentType | null;
  },
  now: number,
): void {
  actor.scentActive = true;
  actor.scentOrigins = [{ x: actor.tileX, y: actor.tileY }];
  actor.scentType = 'alarm';
  const key = actor.tileX + ',' + actor.tileY;
  state.scentTrail.set(key, now);
  state.scentTrailSource.set(key, actor.scentOrigins.slice());
  state.scentTrailType.set(key, 'alarm');
}

// drop any *alarm* trail tile that hasn't been (re-)walked within its
// lifetime — called once per frame regardless of whether any scout is
// currently active. Food trails no longer decay by time; they're only
// cleared via removeScentTrailForFood once their food is picked up.
export function pruneScentTrail(state: GameState, now: number): void {
  for (const [key, laidAt] of state.scentTrail) {
    if (state.scentTrailType.get(key) !== 'alarm') continue;
    // pinned: a wall currently sits on this trail tile and still needs
    // digging (see setWall) — don't let it decay until that wall is cleared,
    // at which point the key leaves trailWallsToDig and the pin lifts
    // naturally
    if (state.trailWallsToDig.has(key)) continue;
    if (now - laidAt > ALARM_SCENT_LIFETIME_MS) {
      state.scentTrail.delete(key);
      state.scentTrailSource.delete(key);
      state.scentTrailType.delete(key);
    }
  }
}

// called when a food item is picked up: clears every trail tile that reports
// this food's position as one of its origins, leaving trails to any other
// food untouched. This is now the only way a food-type trail tile goes away.
export function removeScentTrailForFood(
  state: GameState,
  x: number,
  y: number,
): void {
  for (const key of state.scentTrail.keys()) {
    const origins = state.scentTrailSource.get(key);
    if (origins && origins.some((o) => o.x === x && o.y === y)) {
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
    if (
      !isWall(state, x, y) &&
      !foodAt(state, x, y) &&
      !isEnemyAt(state, x, y) &&
      !isNestAt(state, x, y) &&
      !isColonistAt(state, x, y) &&
      !isPlayerAt(state, x, y)
    )
      return { x, y };
  }
  return null;
}

export function randomOpenTileNear(
  state: GameState,
  cx: number,
  cy: number,
  radius: number,
): Point | null {
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
export function nearestFoodTo(
  state: GameState,
  x: number,
  y: number,
  radius: number,
  excludeScented = false,
  avoidPos?: Point | null,
  exclude?: Set<string>,
): FoodItem | null {
  let best: FoodItem | null = null,
    bestDist = Infinity;
  for (const f of state.foodItems) {
    if (f.x === x && f.y === y) continue;
    if (nestDistance(state, f.x, f.y) <= effectiveNestFoodRadius(state))
      continue;
    if (excludeScented && state.scentTrailSource.has(f.x + ',' + f.y)) continue;
    if (avoidPos && f.x === avoidPos.x && f.y === avoidPos.y) continue;
    if (exclude && exclude.has(f.x + ',' + f.y)) continue;
    const d = Math.hypot(f.x - x, f.y - y);
    if (d <= radius && d < bestDist) {
      best = f;
      bestDist = d;
    }
  }
  return best;
}

// extends a worker's food awareness beyond its forage radius: if a
// scent-trail tile is within range, treat the food at any of that trail's
// origins as spotted too (as long as it's still actually there) — a trail
// can report more than one food location (see updateScent), so this checks
// every origin on the nearest qualifying tile, not just the first
export function nearestFoodViaTrail(
  state: GameState,
  x: number,
  y: number,
  radius: number,
  exclude?: Set<string>,
): FoodItem | null {
  let best: FoodItem | null = null,
    bestDist = Infinity;
  for (const key of state.scentTrail.keys()) {
    if (state.scentTrailType.get(key) !== 'food') continue;
    const [tx, ty] = key.split(',').map(Number);
    const d = Math.hypot(tx - x, ty - y);
    if (d > radius || d >= bestDist) continue;
    for (const origin of state.scentTrailSource.get(key) ?? []) {
      if (!foodAt(state, origin.x, origin.y)) continue;
      if (exclude && exclude.has(origin.x + ',' + origin.y)) continue;
      best = origin;
      bestDist = d;
    }
  }
  return best;
}

// every other live colonist's currently-claimed forage target (worker or
// scout — both use forageTarget), keyed "x,y" — lets a target-picking query
// skip food someone else is already en route to instead of every idle
// colonist converging on the single globally-nearest item
export function claimedForageTargets(
  state: GameState,
  exceptColonist?: Colonist,
): Set<string> {
  const claimed = new Set<string>();
  for (const c of state.colonists) {
    if (c === exceptColonist || !c.forageTarget || c.hp <= 0) continue;
    claimed.add(c.forageTarget.x + ',' + c.forageTarget.y);
  }
  return claimed;
}

// places a food item at (tx,ty), falling back to a neighboring open tile if
// that exact spot is occupied — the same "drop it here, or nearby" shape as
// combat.ts's dropFoodOnDeath, reused so a carried item never has nowhere to go
export function placeFoodNear(
  state: GameState,
  tx: number,
  ty: number,
): boolean {
  // the origin tile is where the dropping actor itself is standing, so its
  // own occupancy there doesn't make it "taken" — only ring tiles need the
  // colonist/player occupancy check, otherwise dropping at (tx,ty) always
  // fails (the actor is always standing there) and pushes the item onto a
  // ring tile instead, which for a worker unloading near the nest can land
  // just outside the nest's food radius and get picked back up next tick
  const freeAt = (x: number, y: number, isOrigin: boolean) =>
    terrainWalkable(state, x, y) &&
    !isWall(state, x, y) &&
    !foodAt(state, x, y) &&
    !isEnemyAt(state, x, y) &&
    !isNestAt(state, x, y) &&
    (isOrigin || !isColonistAt(state, x, y)) &&
    (isOrigin || !isPlayerAt(state, x, y));
  let dropX = tx,
    dropY = ty;
  if (!freeAt(dropX, dropY, true)) {
    const ring = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ];
    let placed = false;
    for (const [dx, dy] of ring) {
      if (freeAt(tx + dx, ty + dy, false)) {
        dropX = tx + dx;
        dropY = ty + dy;
        placed = true;
        break;
      }
    }
    if (!placed) return false;
  }
  state.foodItems.push({ x: dropX, y: dropY });
  return true;
}

// restores whatever a colonist is carrying to the world before clearing the
// flag — an attack interrupt or death should never simply delete a held item,
// mirroring player-actions.ts's applyCaste "drop it where you stand" pattern
export function dropCarried(
  state: GameState,
  colonist: { tileX: number; tileY: number; carrying: CarryType | null },
): void {
  if (colonist.carrying === 'obstacle') {
    if (
      !isWall(state, colonist.tileX, colonist.tileY) &&
      !foodAt(state, colonist.tileX, colonist.tileY)
    ) {
      setWall(state, colonist.tileX, colonist.tileY, true);
    }
  } else if (colonist.carrying === 'food') {
    placeFoodNear(state, colonist.tileX, colonist.tileY);
  }
  colonist.carrying = null;
}

// mirrors nearestFoodViaTrail for the alarm trail: nearest alarm-tagged
// trail tile within radius, returning its stored source point (a location,
// not an item, so no liveness check is needed) — this is what a patrolling
// soldier scans for. Alarm trails always have exactly one origin.
export function nearestAlarmSource(
  state: GameState,
  x: number,
  y: number,
  radius: number,
): Point | null {
  let best: Point | null = null,
    bestDist = Infinity;
  for (const key of state.scentTrail.keys()) {
    if (state.scentTrailType.get(key) !== 'alarm') continue;
    const [tx, ty] = key.split(',').map(Number);
    const d = Math.hypot(tx - x, ty - y);
    if (d > radius || d >= bestDist) continue;
    const origin = state.scentTrailSource.get(key)?.[0];
    if (!origin) continue;
    best = origin;
    bestDist = d;
  }
  return best;
}

// true for a tile that's a genuine 1-tile-wide bottleneck: either a
// straight-through corridor cell (opposite sides open, walled on the other
// axis) or a bend (two adjacent sides open, walled on the other two) where
// the diagonal tile between the two open sides is *also* a wall. Movement is
// 4-directional only (see pathfinding.ts), so at a bend the two open sides
// are only actually cut off from each other by this tile when that diagonal
// has no bypass — if the diagonal tile is walkable, the two open sides
// already connect around the corner in two orthogonal steps, so this tile
// isn't a bottleneck at all (e.g. the corner of a wider room) and is safe to
// wall up.
function isThroughCorridorTile(
  state: GameState,
  x: number,
  y: number,
): boolean {
  const upWall = isWall(state, x, y - 1),
    downWall = isWall(state, x, y + 1);
  const leftWall = isWall(state, x - 1, y),
    rightWall = isWall(state, x + 1, y);
  if (upWall && downWall && !leftWall && !rightWall) return true;
  if (leftWall && rightWall && !upWall && !downWall) return true;
  if (upWall && leftWall && !downWall && !rightWall)
    return isWall(state, x + 1, y + 1);
  if (upWall && rightWall && !downWall && !leftWall)
    return isWall(state, x - 1, y + 1);
  if (downWall && leftWall && !upWall && !rightWall)
    return isWall(state, x + 1, y - 1);
  if (downWall && rightWall && !upWall && !leftWall)
    return isWall(state, x - 1, y - 1);
  return false;
}

// true for a tile a worker is allowed to drop a dug-up wall block on: walkable,
// empty, not part of a known scent trail (never wall up a route that needs to
// stay open, even where it's only a frontier tile *today* — a tile mid-tunnel
// can still look like a dead end here if the far side hasn't been dug yet, but
// placing a wall on any trail tile would sooner or later reseal the passage
// once digging continues past it), outside the nest's food-catchment radius
// (that area needs to stay clear, not get walled back in), borders at least
// two walls, and isn't a through-corridor bottleneck (see
// isThroughCorridorTile — covers both straight runs and true bends). Shared
// by findFrontierDropSite and the F12 debug overlay so both agree on what
// counts as a valid drop site.
export function isFrontierDropCandidate(
  state: GameState,
  x: number,
  y: number,
): boolean {
  if (!walkable(state, x, y) || foodAt(state, x, y)) return false;
  if (state.scentTrail.has(x + ',' + y)) return false;
  if (isNestRadiusWall(state, x, y)) return false;
  const wallNeighbors =
    (isWall(state, x + 1, y) ? 1 : 0) +
    (isWall(state, x - 1, y) ? 1 : 0) +
    (isWall(state, x, y + 1) ? 1 : 0) +
    (isWall(state, x, y - 1) ? 1 : 0);
  if (wallNeighbors < 2 || isThroughCorridorTile(state, x, y)) return false;
  return true;
}

// picks a qualifying frontier tile (see isFrontierDropCandidate) that is also
// farther from the nest than (originX,originY) — used when a worker needs to
// relocate a dug-up obstacle block "outward," away from the colony, instead
// of just resealing the hole it came from or blocking the passage it's part
// of. Flood-fills outward from the origin over already-walkable tiles only
// (bounded to a `radius`-tile box), so it never wastes effort probing wall
// tiles the way blind random sampling did, and — since it only ever steps
// onto walkable ground — every candidate it finds is guaranteed reachable by
// foot, unlike a random (x,y) pick that might sit behind an undug wall.
// Keeps the farthest-out qualifying tile found so the block drifts genuinely
// outward rather than settling for the first one seen.
export function findFrontierDropSite(
  state: GameState,
  originX: number,
  originY: number,
  radius: number,
): Point | null {
  const originDist = nestDistance(state, originX, originY);
  const key = (x: number, y: number) => x + ',' + y;
  const visited = new Set<string>([key(originX, originY)]);
  const queue: Point[] = [{ x: originX, y: originY }];
  let head = 0;
  const dirs = [
    [0, -1],
    [0, 1],
    [-1, 0],
    [1, 0],
  ];
  let best: Point | null = null,
    bestDist = -Infinity;
  while (head < queue.length) {
    const cur = queue[head++];
    for (const [dx, dy] of dirs) {
      const nx = cur.x + dx,
        ny = cur.y + dy,
        k = key(nx, ny);
      if (
        visited.has(k) ||
        Math.abs(nx - originX) > radius ||
        Math.abs(ny - originY) > radius ||
        !walkable(state, nx, ny)
      )
        continue;
      visited.add(k);
      queue.push({ x: nx, y: ny });
      if (isFrontierDropCandidate(state, nx, ny)) {
        const d = nestDistance(state, nx, ny);
        if (d > originDist && d > bestDist) {
          best = { x: nx, y: ny };
          bestDist = d;
        }
      }
    }
  }
  return best;
}

// nearest entry in a diggable-wall set to (x,y) by straight-line distance,
// skipping anything already flagged unreachable (see setWall/unreachableWalls)
// or claimed by another colonist (see claimedWallTargets)
function nearestInWallSet(
  state: GameState,
  wallsToDig: Set<string>,
  x: number,
  y: number,
  exclude: Set<string>,
): Point | null {
  let best: Point | null = null,
    bestDist = Infinity;
  for (const key of wallsToDig) {
    if (state.unreachableWalls.has(key) || exclude.has(key)) continue;
    const [wx, wy] = key.split(',').map(Number);
    const d = Math.hypot(wx - x, wy - y);
    if (d < bestDist) {
      best = { x: wx, y: wy };
      bestDist = d;
    }
  }
  return best;
}

// nearest wall sitting on a live scent trail to (x,y), regardless of any
// specific food/alarm goal — used by findingWallBranch to proactively clear
// trail-blocking walls even when no worker has committed to chasing the
// food that trail reports (e.g. it's outside forage range).
export function nearestTrailWall(
  state: GameState,
  x: number,
  y: number,
  exclude: Set<string>,
): Point | null {
  return nearestInWallSet(state, state.trailWallsToDig, x, y, exclude);
}

// nearest entry in a diggable-wall set to the nest, ranked by nestDistance
// (not straight-line distance to an arbitrary point) so nest-clearing still
// empties the surroundings from the inside out, and bounded to the nest's
// own food radius since trailWallsToDig can hold far-away scent-overlay
// walls that must never count as nest-clearing work. Skips anything already
// flagged unreachable (see setWall) or claimed by another colonist (see
// claimedWallTargets) so it doesn't get re-picked and stalled on every tick.
function nearestInWallSetNearNest(
  state: GameState,
  wallsToDig: Set<string>,
  radius: number,
  exclude: Set<string>,
): Point | null {
  let best: Point | null = null,
    bestDist = Infinity;
  for (const key of wallsToDig) {
    if (state.unreachableWalls.has(key) || exclude.has(key)) continue;
    const [x, y] = key.split(',').map(Number);
    const d = nestDistance(state, x, y);
    if (d > radius) continue;
    if (d < bestDist) {
      best = { x, y };
      bestDist = d;
    }
  }
  return best;
}

// nearest diggable wall to the nest — trailWallsToDig always wins over
// nestWallsToDig, even a tile that's closer, since the trail decays and its
// route matters more than routine nest upkeep (see nearestTrailWall).
export function nearestDiggableWallNearNest(
  state: GameState,
  exclude: Set<string>,
): Point | null {
  const radius = effectiveNestFoodRadius(state);
  return (
    nearestInWallSetNearNest(state, state.trailWallsToDig, radius, exclude) ??
    nearestInWallSetNearNest(state, state.nestWallsToDig, radius, exclude)
  );
}

// every other live colonist's currently-claimed wallTarget, keyed "x,y" —
// mirrors claimedForageTargets so two colonists never converge on digging
// the exact same wall.
export function claimedWallTargets(
  state: GameState,
  exceptColonist?: Colonist,
): Set<string> {
  const claimed = new Set<string>();
  for (const c of state.colonists) {
    if (c === exceptColonist || !c.wallTarget || c.hp <= 0) continue;
    claimed.add(c.wallTarget.x + ',' + c.wallTarget.y);
  }
  return claimed;
}

// dev shortcut (right-click a food tile in game.ts): lays a synthetic scent
// trail from the nest to that food along the same tunnel-capable weighted
// route a scout actually walks (see scoutCost/findWeightedPath), exactly as
// if a scout had already found it and returned — lets a nearby worker pick
// it up immediately, for quicker manual testing. Any wall tile the route
// crosses is marked straight into trailWallsToDig so it's diggable too,
// same as a wall a real scout's trail happens to reseal over.
export function debugLayScentTrailToFood(
  state: GameState,
  foodX: number,
  foodY: number,
  now: number,
): void {
  const path = findWeightedPath(
    state.nest.x,
    state.nest.y,
    foodX,
    foodY,
    (x, y) => scoutCost(state, x, y),
  );
  if (path.length === 0) return;
  const origin = [{ x: foodX, y: foodY }];
  for (const p of [{ x: state.nest.x, y: state.nest.y }, ...path]) {
    const key = p.x + ',' + p.y;
    state.scentTrail.set(key, now);
    state.scentTrailSource.set(key, origin);
    state.scentTrailType.set(key, 'food');
    if (isWall(state, p.x, p.y)) state.trailWallsToDig.add(key);
  }
}

export function spawnFloatingText(
  state: GameState,
  entity: { px: number; py: number },
  text: string,
  color: string,
): void {
  state.floatingTexts.push({
    worldX: entity.px + TILE / 2,
    worldY: entity.py,
    text,
    color,
    born: performance.now(),
  });
}

// rebuilds the whole world in place from a new seed — no reload needed,
// since navigating/rewriting the URL isn't available in this environment.
// Purely mutates state; callers are responsible for refreshing any HUD/DOM.
export function regenerateWorld(
  state: GameState,
  newSeed: number,
  spawnEnemies: (state: GameState) => void,
): void {
  state.seed = newSeed;
  state.rng = mulberry32(newSeed);

  state.wallSet = buildWalls(newSeed, MAP_W, MAP_H, SPAWN_X, SPAWN_Y);
  state.unreachableWalls.clear();
  state.nestWallsToDig.clear();
  state.trailWallsToDig.clear();
  buildGroundAtlas(state.refs, state.map, state.wallSet);
  state.foodItems.length = 0;
  for (let i = 0; i < INITIAL_FOOD_COUNT; i++) {
    const s = randomOpenTile(state);
    if (s) state.foodItems.push(s);
  }
  spawnEnemies(state);

  state.nest.x = SPAWN_X + 1;
  state.nest.y = SPAWN_Y;
  state.nest.pendingCaste = null;
  state.nest.incubating = false;
  state.nest.incubateStart = 0;
  state.nest.level = 0;
  state.nest.workProgress = 0;
  // reset population before recomputing the food radius, since
  // effectiveNestFoodRadius (and thus which walls are in-radius) now
  // depends on colonists.length
  state.colonists.length = 0;
  populateWallsToDigNearNest(state);

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
  player.attacked = false;
  player.moving = false;
  player.tileX = SPAWN_X;
  player.tileY = SPAWN_Y;
  player.px = SPAWN_X * TILE;
  player.py = SPAWN_Y * TILE;
  player.hp = player.maxHp;
  player.invulnUntil = 0;
  player.digTile = null;
}

export function createGameState(
  refs: GameRefs,
  spawnEnemies: (state: GameState) => void,
): GameState {
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
    unreachableWalls: new Set(),
    nestWallsToDig: new Set(),
    trailWallsToDig: new Set(),
    foodItems: [],
    enemies: [],
    colonists: [],
    nest: {
      x: SPAWN_X + 1,
      y: SPAWN_Y,
      incubating: false,
      incubateStart: 0,
      pendingCaste: null,
      level: 0,
      workProgress: 0,
    },
    player: {
      tileX: SPAWN_X,
      tileY: SPAWN_Y,
      px: SPAWN_X * TILE,
      py: SPAWN_Y * TILE,
      dir: 'down',
      moving: false,
      moveStart: 0,
      moveDur: 240,
      fromX: 0,
      fromY: 0,
      toX: 0,
      toY: 0,
      path: [],
      caste: null,
      carryingType: null,
      pendingAction: null,
      scentActive: false,
      scentOrigins: [],
      scentType: null,
      attacked: false,
      attackTarget: null,
      lastAttack: 0,
      hp: PLAYER_MAX_HP,
      maxHp: PLAYER_MAX_HP,
      invulnUntil: 0,
      digTile: null,
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
    debugOverlay: false,
  };

  buildGroundAtlas(refs, map, wallSet);
  populateWallsToDigNearNest(state);
  for (let i = 0; i < INITIAL_FOOD_COUNT; i++) {
    const s = randomOpenTile(state);
    if (s) state.foodItems.push(s);
  }
  spawnEnemies(state);

  return state;
}
