// Player action resolution: movement, the worker's pickup/place, the
// scout's scent trail, the soldier's attack, and caste switching. Raw key
// tracking (which keys are currently held) lives in input/player-input.ts.
import type { CarryType, CasteKey, Dir, GameState, HudRefs, Point } from '../types/types';
import {
  CASTES, SCOUT_DIG_MOVE_DUR, SOLDIER_ATK_DAMAGE, SOLDIER_ATK_COOLDOWN, SPAWN_X, SPAWN_Y, TILE,
} from '../constants';
import {
  foodAt, isColonistAt, isEnemyAt, isNestAt, isWall, scoutCost, setWall, spawnFloatingText, terrainWalkable,
  updateScent,
} from '../state/state';
import { startStep } from '../entities/entities';
import { bfsToAdjacent, findPath, findWeightedPath, isAdjacent, type Walkable } from './pathfinding';
import { killEnemy } from './combat';
import { updateHud } from '../ui/hud';

// advances the player one tile: a normal step onto open ground, or — for a
// scout — a dig step through a wall tile (removed now, restored once the
// player leaves it; see onPlayerArrived). Returns false if the tile is
// blocked outright, so callers can bail out of whatever path they were
// following.
export function tryPlayerStep(state: GameState, nx: number, ny: number, dir: Dir, walkable: Walkable): boolean {
  const { player } = state;
  if (walkable(nx, ny)) {
    player.moveDur = CASTES[player.caste!].moveDur;
    startStep(player, nx, ny, dir);
    return true;
  }
  if (player.caste === 'scout' && isWall(state, nx, ny)) {
    setWall(state, nx, ny, false);
    player.digTile = { x: nx, y: ny };
    player.moveDur = SCOUT_DIG_MOVE_DUR;
    startStep(player, nx, ny, dir);
    return true;
  }
  return false;
}

export function tryMove(state: GameState, dir: Dir, walkable: Walkable): void {
  let dx = 0, dy = 0;
  if (dir === 'up') dy = -1; else if (dir === 'down') dy = 1;
  else if (dir === 'left') dx = -1; else if (dir === 'right') dx = 1;
  const { player } = state;
  tryPlayerStep(state, player.tileX + dx, player.tileY + dy, dir, walkable);
}

// computes where a click-to-move should walk the player: a scout may tunnel
// through walls along the way (via the weighted pathfinder shared with the
// scout colonist AI), but the destination itself must be real open ground —
// otherwise the player would path onto a wall tile and get resealed inside
// it the instant they "arrive" (see onPlayerArrived)
export function computeClickPath(state: GameState, x: number, y: number, walkable: Walkable): Point[] {
  const { player } = state;
  if (player.caste === 'scout') {
    if (!walkable(x, y)) return [];
    return findWeightedPath(player.tileX, player.tileY, x, y, (px, py) => scoutCost(state, px, py));
  }
  return findPath(player.tileX, player.tileY, x, y, walkable);
}

// switching away while carrying something drops it right where you're
// standing instead of losing it, as long as there's room for it
export function applyCaste(state: GameState, hud: HudRefs, casteKey: CasteKey, resetPosition: boolean): void {
  const { player } = state;
  const def = CASTES[casteKey];

  // mid-tunnel and switching away from scout (or resetting position) — put
  // the wall block back down rather than leaving a permanent hole
  if (player.digTile) {
    setWall(state, player.digTile.x, player.digTile.y, true);
    player.digTile = null;
  }

  if (player.carryingType && !isWall(state, player.tileX, player.tileY) && !foodAt(state, player.tileX, player.tileY)) {
    if (player.carryingType === 'obstacle') setWall(state, player.tileX, player.tileY, true);
    else state.foodItems.push({ x: player.tileX, y: player.tileY });
  }
  player.carryingType = null;

  player.caste = casteKey;
  player.moveDur = def.moveDur;
  player.path = []; player.pendingAction = null; player.attackTarget = null;
  player.moving = false;

  if (resetPosition) {
    player.tileX = SPAWN_X; player.tileY = SPAWN_Y;
    player.px = SPAWN_X * TILE; player.py = SPAWN_Y * TILE;
  }
  player.scentActive = false; player.scentOrigin = null;
  updateHud(state, hud);
}

