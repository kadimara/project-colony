// The main canvas draw loop plus the world-map overview panel. Reads
// GameState and draws it using the low-level primitives in rendering.ts —
// no game logic lives here, only presentation.
import type { GameState, Point } from '../types/types';
import { CASTES, MAP_H, MAP_W, NEST_FOOD_RADIUS, NEST_SIZE, TILE, WORLD_TILE } from '../constants';
import { getClampedCamX, getClampedCamY } from './camera';
import { isColonistAt, isNestAt, isWall, nestCells, nestDistance, obstacleAt } from '../state/state';
import { DIRT } from '../worldgen/worldgen';
import { drawHpBar, drawNest, drawNestRadius, drawObstacle, drawSquareEntity, drawTile } from './rendering';

export function renderWorldMap(state: GameState): void {
  const { worldCanvas, worldCtx } = state.refs;
  worldCtx.fillStyle = '#402c19';
  worldCtx.fillRect(0, 0, worldCanvas.width, worldCanvas.height);
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      worldCtx.fillStyle = isWall(state, x, y) ? '#8a8478' : '#4a331d';
      worldCtx.fillRect(x * WORLD_TILE, y * WORLD_TILE, WORLD_TILE, WORLD_TILE);
    }
  }
  worldCtx.fillStyle = '#9be89b';
  for (const key of state.scentTrail) {
    const [tx, ty] = key.split(',').map(Number);
    worldCtx.fillRect(tx * WORLD_TILE + 1, ty * WORLD_TILE + 1, WORLD_TILE - 2, WORLD_TILE - 2);
  }
  worldCtx.fillStyle = '#e8c44f';
  for (const f of state.foodItems) worldCtx.fillRect(f.x * WORLD_TILE, f.y * WORLD_TILE, WORLD_TILE, WORLD_TILE);
  worldCtx.fillStyle = '#8b3fae';
  for (const en of state.enemies) {
    if (en.hp <= 0) continue;
    worldCtx.fillRect(en.tileX * WORLD_TILE - 1, en.tileY * WORLD_TILE - 1, WORLD_TILE + 2, WORLD_TILE + 2);
  }
  worldCtx.fillStyle = '#f2efe6';
  worldCtx.fillRect(state.nest.x * WORLD_TILE - 1, state.nest.y * WORLD_TILE - 1, WORLD_TILE * 2 + 2, WORLD_TILE * 2 + 2);
  for (const c of state.colonists) {
    if (c.hp <= 0) continue;
    worldCtx.fillStyle = CASTES[c.caste].color;
    worldCtx.fillRect(c.tileX * WORLD_TILE, c.tileY * WORLD_TILE, WORLD_TILE, WORLD_TILE);
  }
  if (state.player.caste) {
    worldCtx.fillStyle = CASTES[state.player.caste].color;
    worldCtx.fillRect(state.player.tileX * WORLD_TILE - 1, state.player.tileY * WORLD_TILE - 1, WORLD_TILE + 2, WORLD_TILE + 2);
  }
}

