// Player-specific behavior: held-key movement, the worker's pickup/place,
// the scout's scent trail, the soldier's attack, and caste switching.
import type { CarryType, CasteKey, Dir, GameState, HudRefs } from './types';
import { CASTES, SOLDIER_ATK_DAMAGE, SOLDIER_ATK_COOLDOWN, SPAWN_X, SPAWN_Y, TILE } from './constants';
import {
  foodAt, isColonistAt, isEnemyAt, isNestAt, isWall, spawnFloatingText, startStep, terrainWalkable,
} from './state';
import { bfsToAdjacent, isAdjacent } from './pathfinding';
import { killEnemy } from './combat';
import { updateHud } from './hud';

const keys: Record<string, boolean> = {};
const MOVE_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', 'W', 'A', 'S', 'D'];

export function setupPlayerInput(state: GameState): void {
  window.addEventListener('keydown', (e) => {
    if (MOVE_KEYS.includes(e.key)) e.preventDefault();
    keys[e.key.toLowerCase()] = true;
    state.player.path = []; state.player.pendingAction = null; state.player.attackTarget = null;
  });
  window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
}

export function heldDir(): Dir | null {
  if (keys['arrowup'] || keys['w']) return 'up';
  if (keys['arrowdown'] || keys['s']) return 'down';
  if (keys['arrowleft'] || keys['a']) return 'left';
  if (keys['arrowright'] || keys['d']) return 'right';
  return null;
}

export function tryMove(state: GameState, dir: Dir, walkable: (x: number, y: number) => boolean): void {
  let dx = 0, dy = 0;
  if (dir === 'up') dy = -1; else if (dir === 'down') dy = 1;
  else if (dir === 'left') dx = -1; else if (dir === 'right') dx = 1;
  const { player } = state;
  const nx = player.tileX + dx, ny = player.tileY + dy;
  if (!walkable(nx, ny)) return;
  startStep(player, nx, ny, dir);
}

// switching away while carrying something drops it right where you're
// standing instead of losing it, as long as there's room for it
export function applyCaste(state: GameState, hud: HudRefs, casteKey: CasteKey, resetPosition: boolean): void {
  const { player } = state;
  const def = CASTES[casteKey];

  if (player.carryingType && !isWall(state, player.tileX, player.tileY) && !foodAt(state, player.tileX, player.tileY)) {
    if (player.carryingType === 'obstacle') state.wallSet.add(player.tileX + ',' + player.tileY);
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
    player.pathHistory = [{ x: SPAWN_X, y: SPAWN_Y }];
  } else {
    player.pathHistory = [{ x: player.tileX, y: player.tileY }];
  }
  updateHud(state, hud);
}

export function doPickup(state: GameState, hud: HudRefs, x: number, y: number, kind: CarryType): void {
  const { player } = state;
  if (kind === 'obstacle') {
    if (!isWall(state, x, y)) return;
    state.wallSet.delete(x + ',' + y);
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
  if (player.carryingType === 'obstacle') state.wallSet.add(x + ',' + y);
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

// ---- scout: lay a scent trail along the path to a discovery ----
export function layScentTrail(state: GameState, hud: HudRefs): void {
  const { player } = state;
  for (const t of player.pathHistory) state.scentTrail.add(t.x + ',' + t.y);
  spawnFloatingText(state, player, 'found something!', '#9be89b');
  player.pathHistory = [{ x: player.tileX, y: player.tileY }];
  updateHud(state, hud);
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

export function onPlayerArrived(state: GameState, hud: HudRefs): void {
  const { player } = state;
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
    const last = player.pathHistory[player.pathHistory.length - 1];
    if (!last || last.x !== player.tileX || last.y !== player.tileY) {
      player.pathHistory.push({ x: player.tileX, y: player.tileY });
      if (player.pathHistory.length > 400) player.pathHistory.shift();
    }
    if (foodAt(state, player.tileX, player.tileY)) layScentTrail(state, hud);
  }
}