export function doPickup(state: GameState, hud: HudRefs, x: number, y: number, kind: CarryType): void {
  const { player } = state;
  if (kind === 'obstacle') {
    if (!isWall(state, x, y)) return;
    setWall(state, x, y, false);
  } else {
    const idx = state.foodItems.findIndex((f) => f.x === x && f.y === y);
    if (idx === -1) return;
    state.foodItems.splice(idx, 1);
  }
  player.carryingType = kind;
  spawnFloatingText(state, player, 'picked up ' + kind, kind === 'obstacle' ? '#b0aaa0' : '#e8c44f');
  updateHud(state, hud);
}

export function doPlace(state: GameState, hud: HudRefs, x: number, y: number): void {
  const { player } = state;
  if (!terrainWalkable(state, x, y) || isWall(state, x, y) || foodAt(state, x, y) || isEnemyAt(state, x, y) || isNestAt(state, x, y) || isColonistAt(state, x, y)) return;
  if (player.carryingType === 'obstacle') setWall(state, x, y, true);
  else if (player.carryingType === 'food') state.foodItems.push({ x, y });
  spawnFloatingText(state, player, 'placed ' + player.carryingType, '#ecdfc4');
  player.carryingType = null;
  updateHud(state, hud);
}

export function trySelectPickup(state: GameState, hud: HudRefs, x: number, y: number, kind: CarryType, walkable: (x: number, y: number) => boolean): void {
  const { player } = state;
  if (isAdjacent(player.tileX, player.tileY, x, y)) {
    doPickup(state, hud, x, y, kind);
    return;
  }
  const path = bfsToAdjacent(player.tileX, player.tileY, x, y, walkable);
  if (path.length) { player.pendingAction = { type: 'pickup', x, y, kind }; player.path = path; }
}

export function tryPlaceAt(state: GameState, hud: HudRefs, x: number, y: number, walkable: (x: number, y: number) => boolean): void {
  const { player } = state;
  if (!terrainWalkable(state, x, y) || isWall(state, x, y) || foodAt(state, x, y) || isNestAt(state, x, y) || isColonistAt(state, x, y)) return;
  if (isAdjacent(player.tileX, player.tileY, x, y)) {
    doPlace(state, hud, x, y);
    return;
  }
  const path = bfsToAdjacent(player.tileX, player.tileY, x, y, walkable);
  if (path.length) { player.pendingAction = { type: 'place', x, y }; player.path = path; }
}

// ---- soldier: attack an enemy ----
export function attemptSoldierAttack(state: GameState, hud: HudRefs, now: number): void {
  const { player } = state;
  const t = player.attackTarget;
  if (!t || t.hp <= 0) return;
  if (now - player.lastAttack < SOLDIER_ATK_COOLDOWN) return;
  player.lastAttack = now;
  t.hp -= SOLDIER_ATK_DAMAGE;
  t.flashUntil = now + 140;
  spawnFloatingText(state, { px: t.tileX * TILE, py: t.tileY * TILE }, '-' + SOLDIER_ATK_DAMAGE, '#e8a838');
  if (t.hp <= 0) {
    t.hp = 0;
    player.attackTarget = null;
    killEnemy(state, hud, t);
  }
}

export function onPlayerArrived(state: GameState, hud: HudRefs, now: number): void {
  const { player } = state;
  // standing on a dug tile means the player is about to move on — put the
  // wall block back down now that they're leaving it
  if (player.digTile) {
    setWall(state, player.digTile.x, player.digTile.y, true);
    player.digTile = null;
  }
  if (player.pendingAction) {
    const pa = player.pendingAction;
    if (isAdjacent(player.tileX, player.tileY, pa.x, pa.y)) {
      if (pa.type === 'pickup') doPickup(state, hud, pa.x, pa.y, pa.kind);
      else doPlace(state, hud, pa.x, pa.y);
      player.pendingAction = null;
    } else if (player.path.length === 0) {
      // path exhausted without ever reaching adjacency — give up quietly
      player.pendingAction = null;
    }
    // otherwise: still mid-walk toward the target, keep pendingAction for the next step
  }
  if (player.caste === 'scout') {
    const wasActive = player.scentActive;
    updateScent(state, player, now);
    if (player.scentActive && !wasActive) spawnFloatingText(state, player, 'found something!', '#9be89b');
    if (player.scentActive) updateHud(state, hud);
  }
}
