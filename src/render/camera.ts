// Viewport/zoom/camera math: how many tiles are visible, how the canvas is
// sized on screen, and converting between screen pixels and world tiles.
import type { GameState, Point } from '../types/types';
import { MAP_H, MAP_W, TILE, ZOOM_LEVELS } from '../constants';

export function applyZoom(state: GameState, index: number): void {
  state.zoomIndex = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index));
  const lvl = ZOOM_LEVELS[state.zoomIndex];
  state.VP_W = lvl.vpw; state.VP_H = lvl.vph;

  const { canvas, ctx } = state.refs;
  canvas.width = state.VP_W * TILE;
  canvas.height = state.VP_H * TILE;
  canvas.style.width = (state.VP_W * TILE * lvl.scale) + 'px';
  canvas.style.height = (state.VP_H * TILE * lvl.scale) + 'px';
  ctx.imageSmoothingEnabled = false;
}

export function getClampedCamX(state: GameState): number {
  const camX = state.player.px + TILE / 2 - (state.VP_W * TILE) / 2;
  return Math.max(0, Math.min(MAP_W * TILE - state.VP_W * TILE, camX));
}

export function getClampedCamY(state: GameState): number {
  const camY = state.player.py + TILE / 2 - (state.VP_H * TILE) / 2;
  return Math.max(0, Math.min(MAP_H * TILE - state.VP_H * TILE, camY));
}

export function screenToTile(state: GameState, clientX: number, clientY: number): Point {
  const { canvas } = state.refs;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
  const canvasX = (clientX - rect.left) * scaleX, canvasY = (clientY - rect.top) * scaleY;
  const camX = getClampedCamX(state), camY = getClampedCamY(state);
  return { x: Math.floor((canvasX + camX) / TILE), y: Math.floor((canvasY + camY) / TILE) };
}
