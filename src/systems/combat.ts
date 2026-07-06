// Damage and death resolution shared by player actions and AI: applying
// damage to the player/colonists/enemies, and the consequences of death
// (dropping food, removing the corpse, respawning the player). Kept separate
// from player-actions.ts and ai.ts so neither has to import the other.
import type { Colonist, Enemy, GameState, HudRefs } from '../types/types';
import {
  PLAYER_HIT_INVULN_MS, PLAYER_RESPAWN_INVULN_MS, SPAWN_X, SPAWN_Y, TILE,
} from '../constants';
import {
  foodAt, isColonistAt, isEnemyAt, isNestAt, isPlayerAt, isWall, spawnFloatingText, terrainWalkable,
} from '../state/state';
import { showToast, updateHud } from '../ui/hud';

// every living ant/enemy drops one food where it fell, falling back to a
// nearby open tile if that exact spot is occupied
function dropFoodOnDeath(state: GameState, tx: number, ty: number): void {
  const freeAt = (x: number, y: number) =>
    terrainWalkable(state, x, y) && !isWall(state, x, y) && !foodAt(state, x, y)
    && !isEnemyAt(state, x, y) && !isNestAt(state, x, y) && !isColonistAt(state, x, y) && !isPlayerAt(state, x, y);
  let dropX = tx, dropY = ty;
  if (!freeAt(dropX, dropY)) {
    const ring = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
    let placed = false;
    for (const [dx, dy] of ring) {
      if (freeAt(tx + dx, ty + dy)) { dropX = tx + dx; dropY = ty + dy; placed = true; break; }
    }
    if (!placed) return;
  }
  state.foodItems.push({ x: dropX, y: dropY });
}

// enemy dies permanently (no respawn) and drops food on the ground where it fell
export function killEnemy(state: GameState, hud: HudRefs, enemy: Enemy): void {
  const idx = state.enemies.indexOf(enemy);
  if (idx !== -1) state.enemies.splice(idx, 1);
  spawnFloatingText(state, { px: enemy.tileX * TILE, py: enemy.tileY * TILE }, 'defeated!', '#c1633c');
  dropFoodOnDeath(state, enemy.tileX, enemy.tileY);
  updateHud(state, hud);
}

// colonist dies permanently (no respawn) and drops food on the ground where it fell
function killColonist(state: GameState, hud: HudRefs, colonist: Colonist): void {
  const idx = state.colonists.indexOf(colonist);
  if (idx !== -1) state.colonists.splice(idx, 1);
  // a scout caught mid-tunnel is carrying a wall block — put it back before
  // dropping food, so food never lands on top of a now-solid wall tile
  if (colonist.digTile) {
    state.wallSet.add(colonist.digTile.x + ',' + colonist.digTile.y);
    colonist.digTile = null;
  }
  spawnFloatingText(state, { px: colonist.tileX * TILE, py: colonist.tileY * TILE }, 'defeated!', '#c1633c');
  dropFoodOnDeath(state, colonist.tileX, colonist.tileY);
  updateHud(state, hud);
}

export function damageColonist(state: GameState, hud: HudRefs, colonist: Colonist, amount: number, now: number): void {
  if (colonist.hp <= 0) return;
  colonist.hp = Math.max(0, colonist.hp - amount);
  colonist.flashUntil = now + 140;
  spawnFloatingText(state, { px: colonist.px, py: colonist.py }, '-' + amount, '#e05c5c');
  if (colonist.hp <= 0) killColonist(state, hud, colonist);
}

export function respawnPlayer(state: GameState, hud: HudRefs, now: number): void {
  const { player } = state;
  player.hp = player.maxHp;
  player.tileX = SPAWN_X; player.tileY = SPAWN_Y;
  player.px = SPAWN_X * TILE; player.py = SPAWN_Y * TILE;
  player.path = []; player.pendingAction = null; player.attackTarget = null; player.moving = false;
  player.invulnUntil = now + PLAYER_RESPAWN_INVULN_MS;
  updateHud(state, hud);
}

export function damagePlayer(state: GameState, hud: HudRefs, amount: number, now: number): void {
  const { player } = state;
  if (now < player.invulnUntil || player.hp <= 0) return;
  player.hp = Math.max(0, player.hp - amount);
  player.invulnUntil = now + PLAYER_HIT_INVULN_MS;
  spawnFloatingText(state, player, '-' + amount, '#e05c5c');
  updateHud(state, hud);
  if (player.hp <= 0) {
    // a scout caught mid-tunnel is carrying a wall block — put it back
    // before dropping food, so food never lands on top of a now-solid tile
    if (player.digTile) {
      state.wallSet.add(player.digTile.x + ',' + player.digTile.y);
      player.digTile = null;
    }
    dropFoodOnDeath(state, player.tileX, player.tileY);
    showToast(hud, 'You were defeated — respawning');
    respawnPlayer(state, hud, now);
  }
}
