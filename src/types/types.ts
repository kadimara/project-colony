// Shared type definitions for the colony game engine. GameState is the single
// bag of mutable simulation state that every other module reads and writes —
// modules take it as a parameter instead of closing over local variables, so
// each file's dependencies are explicit and it stays independently readable.
import type { Rng } from '../worldgen/worldgen';

export type CasteKey = 'worker' | 'soldier' | 'scout';
export type Dir = 'up' | 'down' | 'left' | 'right';
export type CarryType = 'obstacle' | 'food';
export type ScentType = 'food' | 'alarm';
export type ScoutState = 'scouting' | 'returningToNest';
export type SoldierState = 'patrolling' | 'followingAlertScent' | 'attacking' | 'returningToNest';

export interface Point {
  x: number;
  y: number;
}

export type FoodItem = Point;

export interface CasteDef {
  name: string;
  color: string;
  edge: string;
  moveDur: number;
  inset: number;
}

export interface ZoomLevel {
  vpw: number;
  vph: number;
  scale: number;
}

// common movement/animation fields shared by the player, enemies, and colonists
export interface Actor {
  tileX: number;
  tileY: number;
  px: number;
  py: number;
  dir: Dir;
  moving: boolean;
  moveStart: number;
  moveDur: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  path: Point[];
}

export type PendingAction =
  | { type: 'pickup'; x: number; y: number; kind: CarryType }
  | { type: 'place'; x: number; y: number };

export interface Player extends Actor {
  caste: CasteKey | null;
  carryingType: CarryType | null;
  pendingAction: PendingAction | null;
  scentActive: boolean;
  scentOrigin: Point | null;
  scentType: ScentType | null;
  attackTarget: Enemy | null;
  lastAttack: number;
  hp: number;
  maxHp: number;
  invulnUntil: number;
  digTile: Point | null;
}

export type Target =
  | { kind: 'player'; ref: Player }
  | { kind: 'colonist'; ref: Colonist };

export interface Enemy extends Actor {
  hp: number;
  maxHp: number;
  state: 'wander' | 'chase';
  target: Target | null;
  nextWanderAt: number;
  nextRepathAt: number;
  lastAttack: number;
  aggroUntil: number;
  flashUntil: number;
}

export interface Colonist extends Actor {
  caste: CasteKey;
  hp: number;
  maxHp: number;
  carrying: CarryType | null;
  scoutState: ScoutState;
  soldierState: SoldierState;
  dropTarget: Point | null;
  forageTarget: FoodItem | null;
  carryOrigin: 'atNest' | 'followingScent' | 'helpingSoldier' | null;
  alertTarget: Point | null;
  tunnelTarget: Point | null;
  aggroTarget: Enemy | null;
  nextWanderAt: number;
  nextRepathAt: number;
  lastAttack: number;
  aggroUntil: number;
  flashUntil: number;
  attacked: boolean;
  exploreTarget: Point | null;
  scentActive: boolean;
  scentOrigin: Point | null;
  scentType: ScentType | null;
  digTile: Point | null;
}

export interface Nest {
  x: number;
  y: number;
  incubating: boolean;
  incubateStart: number;
  pendingCaste: CasteKey | null;
  level: number;
  workProgress: number;
}

export interface FloatingText {
  worldX: number;
  worldY: number;
  text: string;
  color: string;
  born: number;
}

export interface GameRefs {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  worldCanvas: HTMLCanvasElement;
  worldCtx: CanvasRenderingContext2D;
  groundAtlas: HTMLCanvasElement;
  groundAtlasCtx: CanvasRenderingContext2D;
}

// DOM element refs for the HUD stat bar and the caste/nest/world-map overlays
export interface HudRefs {
  statCaste: HTMLElement;
  statHp: HTMLElement;
  statCarry: HTMLElement;
  statTrail: HTMLElement;
  statPopulation: HTMLElement;
  statNestLevel: HTMLElement;
  toastEl: HTMLElement;

  casteOverlay: HTMLElement;
  casteRow: HTMLElement;
  casteHeading: HTMLElement;
  casteCancel: HTMLElement;
  switchCasteBtn: HTMLElement;

  nestOverlay: HTMLElement;
  nestStatusEl: HTMLElement;
  nestRow: HTMLElement;
  nestCancel: HTMLElement;

  worldMapOverlay: HTMLElement;
  worldMapCloseBtn: HTMLElement;
  mapToggleBtn: HTMLElement;
  worldMapScroll: HTMLElement;

  seedInput: HTMLInputElement;
  seedLoadBtn: HTMLElement;
  seedRandomBtn: HTMLElement;
  zoomInBtn: HTMLElement;
  zoomOutBtn: HTMLElement;
}

export interface GameState {
  refs: GameRefs;

  seed: number;
  rng: Rng;
  map: number[][];
  wallSet: Set<string>;
  unreachableWalls: Set<string>;
  foodItems: FoodItem[];
  enemies: Enemy[];
  colonists: Colonist[];
  nest: Nest;
  player: Player;
  scentTrail: Map<string, number>;
  scentTrailSource: Map<string, Point>;
  scentTrailType: Map<string, ScentType>;
  floatingTexts: FloatingText[];

  zoomIndex: number;
  VP_W: number;
  VP_H: number;
  mapOpen: boolean;
  hoveredTile: Point | null;
}
