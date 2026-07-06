// Pre-rendered full-map ground+wall layer. Painting every visible tile with
// fillRect calls each frame is the dominant cost at far zoom (thousands of
// tiles/frame); instead we paint the whole map once into an offscreen canvas
// and the main render loop blits the visible sub-rect with a single
// drawImage call. Deliberately state-agnostic (plain refs/map/wallSet
// params, not GameState) so state.ts can call into this without an import
// cycle.
import { MAP_H, MAP_W, TILE } from '../constants';
import type { GameRefs } from '../types/types';
import { drawObstacle, drawTile } from './rendering';

export function patchGroundAtlasTile(refs: GameRefs, map: number[][], x: number, y: number, solid: boolean): void {
  const sx = x * TILE, sy = y * TILE;
  if (solid) drawObstacle(refs.groundAtlasCtx, TILE, sx, sy);
  else drawTile(refs.groundAtlasCtx, TILE, map[y][x], sx, sy);
}

export function buildGroundAtlas(refs: GameRefs, map: number[][], wallSet: Set<string>): void {
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      patchGroundAtlasTile(refs, map, x, y, wallSet.has(x + ',' + y));
    }
  }
}
