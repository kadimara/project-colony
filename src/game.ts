// Orchestrator: builds the game state and DOM refs, wires every DOM event
// listener, and drives the tick/render loop. Behavior itself lives in the
// other modules — this file only connects them.
import type { CasteKey, GameRefs } from './types/types';
import { DEFAULT_ZOOM_INDEX, MAP_H, MAP_W, WORLD_TILE } from './constants';
import {
  createGameState, foodAt, isNestAt, obstacleAt, regenerateWorld, walkable as stateWalkable,
} from './state/state';
import { dirBetween, spawnEnemies, startStep, updateActorAnimation } from './entities/entities';
import { applyZoom, screenToTile } from './render/camera';
import { bfsToAdjacent, isAdjacent } from './systems/pathfinding';
import {
  applyCaste, attemptSoldierAttack, computeClickPath, onPlayerArrived, tryMove, tryPlaceAt, tryPlayerStep,
  trySelectPickup,
} from './systems/player-actions';
import { heldDir, setupPlayerInput } from './input/player-input';
import { startNestSpawn, updateColonist, updateEnemy, updateNest } from './systems/ai';
import {
  closeCasteOverlay, closeNestOverlay, createHudRefs, enableDragPan, openCasteOverlay,
  openNestOverlay, setMapOpen, updateHud,
} from './ui/hud';
import { render, renderWorldMap } from './render/render';

let started = false;

