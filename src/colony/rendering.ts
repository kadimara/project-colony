// @ts-nocheck
// Low-level canvas drawing primitives: tiles, obstacles, entity squares, HP
// bars, and the dummy/nest/nest-radius sprites. Each function only takes the
// canvas context plus the primitive values it needs to draw one thing, so
// none of it depends on the game's entity/state model.
import { DIRT, DIRT2 } from './worldgen';

export const COLORS = {
  [DIRT]:  ['#4a331d', '#402c19'],
  [DIRT2]: ['#523823', '#472f1d'],
};

export function drawTile(ctx, TILE, type, sx, sy) {
  const pair = COLORS[type] || COLORS[DIRT];
  ctx.fillStyle = pair[0];
  ctx.fillRect(sx, sy, TILE, TILE);
  ctx.fillStyle = pair[1];
  ctx.fillRect(sx, sy, TILE / 2, TILE / 2);
  ctx.fillRect(sx + TILE / 2, sy + TILE / 2, TILE / 2, TILE / 2);
}

export function drawObstacle(ctx, TILE, sx, sy) {
  drawTile(ctx, TILE, DIRT, sx, sy);
  const m1 = Math.max(1, Math.round(TILE * 0.09));
  const m2 = Math.max(1, Math.round(TILE * 0.16));
  ctx.fillStyle = '#5e594e';
  ctx.fillRect(sx + m1, sy + m1, TILE - m1 * 2, TILE - m1 * 2);
  ctx.fillStyle = '#8a8478';
  ctx.fillRect(sx + m2, sy + m2, TILE - m2 * 2, TILE - m2 * 2);
}

export function drawSquareEntity(ctx, TILE, sx, sy, fill, edge, inset) {
  const size = TILE - inset * 2;
  ctx.fillStyle = edge;
  ctx.fillRect(sx + inset - 1, sy + inset - 1, size + 2, size + 2);
  ctx.fillStyle = fill;
  ctx.fillRect(sx + inset, sy + inset, size, size);
}

export function drawHpBar(ctx, TILE, sx, sy, ratio) {
  const margin = Math.max(1, Math.round(TILE * 0.16));
  const w = TILE - margin * 2, h = Math.max(1, Math.round(TILE * 0.125));
  const bx = sx + margin, by = sy - Math.round(TILE * 0.25);
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(bx - 1, by - 1, w + 2, h + 2);
  let fill = '#4caf50';
  if (ratio <= 0.25) fill = '#e53935'; else if (ratio <= 0.5) fill = '#f5a623';
  ctx.fillStyle = fill;
  ctx.fillRect(bx, by, Math.max(0, w * ratio), h);
}

export function drawDummy(ctx, TILE, sx, sy, now, flashUntil, hp, maxHp) {
  // a wooden practice post with a simple target ring
  ctx.fillStyle = '#6e5a3f';
  ctx.fillRect(sx + TILE / 2 - 1.5, sy + 4, 3, TILE - 6);
  const cx = sx + TILE / 2, cy = sy + TILE / 2 - 1;
  ctx.fillStyle = '#c9a876';
  ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#b23a3a';
  ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#c9a876';
  ctx.beginPath(); ctx.arc(cx, cy, 2, 0, Math.PI * 2); ctx.fill();
  if (flashUntil && now < flashUntil) {
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fill();
  }
  if (hp > 0 && hp < maxHp) drawHpBar(ctx, TILE, sx, sy, hp / maxHp);
}

export function drawNest(ctx, TILE, NEST_SIZE, sx, sy, now, incubating) {
  // a plain white 2x2 block, like a clutch of eggs — sx,sy is the
  // screen position of the nest's top-left tile
  const w = TILE * NEST_SIZE, h = TILE * NEST_SIZE, inset = 4;
  ctx.fillStyle = '#8a8478';
  ctx.fillRect(sx + inset - 1, sy + inset - 1, w - inset * 2 + 2, h - inset * 2 + 2);
  ctx.fillStyle = '#f2efe6';
  ctx.fillRect(sx + inset, sy + inset, w - inset * 2, h - inset * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(sx + inset + 2, sy + inset + 2, (w - inset * 2) * 0.4, (h - inset * 2) * 0.4);
  if (incubating) {
    const pulse = 0.5 + 0.5 * Math.sin(now / 220);
    ctx.fillStyle = 'rgba(217,119,87,' + (0.15 + pulse * 0.3) + ')';
    ctx.fillRect(sx + inset, sy + inset, w - inset * 2, h - inset * 2);
  }
}

// shows which tiles are close enough to the nest for food to fuel a spawn.
// withinRadius(tx,ty) decides which tiles in the [minX,maxX]x[minY,maxY]
// box get shaded, keeping this primitive agnostic of how "nest distance" is
// actually computed.
export function drawNestRadius(ctx, TILE, canvasWidth, canvasHeight, camX, camY, carried, minX, maxX, minY, maxY, withinRadius) {
  if (carried) return;
  ctx.fillStyle = 'rgba(232,196,79,0.10)';
  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      if (!withinRadius(tx, ty)) continue;
      const sx = tx * TILE - camX, sy = ty * TILE - camY;
      if (sx < -TILE || sy < -TILE || sx > canvasWidth || sy > canvasHeight) continue;
      ctx.fillRect(sx, sy, TILE, TILE);
    }
  }
}
