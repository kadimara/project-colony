// HUD stat bar, toast messages, and the caste/nest/world-map overlays: DOM
// refs plus pure render/open/close functions. Game-logic decisions (which
// caste gets picked, whether a nest spawn is allowed) are injected as
// callbacks from index.ts so this module never has to import player-actions
// or ai directly.
import type { CasteKey, GameState, HudRefs } from './types';
import { CASTES, CASTE_DESCRIPTIONS, MAX_COLONISTS, NEST_FOOD_COST, NEST_FOOD_RADIUS, WORLD_TILE, NEST_CASTE_DESCRIPTIONS } from './constants';
import { countFoodNearNest, playerInNestRadius } from './state';

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} element`);
  return el as T;
}

export function createHudRefs(): HudRefs {
  return {
    statCaste: byId('stat-caste'),
    statHp: byId('stat-hp'),
    statCarry: byId('stat-carry'),
    statTrail: byId('stat-trail'),
    statPopulation: byId('stat-population'),
    toastEl: byId('toast'),

    casteOverlay: byId('caste-overlay'),
    casteRow: byId('caste-row'),
    casteHeading: byId('caste-heading'),
    casteCancel: byId('caste-cancel'),
    switchCasteBtn: byId('switch-caste-btn'),

    nestOverlay: byId('nest-overlay'),
    nestStatusEl: byId('nest-status'),
    nestRow: byId('nest-row'),
    nestCancel: byId('nest-cancel'),

    worldMapOverlay: byId('world-map-overlay'),
    worldMapCloseBtn: byId('world-map-close'),
    mapToggleBtn: byId('map-toggle-btn'),
    worldMapScroll: byId('worldmap-scroll'),

    seedInput: byId<HTMLInputElement>('seed-input'),
    seedLoadBtn: byId('seed-load-btn'),
    seedRandomBtn: byId('seed-random-btn'),
    zoomInBtn: byId('zoom-in-btn'),
    zoomOutBtn: byId('zoom-out-btn'),
  };
}

export function updateHud(state: GameState, hud: HudRefs): void {
  hud.statCaste.textContent = state.player.caste ? CASTES[state.player.caste].name : 'none';
  hud.statHp.textContent = state.player.hp + '/' + state.player.maxHp;
  hud.statCarry.textContent = state.player.carryingType || 'nothing';
  hud.statTrail.textContent = String(state.scentTrail.size);
  hud.statPopulation.textContent = state.colonists.length + '/' + MAX_COLONISTS;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function showToast(hud: HudRefs, msg: string): void {
  hud.toastEl.textContent = msg;
  hud.toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hud.toastEl.classList.remove('show'), 1800);
}

function buildCasteCard(key: CasteKey, description: string): HTMLDivElement {
  const def = CASTES[key];
  const card = document.createElement('div');
  card.className = 'caste-card';
  const swatch = document.createElement('div');
  swatch.className = 'caste-swatch';
  swatch.style.background = def.color;
  swatch.style.borderColor = def.edge;
  card.appendChild(swatch);
  const name = document.createElement('div');
  name.className = 'caste-name';
  name.textContent = def.name;
  card.appendChild(name);
  const stats = document.createElement('div');
  stats.className = 'caste-stats';
  stats.textContent = description;
  card.appendChild(stats);
  return card;
}

function renderCasteCards(state: GameState, hud: HudRefs, onSelect: (key: CasteKey) => void): void {
  hud.casteRow.innerHTML = '';
  (Object.keys(CASTES) as CasteKey[]).forEach((key) => {
    const card = buildCasteCard(key, CASTE_DESCRIPTIONS[key]);
    if (key === state.player.caste) card.style.borderColor = CASTES[key].color;
    card.addEventListener('click', () => {
      onSelect(key);
      hud.casteOverlay.style.display = 'none';
    });
    hud.casteRow.appendChild(card);
  });
}

export function openCasteOverlay(state: GameState, hud: HudRefs, onSelect: (key: CasteKey) => void): void {
  const switching = state.player.caste !== null;
  hud.casteHeading.textContent = switching ? 'switch caste' : 'choose your caste';
  hud.casteCancel.style.display = switching ? 'block' : 'none';
  renderCasteCards(state, hud, onSelect);
  hud.casteOverlay.style.display = 'flex';
}

export function closeCasteOverlay(hud: HudRefs): void {
  hud.casteOverlay.style.display = 'none';
}

function renderNestOverlay(state: GameState, hud: HudRefs, onSelect: (key: CasteKey) => boolean): void {
  const available = countFoodNearNest(state);
  const inRadius = playerInNestRadius(state);
  const { nest, colonists } = state;
  hud.nestStatusEl.textContent = 'Population ' + colonists.length + '/' + MAX_COLONISTS +
    ' · food within ' + NEST_FOOD_RADIUS + ' tiles: ' + available +
    (nest.incubating ? ' · producing a ' + CASTES[nest.pendingCaste!].name.toLowerCase() + '…'
      : (inRadius ? '' : ' · stand inside the food circle to spawn'));

  hud.nestRow.innerHTML = '';
  const blocked = nest.incubating || colonists.length >= MAX_COLONISTS || available < NEST_FOOD_COST || !inRadius;
  (Object.keys(CASTES) as CasteKey[]).forEach((key) => {
    const card = buildCasteCard(key, NEST_CASTE_DESCRIPTIONS[key] + ' — costs ' + NEST_FOOD_COST + ' food');
    if (blocked) { card.style.opacity = '0.45'; card.style.cursor = 'default'; }
    card.addEventListener('click', () => {
      if (blocked) return;
      if (onSelect(key)) hud.nestOverlay.style.display = 'none';
    });
    hud.nestRow.appendChild(card);
  });
}

export function openNestOverlay(state: GameState, hud: HudRefs, onSelect: (key: CasteKey) => boolean): void {
  renderNestOverlay(state, hud, onSelect);
  hud.nestOverlay.style.display = 'flex';
}

export function closeNestOverlay(hud: HudRefs): void {
  hud.nestOverlay.style.display = 'none';
}

export function setMapOpen(state: GameState, hud: HudRefs, open: boolean, renderWorldMap: () => void): void {
  state.mapOpen = open;
  hud.worldMapOverlay.style.display = open ? 'flex' : 'none';
  if (open) {
    renderWorldMap();
    // center the scroll view on the player's current position
    const px = state.player.tileX * WORLD_TILE * 2;
    const py = state.player.tileY * WORLD_TILE * 2;
    hud.worldMapScroll.scrollLeft = px - hud.worldMapScroll.clientWidth / 2;
    hud.worldMapScroll.scrollTop = py - hud.worldMapScroll.clientHeight / 2;
  }
}

// drag-to-pan support for the world map (in addition to native scrollbars/trackpad/touch)
export function enableDragPan(el: HTMLElement): void {
  let isDown = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
  el.addEventListener('mousedown', (e) => {
    isDown = true;
    el.classList.add('dragging');
    startX = e.pageX; startY = e.pageY;
    startLeft = el.scrollLeft; startTop = el.scrollTop;
  });
  window.addEventListener('mouseup', () => { isDown = false; el.classList.remove('dragging'); });
  window.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    e.preventDefault();
    el.scrollLeft = startLeft - (e.pageX - startX);
    el.scrollTop = startTop - (e.pageY - startY);
  });
}