export function initColonyGame(): void {
  if (started) return;
  started = true;

  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const worldCanvas = document.getElementById('worldmap-canvas') as HTMLCanvasElement;
  const worldCtx = worldCanvas.getContext('2d')!;
  worldCtx.imageSmoothingEnabled = false;

  const refs: GameRefs = { canvas, ctx, worldCanvas, worldCtx };
  const state = createGameState(refs, spawnEnemies);
  const hud = createHudRefs();

  worldCanvas.width = MAP_W * WORLD_TILE;
  worldCanvas.height = MAP_H * WORLD_TILE;
  worldCanvas.style.width = (worldCanvas.width * 2) + 'px';
  worldCanvas.style.height = (worldCanvas.height * 2) + 'px';

  applyZoom(state, DEFAULT_ZOOM_INDEX);

  const walkableFn = (x: number, y: number) => stateWalkable(state, x, y);

  const selectCaste = (key: CasteKey) => {
    const isFirstPick = state.player.caste === null;
    applyCaste(state, hud, key, isFirstPick);
  };
  const openCaste = () => openCasteOverlay(state, hud, selectCaste);

  // ---- zoom ----
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    applyZoom(state, state.zoomIndex + (e.deltaY < 0 ? -1 : 1));
  }, { passive: false });
  hud.zoomInBtn.addEventListener('click', () => applyZoom(state, state.zoomIndex - 1));
  hud.zoomOutBtn.addEventListener('click', () => applyZoom(state, state.zoomIndex + 1));

  // ---- player movement input ----
  setupPlayerInput(state);

  // ---- hover + click on the main canvas ----
  canvas.addEventListener('mousemove', (e) => { state.hoveredTile = screenToTile(state, e.clientX, e.clientY); });
  canvas.addEventListener('mouseleave', () => { state.hoveredTile = null; });

  canvas.addEventListener('click', (e) => {
    const { player } = state;
    if (!player.caste) return;
    const { x, y } = screenToTile(state, e.clientX, e.clientY);

    if (isNestAt(state, x, y) && !player.carryingType) {
      openNestOverlay(state, hud, (key) => startNestSpawn(state, hud, key));
      return;
    }

    if (player.caste === 'worker') {
      if (player.carryingType) { tryPlaceAt(state, hud, x, y, walkableFn); return; }
      const obs = obstacleAt(state, x, y);
      const food = foodAt(state, x, y);
      if (obs) { trySelectPickup(state, hud, x, y, 'obstacle', walkableFn); return; }
      if (food) { trySelectPickup(state, hud, x, y, 'food', walkableFn); return; }
    }

    if (player.caste === 'soldier') {
      const enemyHit = state.enemies.find((en) => en.hp > 0 && en.tileX === x && en.tileY === y);
      if (enemyHit) {
        player.attackTarget = enemyHit;
        player.pendingAction = null;
        return;
      }
    }

    const path = computeClickPath(state, x, y, walkableFn);
    if (path.length) { player.pendingAction = null; player.attackTarget = null; player.path = path; }
  });

  // ---- caste overlay ----
  hud.switchCasteBtn.addEventListener('click', openCaste);
  hud.casteCancel.addEventListener('click', () => closeCasteOverlay(hud));
  openCaste();

  // ---- nest overlay ----
  hud.nestCancel.addEventListener('click', () => closeNestOverlay(hud));

  // ---- world map ----
  enableDragPan(hud.worldMapScroll);
  hud.mapToggleBtn.addEventListener('click', () => setMapOpen(state, hud, !state.mapOpen, () => renderWorldMap(state)));
  hud.worldMapCloseBtn.addEventListener('click', () => setMapOpen(state, hud, false, () => renderWorldMap(state)));

  // ---- seed controls ----
  hud.seedInput.value = String(state.seed);
  hud.seedLoadBtn.addEventListener('click', () => {
    const v = parseInt(hud.seedInput.value, 10);
    if (Number.isFinite(v)) {
      regenerateWorld(state, v, spawnEnemies);
      hud.seedInput.value = String(state.seed);
      updateHud(state, hud);
      openCaste();
    }
  });
  hud.seedRandomBtn.addEventListener('click', () => {
    regenerateWorld(state, Math.floor(Math.random() * 1e9), spawnEnemies);
    hud.seedInput.value = String(state.seed);
    updateHud(state, hud);
    openCaste();
  });

  // ---- keyboard shortcuts ----
  window.addEventListener('keydown', (e) => {
    if ((e.key === 'c' || e.key === 'C') && state.player.caste !== null) openCaste();
    if (e.key === '+' || e.key === '=') applyZoom(state, state.zoomIndex - 1);
    if (e.key === '-' || e.key === '_') applyZoom(state, state.zoomIndex + 1);
    if (e.key === 'm' || e.key === 'M') setMapOpen(state, hud, !state.mapOpen, () => renderWorldMap(state));
    if (e.key === 'Escape') {
      if (state.player.caste !== null) closeCasteOverlay(hud);
      setMapOpen(state, hud, false, () => renderWorldMap(state));
    }
  });

  // ---- main loop ----
  function tick(now: number): void {
    const { player } = state;
    if (player.caste) {
      if (player.moving) {
        updateActorAnimation(player, now);
        if (!player.moving) onPlayerArrived(state, hud);
      } else {
        const dir = heldDir();
        if (dir) {
          player.path = []; player.pendingAction = null; player.attackTarget = null;
          tryMove(state, dir, walkableFn);
        } else if (player.caste === 'soldier' && player.attackTarget && player.attackTarget.hp > 0) {
          const t = player.attackTarget;
          if (isAdjacent(player.tileX, player.tileY, t.tileX, t.tileY)) {
            player.dir = dirBetween(player.tileX, player.tileY, t.tileX, t.tileY);
            attemptSoldierAttack(state, hud, now);
          } else {
            if (player.path.length === 0) {
              const p = bfsToAdjacent(player.tileX, player.tileY, t.tileX, t.tileY, walkableFn);
              if (p.length) player.path = p; else player.attackTarget = null;
            }
            if (player.path.length) {
              const next = player.path.shift()!;
              if (walkableFn(next.x, next.y)) startStep(player, next.x, next.y, dirBetween(player.tileX, player.tileY, next.x, next.y));
              else player.path = [];
            }
          }
        } else if (player.path.length) {
          const next = player.path.shift()!;
          const dir = dirBetween(player.tileX, player.tileY, next.x, next.y);
          if (!tryPlayerStep(state, next.x, next.y, dir, walkableFn)) player.path = [];
        }
      }
    }

    for (const enemy of state.enemies) updateEnemy(state, hud, enemy, now, walkableFn);
    for (const colonist of state.colonists) updateColonist(state, hud, colonist, now, walkableFn);
    updateNest(state, hud, now);

    render(state, now);
    if (state.mapOpen) renderWorldMap(state);
    requestAnimationFrame(tick);
  }

  updateHud(state, hud);
  requestAnimationFrame(tick);
}
