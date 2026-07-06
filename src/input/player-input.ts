// Raw player input: tracks which movement keys are currently held. Action
// resolution (what a move/click actually does) lives in systems/player-actions.ts.
import type { Dir, GameState } from '../types/types';

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