export function render(state: GameState, now: number): void {
  const { canvas, ctx } = state.refs;
  const { player } = state;
  const camX = getClampedCamX(state), camY = getClampedCamY(state);
  ctx.fillStyle = '#0a0806';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const startCol = Math.floor(camX / TILE), startRow = Math.floor(camY / TILE);
  const offX = -(camX - startCol * TILE), offY = -(camY - startRow * TILE);
  for (let r = 0; r < state.VP_H + 2; r++) {
    for (let c = 0; c < state.VP_W + 2; c++) {
      const mx = startCol + c, my = startRow + r;
      if (mx < 0 || my < 0 || mx >= MAP_W || my >= MAP_H) continue;
      const sx = offX + c * TILE, sy = offY + r * TILE;
      if (isWall(state, mx, my)) drawObstacle(ctx, TILE, sx, sy);
      else drawTile(ctx, TILE, state.map[my][mx], sx, sy);
    }
  }

  // nest food-radius overlay (under everything else on the ground, like the scent trail)
  {
    const minX = state.nest.x - NEST_FOOD_RADIUS, maxX = state.nest.x + NEST_SIZE - 1 + NEST_FOOD_RADIUS;
    const minY = state.nest.y - NEST_FOOD_RADIUS, maxY = state.nest.y + NEST_SIZE - 1 + NEST_FOOD_RADIUS;
    drawNestRadius(ctx, TILE, canvas.width, canvas.height, camX, camY, minX, maxX, minY, maxY, (tx, ty) => nestDistance(state, tx, ty) <= NEST_FOOD_RADIUS);
  }

  // scent trail (under everything else on the ground)
  for (const key of state.scentTrail) {
    const [tx, ty] = key.split(',').map(Number);
    const sx = tx * TILE - camX, sy = ty * TILE - camY;
    if (sx < -TILE || sy < -TILE || sx > canvas.width || sy > canvas.height) continue;
    ctx.fillStyle = 'rgba(155,232,155,0.35)';
    ctx.beginPath();
    ctx.arc(sx + TILE / 2, sy + TILE / 2, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const step of player.path) {
    const cx = step.x * TILE + TILE / 2 - camX, cy = step.y * TILE + TILE / 2 - camY;
    ctx.fillStyle = 'rgba(236,223,196,0.7)';
    ctx.beginPath(); ctx.arc(cx, cy, 1.5, 0, Math.PI * 2); ctx.fill();
  }

  for (const f of state.foodItems) {
    const sx = f.x * TILE - camX, sy = f.y * TILE - camY;
    if (sx < -TILE || sy < -TILE || sx > canvas.width || sy > canvas.height) continue;
    const size = Math.max(4, Math.round(TILE * 0.4));
    const ix = sx + (TILE - size) / 2, iy = sy + (TILE - size) / 2;
    ctx.fillStyle = '#a8862f';
    ctx.fillRect(ix - 1, iy - 1, size + 2, size + 2);
    ctx.fillStyle = '#e8c44f';
    ctx.fillRect(ix, iy, size, size);
  }

  {
    const sx = state.nest.x * TILE - camX, sy = state.nest.y * TILE - camY;
    if (sx > -TILE * NEST_SIZE && sy > -TILE * NEST_SIZE && sx < canvas.width && sy < canvas.height) {
      for (const cell of nestCells(state)) drawTile(ctx, TILE, DIRT, cell.x * TILE - camX, cell.y * TILE - camY);
      drawNest(ctx, TILE, NEST_SIZE, sx, sy, now, state.nest.incubating);
    }
  }

  for (const colonist of state.colonists) {
    if (colonist.hp <= 0) continue;
    const sx = colonist.px - camX, sy = colonist.py - camY;
    if (sx < -TILE || sy < -TILE || sx > canvas.width || sy > canvas.height) continue;
    const def = CASTES[colonist.caste];
    drawSquareEntity(ctx, TILE, sx, sy, def.color, def.edge, def.inset);
    if (colonist.flashUntil && now < colonist.flashUntil) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(sx + 3, sy + 3, TILE - 6, TILE - 6);
    }
    if (colonist.carryingFood) {
      ctx.fillStyle = '#e8c44f';
      ctx.fillRect(sx + TILE / 2 - 1.5, sy - 4, 3, 3);
    }
    if (colonist.hp < colonist.maxHp) drawHpBar(ctx, TILE, sx, sy, colonist.hp / colonist.maxHp);
  }

  for (const enemy of state.enemies) {
    const sx = enemy.px - camX, sy = enemy.py - camY;
    if (sx < -TILE || sy < -TILE || sx > canvas.width || sy > canvas.height) continue;
    drawSquareEntity(ctx, TILE, sx, sy, '#8b3fae', '#43205a', 2);
    if (enemy.flashUntil && now < enemy.flashUntil) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(sx + 2, sy + 2, TILE - 4, TILE - 4);
    }
    if (enemy.hp < enemy.maxHp) drawHpBar(ctx, TILE, sx, sy, enemy.hp / enemy.maxHp);
  }

  if (player.caste) {
    const sx = player.px - camX, sy = player.py - camY;
    const def = CASTES[player.caste];
    if (player.invulnUntil && now < player.invulnUntil) ctx.globalAlpha = 0.55;
    drawSquareEntity(ctx, TILE, sx, sy, def.color, def.edge, def.inset);
    ctx.globalAlpha = 1;
    if (player.carryingType) {
      ctx.fillStyle = player.carryingType === 'obstacle' ? '#b0aaa0' : '#e8c44f';
      ctx.fillRect(sx + TILE / 2 - 2, sy - 5, 4, 4);
    }
    if (player.hp < player.maxHp) drawHpBar(ctx, TILE, sx, sy, player.hp / player.maxHp);
  }

  const hovered: Point | null = state.hoveredTile;
  if (hovered && hovered.x >= 0 && hovered.y >= 0 && hovered.x < MAP_W && hovered.y < MAP_H) {
    const hx = hovered.x * TILE - camX, hy = hovered.y * TILE - camY;
    const blocked = obstacleAt(state, hovered.x, hovered.y) || isNestAt(state, hovered.x, hovered.y) || isColonistAt(state, hovered.x, hovered.y);
    ctx.strokeStyle = blocked ? '#8a8478' : '#ffffff';
    ctx.lineWidth = 1;
    ctx.strokeRect(hx + 0.5, hy + 0.5, TILE - 1, TILE - 1);
  }

  for (let i = state.floatingTexts.length - 1; i >= 0; i--) {
    const ft = state.floatingTexts[i];
    const age = now - ft.born;
    if (age > 700) { state.floatingTexts.splice(i, 1); continue; }
    const alpha = 1 - age / 700, yOff = (age / 700) * 9;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = ft.color;
    ctx.font = 'bold 6px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(ft.text, ft.worldX - camX, ft.worldY - camY - yOff);
    ctx.globalAlpha = 1;
  }

  const grad = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, canvas.height / 2.2, canvas.width / 2, canvas.height / 2, canvas.height / 1.1);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}
