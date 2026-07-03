// @ts-nocheck
// Ported as-is from the original colony.html prototype: a self-contained
// canvas game that queries the DOM by id. initColonyGame() is guarded so
// it only ever wires itself up once, even under dev double-invoke.
//
// World generation, pathfinding, and low-level canvas drawing live in their
// own modules; this file owns entity/game state, AI, DOM/HUD wiring, input
// handling, and the render/tick loops that compose everything together.
import { mulberry32, buildMap, buildWalls, DIRT } from './worldgen';
import { isAdjacent, findPath, bfsToAdjacent, hasLineOfSight } from './pathfinding';
import { drawTile, drawObstacle, drawSquareEntity, drawHpBar, drawNest, drawNestRadius } from './rendering';

let started = false;

export function initColonyGame() {
  if (started) return;
  started = true;

  let seed = 393845991;
  let rng = mulberry32(seed);

  const TILE = 16;
  let VP_W = 17, VP_H = 12;
  const MAP_W = 100, MAP_H = 80;

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  // zoom levels — each uses a clean integer CSS scale so tiles stay crisp
  const ZOOM_LEVELS = [
    { vpw: 13, vph: 9, scale: 4 },   // zoomed in
    { vpw: 17, vph: 12, scale: 3 },  // default
    { vpw: 26, vph: 18, scale: 2 },  // zoomed out
    { vpw: 52, vph: 36, scale: 1 },  // far — for scanning the bigger world
  ];
  let zoomIndex = 1;
  function applyZoom(index) {
    zoomIndex = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index));
    const lvl = ZOOM_LEVELS[zoomIndex];
    VP_W = lvl.vpw; VP_H = lvl.vph;
    canvas.width = VP_W * TILE;
    canvas.height = VP_H * TILE;
    canvas.style.width = (VP_W * TILE * lvl.scale) + 'px';
    canvas.style.height = (VP_H * TILE * lvl.scale) + 'px';
    ctx.imageSmoothingEnabled = false;
  }
  applyZoom(zoomIndex);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    applyZoom(zoomIndex + (e.deltaY < 0 ? -1 : 1));
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.key === '+' || e.key === '=') applyZoom(zoomIndex - 1);
    if (e.key === '-' || e.key === '_') applyZoom(zoomIndex + 1);
  });

  // ---- tiles (ground only — obstacles are a separate movable list) ----
  const map = buildMap(MAP_W, MAP_H);

  function terrainWalkable(x, y) {
    if (x < 0 || y < 0 || y >= map.length || x >= map[0].length) return false;
    return true;
  }

  // ---- castes ----
  const CASTES = {
    worker:  { name: 'Worker',  color: '#d99a3f', edge: '#8f5f1f', moveDur: 240, inset: 3 },
    soldier: { name: 'Soldier', color: '#b23a3a', edge: '#6e2020', moveDur: 260, inset: 1 },
    scout:   { name: 'Scout',   color: '#3fae9e', edge: '#1f6b5f', moveDur: 190, inset: 3 },
  };

  // ---- cave walls & food (walls are the same pickup-able block Worker already handles) ----
  const SPAWN_X = Math.floor(MAP_W / 2), SPAWN_Y = Math.floor(MAP_H / 2);

  let wallSet = buildWalls(seed, MAP_W, MAP_H, SPAWN_X, SPAWN_Y);
  function isWall(x, y) { return wallSet.has(x + ',' + y); }
  function obstacleAt(x, y) { return isWall(x, y) ? { x, y } : null; }

  const foodItems = [];
  function foodAt(x, y) { return foodItems.find(f => f.x === x && f.y === y); }

  // ---- soldier attack tuning ----
  const SOLDIER_ATK_DAMAGE = 3;
  const SOLDIER_ATK_COOLDOWN = 650;

  // ---- roaming enemies: wander until they see you, then chase and attack ----
  const ENEMY_COUNT = 5;
  const ENEMY_MAX_HP = 10;
  const ENEMY_MOVE_DUR = 280;
  const ENEMY_ATK_DAMAGE = 2;
  const ENEMY_ATK_COOLDOWN = 900;
  const ENEMY_AGGRO_RADIUS = 5;
  const ENEMY_LOSE_AGGRO_MS = 4000;
  const ENEMY_WANDER_MIN_MS = 1200;
  const ENEMY_WANDER_MAX_MS = 3000;
  const ENEMY_WANDER_RADIUS = 4;
  const ENEMY_REPATH_MS = 500;
  const ENEMY_SPAWN_MIN_DIST = 10; // keep initial spawns away from the player's start
  const PLAYER_MAX_HP = 20;
  const PLAYER_HIT_INVULN_MS = 500;
  const PLAYER_RESPAWN_INVULN_MS = 1200;
  const enemies = [];
  function isEnemyAt(x, y) { return enemies.some(e => e.hp > 0 && e.tileX === x && e.tileY === y); }

  // ---- player (declared early so isPlayerAt can be used during initial world seeding) ----
  const player = {
    tileX: SPAWN_X, tileY: SPAWN_Y, px: SPAWN_X * TILE, py: SPAWN_Y * TILE,
    dir: 'down', moving: false, moveStart: 0, moveDur: 240,
    fromX: 0, fromY: 0, toX: 0, toY: 0, path: [],
    caste: null, carryingType: null, // null | 'obstacle' | 'food'
    pendingAction: null, // {type:'pickup'|'place', x, y, kind}
    pathHistory: [],
    attackTarget: null, lastAttack: 0,
    hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP, invulnUntil: 0,
  };
  function isPlayerAt(x, y) { return !!player.caste && player.tileX === x && player.tileY === y; }

  // ---- nest: fixed 2x2 structure. Player manually spawns ants here,
  // consuming food that must be sitting within NEST_FOOD_RADIUS tiles ----
  const NEST_SIZE = 2;
  const NEST_FOOD_RADIUS = 3;       // (Chebyshev) distance food must be within to fuel a spawn
  const NEST_FOOD_COST = 1;         // 1 ant costs 1 food, consumed from the radius
  const NEST_INCUBATE_MS = 3000;    // time between consuming food and the ant appearing
  const MAX_COLONISTS = 15;
  const nest = {
    x: SPAWN_X + 1, y: SPAWN_Y,     // top-left tile of the 2x2 footprint — kept within the spawn safety carve
    incubating: false, incubateStart: 0, pendingCaste: null,
  };
  function nestCells() {
    return [
      { x: nest.x, y: nest.y }, { x: nest.x + 1, y: nest.y },
      { x: nest.x, y: nest.y + 1 }, { x: nest.x + 1, y: nest.y + 1 },
    ];
  }
  function isNestAt(x, y) { return nestCells().some(c => c.x === x && c.y === y); }
  // Euclidean distance from (x,y) to the nearest occupied nest tile — used
  // for the food-fueling radius, which renders as a circular zone
  function nestDistance(x, y) {
    let best = Infinity;
    for (const c of nestCells()) {
      const d = Math.hypot(x - c.x, y - c.y);
      if (d < best) best = d;
    }
    return best;
  }

  // ---- colony reports: scouts publish sightings here so workers/soldiers
  // can act on things outside their own personal sensing radius. Not a
  // visibility system — foodItems/enemies/wallSet stay fully global; reports
  // just let non-scout colonists react to things they haven't personally seen.
  const REPORT_EXPIRY_MS = 15000;
  const foodReports = [];   // { x, y, reachable, expiresAt }
  const digReports = [];    // { x, y, forFoodX, forFoodY, claimedBy, expiresAt }
  const enemyReports = [];  // { enemy, expiresAt } -- live object reference; enemies move

  function addFoodReport(x, y, reachable, now) {
    const existing = foodReports.find(r => r.x === x && r.y === y);
    if (existing) { existing.reachable = reachable; existing.expiresAt = now + REPORT_EXPIRY_MS; return; }
    foodReports.push({ x, y, reachable, expiresAt: now + REPORT_EXPIRY_MS });
  }
  function addDigReport(wx, wy, fx, fy, now) {
    const existing = digReports.find(r => r.x === wx && r.y === wy);
    if (existing) { existing.expiresAt = now + REPORT_EXPIRY_MS; return; }
    digReports.push({ x: wx, y: wy, forFoodX: fx, forFoodY: fy, claimedBy: null, expiresAt: now + REPORT_EXPIRY_MS });
  }
  function reportEnemy(enemy, now) {
    const existing = enemyReports.find(r => r.enemy === enemy);
    if (existing) { existing.expiresAt = now + REPORT_EXPIRY_MS; return; }
    enemyReports.push({ enemy, expiresAt: now + REPORT_EXPIRY_MS });
  }
  function removeFoodReport(x, y) {
    const idx = foodReports.findIndex(r => r.x === x && r.y === y);
    if (idx !== -1) foodReports.splice(idx, 1);
  }
  function removeDigReport(x, y) {
    const idx = digReports.findIndex(r => r.x === x && r.y === y);
    if (idx !== -1) digReports.splice(idx, 1);
  }
  function pruneReports(now) {
    for (let i = foodReports.length - 1; i >= 0; i--) {
      const r = foodReports[i];
      if (now > r.expiresAt || !foodAt(r.x, r.y)) foodReports.splice(i, 1);
    }
    for (let i = digReports.length - 1; i >= 0; i--) {
      const r = digReports[i];
      if (now > r.expiresAt || !isWall(r.x, r.y)) digReports.splice(i, 1);
    }
    for (let i = enemyReports.length - 1; i >= 0; i--) {
      const r = enemyReports[i];
      if (now > r.expiresAt || r.enemy.hp <= 0) enemyReports.splice(i, 1);
    }
  }

  // ---- colonists: autonomous NPC ants belonging to the colony ----
  const COLONIST_MAX_HP = { worker: 10, soldier: 16, scout: 8 };
  const COLONIST_MOVE_DUR = { worker: 260, soldier: 280, scout: 200 };
  const COLONIST_ATK_DAMAGE = 3;
  const COLONIST_ATK_COOLDOWN = 700;
  const COLONIST_AGGRO_RADIUS = 5;
  const COLONIST_FORAGE_RADIUS = 12;
  const COLONIST_WANDER_MIN_MS = 1000;
  const COLONIST_WANDER_MAX_MS = 2600;
  const COLONIST_WANDER_RADIUS = 4;
  const COLONIST_REPATH_MS = 500;
  const SCOUT_SIGHT_RADIUS = 14;
  const SCOUT_SCAN_INTERVAL_MS = 700;
  const SCOUT_WANDER_RADIUS = 9;
  const SOLDIER_DEFENSE_PERIMETER_RADIUS = 22;
  const SOLDIER_PATROL_RADIUS = 10;
  const colonists = [];
  function isColonistAt(x, y) { return colonists.some(c => c.hp > 0 && c.tileX === x && c.tileY === y); }

  function randomOpenTile() {
    for (let tries = 0; tries < 300; tries++) {
      const x = 1 + Math.floor(rng() * (MAP_W - 2));
      const y = 1 + Math.floor(rng() * (MAP_H - 2));
      if (!isWall(x, y) && !foodAt(x, y) && !isEnemyAt(x, y) && !isNestAt(x, y) && !isColonistAt(x, y) && !isPlayerAt(x, y)) return { x, y };
    }
    return null;
  }
  for (let i = 0; i < 40; i++) { const s = randomOpenTile(); if (s) foodItems.push(s); }

  function makeEnemy(x, y) {
    return {
      tileX: x, tileY: y, px: x * TILE, py: y * TILE,
      dir: 'down', moving: false, moveStart: 0, moveDur: ENEMY_MOVE_DUR,
      fromX: x, fromY: y, toX: x, toY: y,
      hp: ENEMY_MAX_HP, maxHp: ENEMY_MAX_HP,
      state: 'wander', path: [],
      nextWanderAt: performance.now() + ENEMY_WANDER_MIN_MS + Math.random() * (ENEMY_WANDER_MAX_MS - ENEMY_WANDER_MIN_MS),
      nextRepathAt: 0, lastAttack: 0, aggroUntil: 0, flashUntil: 0,
    };
  }
  function spawnEnemies() {
    enemies.length = 0;
    for (let i = 0; i < ENEMY_COUNT; i++) {
      let spot = null;
      for (let tries = 0; tries < 30; tries++) {
        const s = randomOpenTile();
        if (!s) break;
        if (Math.hypot(s.x - SPAWN_X, s.y - SPAWN_Y) >= ENEMY_SPAWN_MIN_DIST) { spot = s; break; }
      }
      if (spot) enemies.push(makeEnemy(spot.x, spot.y));
    }
  }
  spawnEnemies();

  function makeColonist(caste, x, y) {
    return {
      caste, tileX: x, tileY: y, px: x * TILE, py: y * TILE,
      dir: 'down', moving: false, moveStart: 0, moveDur: COLONIST_MOVE_DUR[caste],
      fromX: x, fromY: y, toX: x, toY: y,
      hp: COLONIST_MAX_HP[caste], maxHp: COLONIST_MAX_HP[caste],
      state: 'wander', path: [], carryingFood: false, forageTarget: null, digTarget: null,
      nextWanderAt: performance.now() + COLONIST_WANDER_MIN_MS + Math.random() * (COLONIST_WANDER_MAX_MS - COLONIST_WANDER_MIN_MS),
      nextRepathAt: 0, nextScanAt: 0, lastAttack: 0, aggroTarget: null, aggroUntil: 0, flashUntil: 0,
    };
  }
  function spawnColonist(caste) {
    if (colonists.length >= MAX_COLONISTS) return;
    const spot = randomOpenTileNear(nest.x, nest.y, 4) || randomOpenTile();
    if (spot) colonists.push(makeColonist(caste, spot.x, spot.y));
  }
  function randomOpenTileNear(cx, cy, radius) {
    for (let tries = 0; tries < 40; tries++) {
      const x = cx + Math.floor(Math.random() * (radius * 2 + 1)) - radius;
      const y = cy + Math.floor(Math.random() * (radius * 2 + 1)) - radius;
      if (walkable(x, y) && !foodAt(x, y)) return { x, y };
    }
    return null;
  }

  // rebuilds the whole world in place from a new seed — no reload needed,
  // since navigating/rewriting the URL isn't available in this environment
  function regenerateWorld(newSeed) {
    seed = newSeed;
    rng = mulberry32(seed);
    seedInput.value = seed;

    wallSet = buildWalls(seed, MAP_W, MAP_H, SPAWN_X, SPAWN_Y);
    foodItems.length = 0;
    for (let i = 0; i < 40; i++) { const s = randomOpenTile(); if (s) foodItems.push(s); }
    spawnEnemies();

    nest.x = SPAWN_X + 1; nest.y = SPAWN_Y;
    nest.pendingCaste = null;
    nest.incubating = false; nest.incubateStart = 0;
    colonists.length = 0;

    scentTrail.clear();

    player.caste = null;
    player.carryingType = null;
    player.pendingAction = null;
    player.attackTarget = null;
    player.path = [];
    player.pathHistory = [];
    player.moving = false;
    player.tileX = SPAWN_X; player.tileY = SPAWN_Y;
    player.px = SPAWN_X * TILE; player.py = SPAWN_Y * TILE;
    player.hp = player.maxHp;
    player.invulnUntil = 0;

    updateHud();
    openCasteOverlay();
  }

  function walkable(x, y) {
    return terrainWalkable(x, y) && !isWall(x, y) && !isEnemyAt(x, y) && !isNestAt(x, y) && !isColonistAt(x, y) && !isPlayerAt(x, y);
  }

  // ---- scent trail ----
  const scentTrail = new Set(); // "x,y" keys

  // ---- world map ----
  const WORLD_TILE = 4;
  const worldCanvas = document.getElementById('worldmap-canvas');
  const worldCtx = worldCanvas.getContext('2d');
  worldCtx.imageSmoothingEnabled = false;
  worldCanvas.width = MAP_W * WORLD_TILE;
  worldCanvas.height = MAP_H * WORLD_TILE;
  worldCanvas.style.width = (MAP_W * WORLD_TILE * 2) + 'px';
  worldCanvas.style.height = (MAP_H * WORLD_TILE * 2) + 'px';

  function renderWorldMap() {
    worldCtx.fillStyle = '#402c19';
    worldCtx.fillRect(0, 0, worldCanvas.width, worldCanvas.height);
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        worldCtx.fillStyle = isWall(x, y) ? '#8a8478' : '#4a331d';
        worldCtx.fillRect(x * WORLD_TILE, y * WORLD_TILE, WORLD_TILE, WORLD_TILE);
      }
    }
    worldCtx.fillStyle = '#9be89b';
    for (const key of scentTrail) {
      const [tx, ty] = key.split(',').map(Number);
      worldCtx.fillRect(tx * WORLD_TILE + 1, ty * WORLD_TILE + 1, WORLD_TILE - 2, WORLD_TILE - 2);
    }
    worldCtx.fillStyle = '#e8c44f';
    for (const f of foodItems) worldCtx.fillRect(f.x * WORLD_TILE, f.y * WORLD_TILE, WORLD_TILE, WORLD_TILE);
    worldCtx.fillStyle = '#8b3fae';
    for (const en of enemies) {
      if (en.hp <= 0) continue;
      worldCtx.fillRect(en.tileX * WORLD_TILE - 1, en.tileY * WORLD_TILE - 1, WORLD_TILE + 2, WORLD_TILE + 2);
    }
    worldCtx.lineWidth = 1;
    worldCtx.strokeStyle = '#e8c44f';
    for (const r of foodReports) worldCtx.strokeRect(r.x * WORLD_TILE - 1, r.y * WORLD_TILE - 1, WORLD_TILE + 2, WORLD_TILE + 2);
    worldCtx.strokeStyle = '#8b3fae';
    for (const r of enemyReports) {
      if (r.enemy.hp <= 0) continue;
      worldCtx.strokeRect(r.enemy.tileX * WORLD_TILE - 2, r.enemy.tileY * WORLD_TILE - 2, WORLD_TILE + 4, WORLD_TILE + 4);
    }
    worldCtx.strokeStyle = '#e05c5c';
    for (const r of digReports) worldCtx.strokeRect(r.x * WORLD_TILE - 1, r.y * WORLD_TILE - 1, WORLD_TILE + 2, WORLD_TILE + 2);

    worldCtx.fillStyle = '#f2efe6';
    worldCtx.fillRect(nest.x * WORLD_TILE - 1, nest.y * WORLD_TILE - 1, WORLD_TILE * 2 + 2, WORLD_TILE * 2 + 2);
    for (const c of colonists) {
      if (c.hp <= 0) continue;
      worldCtx.fillStyle = CASTES[c.caste].color;
      worldCtx.fillRect(c.tileX * WORLD_TILE, c.tileY * WORLD_TILE, WORLD_TILE, WORLD_TILE);
    }
    if (player.caste) {
      worldCtx.fillStyle = CASTES[player.caste].color;
      worldCtx.fillRect(player.tileX * WORLD_TILE - 1, player.tileY * WORLD_TILE - 1, WORLD_TILE + 2, WORLD_TILE + 2);
    }
  }

  // ---- player carry/pickup floating text helper ----
  const floatingTexts = [];
  function spawnFloatingText(entity, text, color) {
    floatingTexts.push({ worldX: entity.px + TILE / 2, worldY: entity.py, text, color, born: performance.now() });
  }

  function applyCaste(casteKey, resetPosition) {
    const def = CASTES[casteKey];

    // switching away while carrying something drops it right where you're
    // standing instead of losing it, as long as there's room for it
    if (player.carryingType && !isWall(player.tileX, player.tileY) && !foodAt(player.tileX, player.tileY)) {
      if (player.carryingType === 'obstacle') wallSet.add(player.tileX + ',' + player.tileY);
      else foodItems.push({ x: player.tileX, y: player.tileY });
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
    updateHud();
  }

  // ---- movement primitives ----
  const keys = {};
  window.addEventListener('keydown', (e) => {
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','w','a','s','d','W','A','S','D'].includes(e.key)) e.preventDefault();
    keys[e.key.toLowerCase()] = true;
    player.path = []; player.pendingAction = null; player.attackTarget = null;
  });
  window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
  function heldDir() {
    if (keys['arrowup'] || keys['w']) return 'up';
    if (keys['arrowdown'] || keys['s']) return 'down';
    if (keys['arrowleft'] || keys['a']) return 'left';
    if (keys['arrowright'] || keys['d']) return 'right';
    return null;
  }

  function startStep(actor, nx, ny, dir) {
    actor.dir = dir;
    actor.fromX = actor.tileX; actor.fromY = actor.tileY;
    actor.toX = nx; actor.toY = ny;
    actor.tileX = nx; actor.tileY = ny;
    actor.moving = true;
    actor.moveStart = performance.now();
  }
  function tryMove(dir) {
    let dx = 0, dy = 0;
    if (dir === 'up') dy = -1; else if (dir === 'down') dy = 1;
    else if (dir === 'left') dx = -1; else if (dir === 'right') dx = 1;
    const nx = player.tileX + dx, ny = player.tileY + dy;
    if (!walkable(nx, ny)) return;
    startStep(player, nx, ny, dir);
  }
  function dirBetween(fromX, fromY, toX, toY) {
    if (toX > fromX) return 'right';
    if (toX < fromX) return 'left';
    if (toY > fromY) return 'down';
    return 'up';
  }
  function updateActorAnimation(actor, now) {
    if (!actor.moving) return;
    const t = Math.min(1, (now - actor.moveStart) / actor.moveDur);
    actor.px = (actor.fromX + (actor.toX - actor.fromX) * t) * TILE;
    actor.py = (actor.fromY + (actor.toY - actor.fromY) * t) * TILE;
    if (t >= 1) {
      actor.moving = false;
      actor.px = actor.toX * TILE; actor.py = actor.toY * TILE;
    }
  }

  // ---- worker: pick up / place obstacles and food ----
  function doPickup(x, y, kind) {
    if (kind === 'obstacle') {
      if (!isWall(x, y)) return;
      wallSet.delete(x + ',' + y);
    } else {
      const idx = foodItems.findIndex(f => f.x === x && f.y === y);
      if (idx === -1) return;
      foodItems.splice(idx, 1);
    }
    player.carryingType = kind;
    spawnFloatingText(player, 'picked up ' + kind, kind === 'obstacle' ? '#b0aaa0' : '#e8c44f');
    updateHud();
  }
  function doPlace(x, y) {
    if (!terrainWalkable(x, y) || isWall(x, y) || foodAt(x, y) || isEnemyAt(x, y) || isNestAt(x, y) || isColonistAt(x, y)) return;
    if (player.carryingType === 'obstacle') wallSet.add(x + ',' + y);
    else if (player.carryingType === 'food') foodItems.push({ x, y });
    spawnFloatingText(player, 'placed ' + player.carryingType, '#ecdfc4');
    player.carryingType = null;
    updateHud();
  }
  function trySelectPickup(x, y, kind) {
    if (isAdjacent(player.tileX, player.tileY, x, y)) {
      doPickup(x, y, kind);
    } else {
      const path = bfsToAdjacent(player.tileX, player.tileY, x, y, walkable);
      if (path.length) { player.pendingAction = { type: 'pickup', x, y, kind }; player.path = path; }
    }
  }
  function tryPlaceAt(x, y) {
    if (!terrainWalkable(x, y) || obstacleAt(x, y) || foodAt(x, y) || isNestAt(x, y) || isColonistAt(x, y)) return;
    if (isAdjacent(player.tileX, player.tileY, x, y)) {
      doPlace(x, y);
    } else {
      const path = bfsToAdjacent(player.tileX, player.tileY, x, y, walkable);
      if (path.length) { player.pendingAction = { type: 'place', x, y }; player.path = path; }
    }
  }

  // ---- scout: lay a scent trail along the path to a discovery ----
  function layScentTrail() {
    for (const t of player.pathHistory) scentTrail.add(t.x + ',' + t.y);
    spawnFloatingText(player, 'found something!', '#9be89b');
    player.pathHistory = [{ x: player.tileX, y: player.tileY }];
    updateHud();
  }

  // ---- soldier: attack an enemy ----
  function attemptSoldierAttack(now) {
    const t = player.attackTarget;
    if (!t || t.hp <= 0) return;
    if (now - player.lastAttack < SOLDIER_ATK_COOLDOWN) return;
    player.lastAttack = now;
    const tx = t.tileX, ty = t.tileY;
    t.hp -= SOLDIER_ATK_DAMAGE;
    t.flashUntil = now + 140;
    spawnFloatingText({ px: tx * TILE, py: ty * TILE }, '-' + SOLDIER_ATK_DAMAGE, '#e8a838');
    if (t.hp <= 0) {
      t.hp = 0;
      player.attackTarget = null;
      killEnemy(t, tx, ty);
    }
  }

  // every living ant/enemy drops one food where it fell, falling back to a
  // nearby open tile if that exact spot is occupied
  function dropFoodOnDeath(tx, ty) {
    const freeAt = (x, y) => terrainWalkable(x, y) && !isWall(x, y) && !foodAt(x, y) && !isEnemyAt(x, y) && !isNestAt(x, y) && !isColonistAt(x, y) && !isPlayerAt(x, y);
    let dropX = tx, dropY = ty;
    if (!freeAt(dropX, dropY)) {
      const ring = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
      let placed = false;
      for (const [dx, dy] of ring) {
        if (freeAt(tx + dx, ty + dy)) { dropX = tx + dx; dropY = ty + dy; placed = true; break; }
      }
      if (!placed) return;
    }
    foodItems.push({ x: dropX, y: dropY });
  }

  // enemy dies permanently (no respawn) and drops food on the ground where it fell
  function killEnemy(enemy, tx, ty) {
    const idx = enemies.indexOf(enemy);
    if (idx !== -1) enemies.splice(idx, 1);
    spawnFloatingText({ px: tx * TILE, py: ty * TILE }, 'defeated!', '#c1633c');
    dropFoodOnDeath(tx, ty);
    updateHud();
  }

  // colonist dies permanently (no respawn) and drops food on the ground where it fell
  function killColonist(colonist, tx, ty) {
    const idx = colonists.indexOf(colonist);
    if (idx !== -1) colonists.splice(idx, 1);
    spawnFloatingText({ px: tx * TILE, py: ty * TILE }, 'defeated!', '#c1633c');
    dropFoodOnDeath(tx, ty);
    updateHud();
  }

  function damagePlayer(amount, now) {
    if (now < player.invulnUntil || player.hp <= 0) return;
    player.hp = Math.max(0, player.hp - amount);
    player.invulnUntil = now + PLAYER_HIT_INVULN_MS;
    spawnFloatingText(player, '-' + amount, '#e05c5c');
    updateHud();
    if (player.hp <= 0) {
      dropFoodOnDeath(player.tileX, player.tileY);
      showToast('You were defeated — respawning');
      respawnPlayer(now);
    }
  }

  function respawnPlayer(now) {
    player.hp = player.maxHp;
    player.tileX = SPAWN_X; player.tileY = SPAWN_Y;
    player.px = SPAWN_X * TILE; player.py = SPAWN_Y * TILE;
    player.path = []; player.pendingAction = null; player.attackTarget = null; player.moving = false;
    player.invulnUntil = now + PLAYER_RESPAWN_INVULN_MS;
    updateHud();
  }

  // ---- enemy AI: wander, then chase + attack on sight ----
  function damageColonist(colonist, amount, now) {
    if (colonist.hp <= 0) return;
    colonist.hp = Math.max(0, colonist.hp - amount);
    colonist.flashUntil = now + 140;
    spawnFloatingText({ px: colonist.px, py: colonist.py }, '-' + amount, '#e05c5c');
    if (colonist.hp <= 0) killColonist(colonist, colonist.tileX, colonist.tileY);
  }

  // finds the nearest valid target (player or a living colonist) within
  // aggro range and line of sight — enemies aren't picky about who they bite
  function findNearestTarget(fromX, fromY, radius) {
    let best = null, bestDist = Infinity;
    if (player.caste && player.hp > 0) {
      const d = Math.hypot(player.tileX - fromX, player.tileY - fromY);
      if (d <= radius && hasLineOfSight(fromX, fromY, player.tileX, player.tileY, isWall)) {
        best = { kind: 'player', ref: player }; bestDist = d;
      }
    }
    for (const c of colonists) {
      if (c.hp <= 0) continue;
      const d = Math.hypot(c.tileX - fromX, c.tileY - fromY);
      if (d <= radius && d < bestDist && hasLineOfSight(fromX, fromY, c.tileX, c.tileY, isWall)) {
        best = { kind: 'colonist', ref: c }; bestDist = d;
      }
    }
    return best;
  }
  function targetPos(target) {
    return target.kind === 'player' ? { x: player.tileX, y: player.tileY } : { x: target.ref.tileX, y: target.ref.tileY };
  }
  function targetAlive(target) {
    return target.kind === 'player' ? target.ref.hp > 0 && player.caste : target.ref.hp > 0;
  }

  function attemptEnemyAttack(enemy, now) {
    if (now - enemy.lastAttack < ENEMY_ATK_COOLDOWN) return;
    enemy.lastAttack = now;
    enemy.flashUntil = now + 140;
    if (enemy.target.kind === 'player') damagePlayer(ENEMY_ATK_DAMAGE, now);
    else damageColonist(enemy.target.ref, ENEMY_ATK_DAMAGE, now);
  }

  function updateEnemy(enemy, now) {
    if (enemy.hp <= 0) return;
    if (enemy.moving) { updateActorAnimation(enemy, now); return; }

    if (enemy.target && !targetAlive(enemy.target)) enemy.target = null;
    const sighted = findNearestTarget(enemy.tileX, enemy.tileY, ENEMY_AGGRO_RADIUS);
    if (sighted) {
      enemy.target = sighted;
      enemy.state = 'chase';
      enemy.aggroUntil = now + ENEMY_LOSE_AGGRO_MS;
    } else if (enemy.state === 'chase' && now > enemy.aggroUntil) {
      enemy.state = 'wander';
      enemy.target = null;
      enemy.path = [];
      enemy.nextWanderAt = now + 300;
    }

    if (enemy.state === 'chase' && enemy.target) {
      const pos = targetPos(enemy.target);
      if (isAdjacent(enemy.tileX, enemy.tileY, pos.x, pos.y)) {
        enemy.dir = dirBetween(enemy.tileX, enemy.tileY, pos.x, pos.y);
        attemptEnemyAttack(enemy, now);
        return;
      }
      if (now >= enemy.nextRepathAt || enemy.path.length === 0) {
        enemy.path = bfsToAdjacent(enemy.tileX, enemy.tileY, pos.x, pos.y, walkable);
        enemy.nextRepathAt = now + ENEMY_REPATH_MS;
      }
      if (enemy.path.length) {
        const next = enemy.path.shift();
        if (walkable(next.x, next.y)) startStep(enemy, next.x, next.y, dirBetween(enemy.tileX, enemy.tileY, next.x, next.y));
        else enemy.path = [];
      }
      return;
    }

    // wander: occasionally pick a nearby spot and walk to it
    if (now >= enemy.nextWanderAt && enemy.path.length === 0) {
      const tx = enemy.tileX + Math.floor(Math.random() * (ENEMY_WANDER_RADIUS * 2 + 1)) - ENEMY_WANDER_RADIUS;
      const ty = enemy.tileY + Math.floor(Math.random() * (ENEMY_WANDER_RADIUS * 2 + 1)) - ENEMY_WANDER_RADIUS;
      if (walkable(tx, ty)) {
        const p = findPath(enemy.tileX, enemy.tileY, tx, ty, walkable);
        if (p.length) enemy.path = p;
      }
      enemy.nextWanderAt = now + ENEMY_WANDER_MIN_MS + Math.random() * (ENEMY_WANDER_MAX_MS - ENEMY_WANDER_MIN_MS);
    }
    if (enemy.path.length) {
      const next = enemy.path.shift();
      if (walkable(next.x, next.y)) startStep(enemy, next.x, next.y, dirBetween(enemy.tileX, enemy.tileY, next.x, next.y));
      else enemy.path = [];
    }
  }

  // ---- colonist AI: workers forage food back toward the nest, soldiers fight nearby enemies ----
  function attemptColonistAttack(colonist, now) {
    const t = colonist.aggroTarget;
    if (!t || t.hp <= 0) return;
    if (now - colonist.lastAttack < COLONIST_ATK_COOLDOWN) return;
    colonist.lastAttack = now;
    colonist.flashUntil = now + 140;
    t.hp -= COLONIST_ATK_DAMAGE;
    t.flashUntil = now + 140;
    spawnFloatingText({ px: t.px, py: t.py }, '-' + COLONIST_ATK_DAMAGE, '#e8a838');
    if (t.hp <= 0) { t.hp = 0; killEnemy(t, t.tileX, t.tileY); colonist.aggroTarget = null; }
  }
  function nearestEnemyTo(x, y, radius) {
    let best = null, bestDist = Infinity;
    for (const en of enemies) {
      if (en.hp <= 0) continue;
      const d = Math.hypot(en.tileX - x, en.tileY - y);
      if (d <= radius && d < bestDist) { best = en; bestDist = d; }
    }
    return best;
  }

  // ---- scout: scans its surroundings for food/enemies and publishes colony
  // reports so workers/soldiers can act on things outside their own radius ----
  // picks a wall bordering the food that a colonist can actually walk up to
  // from the nest today — picking by raw distance-to-nest alone can name a
  // wall that's itself sealed off behind other walls, which would leave a
  // worker with a dig target it can never reach
  function pickDigTargetForFood(fx, fy) {
    const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
    let best = null, bestDist = Infinity;
    for (const [dx, dy] of dirs) {
      const wx = fx + dx, wy = fy + dy;
      if (!isWall(wx, wy)) continue;
      const approachable = isAdjacent(nest.x, nest.y, wx, wy) || bfsToAdjacent(nest.x, nest.y, wx, wy, walkable).length > 0;
      if (!approachable) continue;
      const d = nestDistance(wx, wy);
      if (d < bestDist) { bestDist = d; best = { x: wx, y: wy }; }
    }
    return best;
  }
  function scanForReports(x, y, radius, now) {
    for (const f of foodItems) {
      if (Math.hypot(f.x - x, f.y - y) > radius) continue;
      const existing = foodReports.find(r => r.x === f.x && r.y === f.y);
      if (existing) { existing.expiresAt = now + REPORT_EXPIRY_MS; continue; }
      const reachable = isAdjacent(nest.x, nest.y, f.x, f.y) || bfsToAdjacent(nest.x, nest.y, f.x, f.y, walkable).length > 0;
      if (reachable) {
        addFoodReport(f.x, f.y, true, now);
      } else {
        addFoodReport(f.x, f.y, false, now);
        const wall = pickDigTargetForFood(f.x, f.y);
        if (wall) addDigReport(wall.x, wall.y, f.x, f.y, now);
      }
    }
    for (const en of enemies) {
      if (en.hp <= 0) continue;
      if (Math.hypot(en.tileX - x, en.tileY - y) > radius) continue;
      if (hasLineOfSight(x, y, en.tileX, en.tileY, isWall)) reportEnemy(en, now);
    }
  }

  function updateColonist(colonist, now) {
    if (colonist.hp <= 0) return;
    if (colonist.moving) { updateActorAnimation(colonist, now); return; }

    if (colonist.caste === 'scout') {
      if (now >= colonist.nextScanAt) {
        scanForReports(colonist.tileX, colonist.tileY, SCOUT_SIGHT_RADIUS, now);
        colonist.nextScanAt = now + SCOUT_SCAN_INTERVAL_MS;
      }
      if (now >= colonist.nextWanderAt && colonist.path.length === 0) {
        const tx = colonist.tileX + Math.floor(Math.random() * (SCOUT_WANDER_RADIUS * 2 + 1)) - SCOUT_WANDER_RADIUS;
        const ty = colonist.tileY + Math.floor(Math.random() * (SCOUT_WANDER_RADIUS * 2 + 1)) - SCOUT_WANDER_RADIUS;
        if (walkable(tx, ty)) {
          const p = findPath(colonist.tileX, colonist.tileY, tx, ty, walkable);
          if (p.length) colonist.path = p;
        }
        colonist.nextWanderAt = now + COLONIST_WANDER_MIN_MS + Math.random() * (COLONIST_WANDER_MAX_MS - COLONIST_WANDER_MIN_MS);
      }
      if (colonist.path.length) {
        const next = colonist.path.shift();
        if (walkable(next.x, next.y)) startStep(colonist, next.x, next.y, dirBetween(colonist.tileX, colonist.tileY, next.x, next.y));
        else colonist.path = [];
      }
      return;
    }

    if (colonist.caste === 'soldier') {
      if (colonist.aggroTarget && colonist.aggroTarget.hp <= 0) colonist.aggroTarget = null;
      if (!colonist.aggroTarget) colonist.aggroTarget = nearestEnemyTo(colonist.tileX, colonist.tileY, COLONIST_AGGRO_RADIUS);
      if (!colonist.aggroTarget) {
        let best = null, bestDist = Infinity;
        for (const r of enemyReports) {
          if (r.enemy.hp <= 0) continue;
          const d = nestDistance(r.enemy.tileX, r.enemy.tileY);
          if (d <= SOLDIER_DEFENSE_PERIMETER_RADIUS && d < bestDist) { best = r.enemy; bestDist = d; }
        }
        colonist.aggroTarget = best;
      }
      if (colonist.aggroTarget) {
        const t = colonist.aggroTarget;
        if (isAdjacent(colonist.tileX, colonist.tileY, t.tileX, t.tileY)) {
          colonist.dir = dirBetween(colonist.tileX, colonist.tileY, t.tileX, t.tileY);
          attemptColonistAttack(colonist, now);
          return;
        }
        if (now >= colonist.nextRepathAt || colonist.path.length === 0) {
          colonist.path = bfsToAdjacent(colonist.tileX, colonist.tileY, t.tileX, t.tileY, walkable);
          colonist.nextRepathAt = now + COLONIST_REPATH_MS;
        }
        if (colonist.path.length) {
          const next = colonist.path.shift();
          if (walkable(next.x, next.y)) startStep(colonist, next.x, next.y, dirBetween(colonist.tileX, colonist.tileY, next.x, next.y));
          else colonist.path = [];
          return;
        }
        // path.length is 0 here only after a repath attempt just failed (the
        // condition above always retries when empty) — the target is
        // genuinely unreachable right now, so give up rather than freezing
        // in place; fall through to patrol/wander instead of returning
        colonist.aggroTarget = null;
      }
    }

    if (colonist.caste === 'worker') {
      // carrying food back to drop it within range of the nest
      if (colonist.carryingFood) {
        const nearNest = nestDistance(colonist.tileX, colonist.tileY) <= NEST_FOOD_RADIUS;
        if (nearNest) {
          if (!foodAt(colonist.tileX, colonist.tileY)) foodItems.push({ x: colonist.tileX, y: colonist.tileY });
          colonist.carryingFood = false;
          colonist.path = [];
        } else {
          if (colonist.path.length === 0) {
            const spot = randomOpenTileNear(nest.x, nest.y, NEST_FOOD_RADIUS - 1);
            const p = spot ? findPath(colonist.tileX, colonist.tileY, spot.x, spot.y, walkable) : [];
            if (p.length) colonist.path = p; else { colonist.carryingFood = false; }
          }
          if (colonist.path.length) {
            const next = colonist.path.shift();
            if (walkable(next.x, next.y)) startStep(colonist, next.x, next.y, dirBetween(colonist.tileX, colonist.tileY, next.x, next.y));
            else colonist.path = [];
          }
          return;
        }
      }
      // dig out a wall a scout has flagged as blocking a reported food item —
      // takes priority over foraging once claimed, since it's colony-critical
      if (colonist.digTarget && !isWall(colonist.digTarget.x, colonist.digTarget.y)) colonist.digTarget = null;
      if (!colonist.digTarget) {
        let best = null, bestDist = Infinity;
        for (const r of digReports) {
          if (r.claimedBy && r.claimedBy !== colonist && r.claimedBy.hp > 0 && colonists.includes(r.claimedBy)) continue;
          const d = Math.hypot(r.x - colonist.tileX, r.y - colonist.tileY);
          if (d < bestDist) { bestDist = d; best = r; }
        }
        if (best) { best.claimedBy = colonist; colonist.digTarget = best; colonist.path = []; }
      }
      if (colonist.digTarget) {
        const t = colonist.digTarget;
        if (isAdjacent(colonist.tileX, colonist.tileY, t.x, t.y)) {
          colonist.dir = dirBetween(colonist.tileX, colonist.tileY, t.x, t.y);
          wallSet.delete(t.x + ',' + t.y);
          spawnFloatingText(colonist, 'cleared path', '#b0aaa0');
          removeDigReport(t.x, t.y);
          removeFoodReport(t.forFoodX, t.forFoodY);
          colonist.digTarget = null;
          colonist.path = [];
          return;
        }
        if (colonist.path.length === 0) colonist.path = bfsToAdjacent(colonist.tileX, colonist.tileY, t.x, t.y, walkable);
        if (colonist.path.length) {
          const next = colonist.path.shift();
          if (walkable(next.x, next.y)) startStep(colonist, next.x, next.y, dirBetween(colonist.tileX, colonist.tileY, next.x, next.y));
          else colonist.path = [];
          return;
        }
        // genuinely unreachable from here — drop the claim and the report so
        // it doesn't dangle forever or keep drawing colonists toward a wall
        // they can never stand next to (rare: dynamic occupancy can also
        // transiently block the only approach, in which case it'll just get
        // re-flagged by a future scout pass)
        removeDigReport(t.x, t.y);
        colonist.digTarget = null;
      }
      // not carrying: look for food outside the nest's radius (no point
      // hauling food that's already close enough to fuel production), either
      // within personal forage range or flagged reachable by a scout report
      if (!colonist.forageTarget || !foodAt(colonist.forageTarget.x, colonist.forageTarget.y)) {
        let best = null, bestDist = Infinity;
        for (const f of foodItems) {
          if (nestDistance(f.x, f.y) <= NEST_FOOD_RADIUS) continue;
          const d = Math.hypot(f.x - colonist.tileX, f.y - colonist.tileY);
          const withinOwnRadius = d <= COLONIST_FORAGE_RADIUS;
          const isReportedReachable = foodReports.some(r => r.x === f.x && r.y === f.y && r.reachable);
          if ((withinOwnRadius || isReportedReachable) && d < bestDist) { best = f; bestDist = d; }
        }
        colonist.forageTarget = best;
        colonist.path = [];
      }
      if (colonist.forageTarget) {
        const f = colonist.forageTarget;
        if (isAdjacent(colonist.tileX, colonist.tileY, f.x, f.y)) {
          const idx = foodItems.findIndex(fi => fi.x === f.x && fi.y === f.y);
          if (idx !== -1) { foodItems.splice(idx, 1); colonist.carryingFood = true; }
          colonist.forageTarget = null;
          colonist.path = [];
          return;
        }
        if (colonist.path.length === 0) {
          colonist.path = bfsToAdjacent(colonist.tileX, colonist.tileY, f.x, f.y, walkable);
        }
        if (colonist.path.length) {
          const next = colonist.path.shift();
          if (walkable(next.x, next.y)) startStep(colonist, next.x, next.y, dirBetween(colonist.tileX, colonist.tileY, next.x, next.y));
          else colonist.path = [];
          return;
        }
      }
    }

    // wander (fallback for worker/soldier when there's nothing to do — scout
    // has its own branch above and always returns before reaching this).
    // Soldiers patrol around the nest instead of their own position, so idle
    // defenders stay colony-local rather than drifting off.
    if (now >= colonist.nextWanderAt && colonist.path.length === 0) {
      const cx = colonist.caste === 'soldier' ? nest.x : colonist.tileX;
      const cy = colonist.caste === 'soldier' ? nest.y : colonist.tileY;
      const radius = colonist.caste === 'soldier' ? SOLDIER_PATROL_RADIUS : COLONIST_WANDER_RADIUS;
      const tx = cx + Math.floor(Math.random() * (radius * 2 + 1)) - radius;
      const ty = cy + Math.floor(Math.random() * (radius * 2 + 1)) - radius;
      if (walkable(tx, ty)) {
        const p = findPath(colonist.tileX, colonist.tileY, tx, ty, walkable);
        if (p.length) colonist.path = p;
      }
      colonist.nextWanderAt = now + COLONIST_WANDER_MIN_MS + Math.random() * (COLONIST_WANDER_MAX_MS - COLONIST_WANDER_MIN_MS);
    }
    if (colonist.path.length) {
      const next = colonist.path.shift();
      if (walkable(next.x, next.y)) startStep(colonist, next.x, next.y, dirBetween(colonist.tileX, colonist.tileY, next.x, next.y));
      else colonist.path = [];
    }
  }

  // ---- nest: spawning only happens when the player explicitly requests it
  // (via the nest overlay). updateNest() just resolves an in-progress one. ----
  function countFoodNearNest() {
    let count = 0;
    for (const f of foodItems) if (nestDistance(f.x, f.y) <= NEST_FOOD_RADIUS) count++;
    return count;
  }
  function playerInNestRadius() {
    return player.caste && nestDistance(player.tileX, player.tileY) <= NEST_FOOD_RADIUS;
  }
  function startNestSpawn(casteKey) {
    if (nest.incubating) return false;
    if (!playerInNestRadius()) { showToast('Stand within the nest\'s food circle to spawn an ant'); return false; }
    if (colonists.length >= MAX_COLONISTS) { showToast('Colony is at full population'); return false; }
    const nearbyIdx = [];
    for (let i = 0; i < foodItems.length; i++) {
      if (nestDistance(foodItems[i].x, foodItems[i].y) <= NEST_FOOD_RADIUS) nearbyIdx.push(i);
    }
    if (nearbyIdx.length < NEST_FOOD_COST) { showToast('Not enough food near the nest'); return false; }
    for (const idx of nearbyIdx.slice(0, NEST_FOOD_COST).sort((a, b) => b - a)) foodItems.splice(idx, 1);
    nest.incubating = true;
    nest.incubateStart = performance.now();
    nest.pendingCaste = casteKey;
    showToast('Nest producing a ' + CASTES[casteKey].name.toLowerCase());
    return true;
  }
  function updateNest(now) {
    if (!nest.incubating) return;
    if (now - nest.incubateStart >= NEST_INCUBATE_MS) {
      nest.incubating = false;
      spawnColonist(nest.pendingCaste);
      nest.pendingCaste = null;
      updateHud();
    }
  }

  function onPlayerArrived(now) {
    if (player.pendingAction) {
      const pa = player.pendingAction;
      if (isAdjacent(player.tileX, player.tileY, pa.x, pa.y)) {
        if (pa.type === 'pickup') doPickup(pa.x, pa.y, pa.kind);
        else doPlace(pa.x, pa.y);
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
      if (foodAt(player.tileX, player.tileY)) layScentTrail();
      scanForReports(player.tileX, player.tileY, SCOUT_SIGHT_RADIUS, now);
    }
  }

  // ---- click handling ----
  function getClampedCamX() {
    const camX = player.px + TILE / 2 - (VP_W * TILE) / 2;
    return Math.max(0, Math.min(MAP_W * TILE - VP_W * TILE, camX));
  }
  function getClampedCamY() {
    const camY = player.py + TILE / 2 - (VP_H * TILE) / 2;
    return Math.max(0, Math.min(MAP_H * TILE - VP_H * TILE, camY));
  }
  function screenToTile(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width, scaleY = canvas.height / rect.height;
    const canvasX = (clientX - rect.left) * scaleX, canvasY = (clientY - rect.top) * scaleY;
    const camX = getClampedCamX(), camY = getClampedCamY();
    return { x: Math.floor((canvasX + camX) / TILE), y: Math.floor((canvasY + camY) / TILE) };
  }

  let hoveredTile = null;
  canvas.addEventListener('mousemove', (e) => { hoveredTile = screenToTile(e.clientX, e.clientY); });
  canvas.addEventListener('mouseleave', () => { hoveredTile = null; });

  canvas.addEventListener('click', (e) => {
    if (!player.caste) return;
    const { x, y } = screenToTile(e.clientX, e.clientY);

    if (isNestAt(x, y) && !player.carryingType) {
      openNestOverlay();
      return;
    }

    if (player.caste === 'worker') {
      if (player.carryingType) { tryPlaceAt(x, y); return; }
      const obs = obstacleAt(x, y);
      const food = foodAt(x, y);
      if (obs) { trySelectPickup(x, y, 'obstacle'); return; }
      if (food) { trySelectPickup(x, y, 'food'); return; }
    }

    if (player.caste === 'soldier') {
      const enemyHit = enemies.find(en => en.hp > 0 && en.tileX === x && en.tileY === y);
      if (enemyHit) {
        player.attackTarget = enemyHit;
        player.pendingAction = null;
        return;
      }
    }

    const path = findPath(player.tileX, player.tileY, x, y, walkable);
    if (path.length) { player.pendingAction = null; player.attackTarget = null; player.path = path; }
  });

  // ---- HUD ----
  const statCaste = document.getElementById('stat-caste');
  const statHp = document.getElementById('stat-hp');
  const statCarry = document.getElementById('stat-carry');
  const statTrail = document.getElementById('stat-trail');
  const statPopulation = document.getElementById('stat-population');
  const statReports = document.getElementById('stat-reports');
  function updateHud() {
    statCaste.textContent = player.caste ? CASTES[player.caste].name : 'none';
    statHp.textContent = player.hp + '/' + player.maxHp;
    statCarry.textContent = player.carryingType || 'nothing';
    statTrail.textContent = scentTrail.size;
    statPopulation.textContent = colonists.length + '/' + MAX_COLONISTS;
    statReports.textContent = 'f' + foodReports.length + ' e' + enemyReports.length + ' d' + digReports.length;
  }

  const toastEl = document.getElementById('toast');
  let toastTimer = null;
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  // ---- caste selection ----
  const casteOverlay = document.getElementById('caste-overlay');
  const casteRow = document.getElementById('caste-row');
  const casteHeading = document.getElementById('caste-heading');
  const casteCancel = document.getElementById('caste-cancel');
  const switchCasteBtn = document.getElementById('switch-caste-btn');

  function renderCasteCards() {
    casteRow.innerHTML = '';
    const DESCS = {
      worker: 'Pick up and relocate obstacles and food, or dig out walls a scout has flagged',
      soldier: 'Bigger. Defends the nest and responds to scouted threats nearby',
      scout: 'Explores farther and reports food, threats, and blocked paths to the colony',
    };
    Object.keys(CASTES).forEach((key) => {
      const def = CASTES[key];
      const card = document.createElement('div');
      card.className = 'caste-card';
      if (key === player.caste) card.style.borderColor = def.color;
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
      stats.textContent = DESCS[key];
      card.appendChild(stats);
      card.addEventListener('click', () => {
        const isFirstPick = player.caste === null;
        applyCaste(key, isFirstPick);
        casteOverlay.style.display = 'none';
      });
      casteRow.appendChild(card);
    });
  }

  function openCasteOverlay() {
    const switching = player.caste !== null;
    casteHeading.textContent = switching ? 'switch caste' : 'choose your caste';
    casteCancel.style.display = switching ? 'block' : 'none';
    renderCasteCards();
    casteOverlay.style.display = 'flex';
  }
  openCasteOverlay();

  switchCasteBtn.addEventListener('click', openCasteOverlay);
  casteCancel.addEventListener('click', () => { casteOverlay.style.display = 'none'; });

  // ---- nest overlay: choose what the nest produces ----
  const nestOverlay = document.getElementById('nest-overlay');
  const nestStatusEl = document.getElementById('nest-status');
  const nestRow = document.getElementById('nest-row');
  const nestCancel = document.getElementById('nest-cancel');
  const NEST_DESCS = {
    worker: 'Forages food, hauls it back, and clears walls scouts flag as blocking',
    soldier: 'Patrols near the nest and moves to intercept scouted threats',
    scout: 'Roams farther out, spotting food and enemies for the colony',
  };
  function renderNestOverlay() {
    const available = countFoodNearNest();
    const inRadius = playerInNestRadius();
    nestStatusEl.textContent = 'Population ' + colonists.length + '/' + MAX_COLONISTS +
      ' · food within ' + NEST_FOOD_RADIUS + ' tiles: ' + available +
      (nest.incubating ? ' · producing a ' + CASTES[nest.pendingCaste].name.toLowerCase() + '…'
        : (inRadius ? '' : ' · stand inside the food circle to spawn')) ;
    nestRow.innerHTML = '';
    const blocked = nest.incubating || colonists.length >= MAX_COLONISTS || available < NEST_FOOD_COST || !inRadius;
    Object.keys(CASTES).forEach((key) => {
      const def = CASTES[key];
      const card = document.createElement('div');
      card.className = 'caste-card';
      if (blocked) { card.style.opacity = '0.45'; card.style.cursor = 'default'; }
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
      stats.textContent = NEST_DESCS[key] + ' — costs ' + NEST_FOOD_COST + ' food';
      card.appendChild(stats);
      card.addEventListener('click', () => {
        if (blocked) return;
        if (startNestSpawn(key)) nestOverlay.style.display = 'none';
      });
      nestRow.appendChild(card);
    });
  }
  function openNestOverlay() {
    renderNestOverlay();
    nestOverlay.style.display = 'flex';
  }
  nestCancel.addEventListener('click', () => { nestOverlay.style.display = 'none'; });

  // ---- world map toggle ----
  const worldMapOverlay = document.getElementById('world-map-overlay');
  const worldMapCloseBtn = document.getElementById('world-map-close');
  const mapToggleBtn = document.getElementById('map-toggle-btn');
  const worldMapScroll = document.getElementById('worldmap-scroll');
  let mapOpen = false;

  // drag-to-pan support (in addition to native scrollbars/trackpad/touch)
  (function enableDragPan(el) {
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
  })(worldMapScroll);

  function setMapOpen(v) {
    mapOpen = v;
    worldMapOverlay.style.display = v ? 'flex' : 'none';
    if (v) {
      renderWorldMap();
      // center the scroll view on the player's current position
      const px = player.tileX * WORLD_TILE * 2;
      const py = player.tileY * WORLD_TILE * 2;
      worldMapScroll.scrollLeft = px - worldMapScroll.clientWidth / 2;
      worldMapScroll.scrollTop = py - worldMapScroll.clientHeight / 2;
    }
  }
  mapToggleBtn.addEventListener('click', () => setMapOpen(!mapOpen));
  worldMapCloseBtn.addEventListener('click', () => setMapOpen(false));
  document.getElementById('zoom-in-btn').addEventListener('click', () => applyZoom(zoomIndex - 1));
  document.getElementById('zoom-out-btn').addEventListener('click', () => applyZoom(zoomIndex + 1));

  // ---- seed controls ----
  const seedInput = document.getElementById('seed-input');
  seedInput.value = seed;
  document.getElementById('seed-load-btn').addEventListener('click', () => {
    const v = parseInt(seedInput.value, 10);
    if (Number.isFinite(v)) regenerateWorld(v);
  });
  document.getElementById('seed-random-btn').addEventListener('click', () => {
    regenerateWorld(Math.floor(Math.random() * 1e9));
  });

  window.addEventListener('keydown', (e) => {
    if ((e.key === 'c' || e.key === 'C') && player.caste !== null) openCasteOverlay();
    if (e.key === 'm' || e.key === 'M') setMapOpen(!mapOpen);
    if (e.key === 'Escape') {
      if (player.caste !== null) casteOverlay.style.display = 'none';
      setMapOpen(false);
    }
  });

  // ---- drawing ----
  function render(now) {
    const camX = getClampedCamX(), camY = getClampedCamY();
    ctx.fillStyle = '#0a0806';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const startCol = Math.floor(camX / TILE), startRow = Math.floor(camY / TILE);
    const offX = -(camX - startCol * TILE), offY = -(camY - startRow * TILE);
    for (let r = 0; r < VP_H + 2; r++) {
      for (let c = 0; c < VP_W + 2; c++) {
        const mx = startCol + c, my = startRow + r;
        if (mx < 0 || my < 0 || mx >= MAP_W || my >= MAP_H) continue;
        const sx = offX + c * TILE, sy = offY + r * TILE;
        if (isWall(mx, my)) drawObstacle(ctx, TILE, sx, sy);
        else drawTile(ctx, TILE, map[my][mx], sx, sy);
      }
    }

    // nest food-radius overlay (under everything else on the ground, like the scent trail)
    {
      const minX = nest.x - NEST_FOOD_RADIUS, maxX = nest.x + NEST_SIZE - 1 + NEST_FOOD_RADIUS;
      const minY = nest.y - NEST_FOOD_RADIUS, maxY = nest.y + NEST_SIZE - 1 + NEST_FOOD_RADIUS;
      drawNestRadius(ctx, TILE, canvas.width, canvas.height, camX, camY, minX, maxX, minY, maxY, (tx, ty) => nestDistance(tx, ty) <= NEST_FOOD_RADIUS);
    }

    // scent trail (under everything else on the ground)
    for (const key of scentTrail) {
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

    for (const f of foodItems) {
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
      const sx = nest.x * TILE - camX, sy = nest.y * TILE - camY;
      if (sx > -TILE * NEST_SIZE && sy > -TILE * NEST_SIZE && sx < canvas.width && sy < canvas.height) {
        for (const c of nestCells()) drawTile(ctx, TILE, DIRT, c.x * TILE - camX, c.y * TILE - camY);
        drawNest(ctx, TILE, NEST_SIZE, sx, sy, now, nest.incubating);
      }
    }

    for (const colonist of colonists) {
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

    for (const enemy of enemies) {
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

    if (hoveredTile && hoveredTile.x >= 0 && hoveredTile.y >= 0 && hoveredTile.x < MAP_W && hoveredTile.y < MAP_H) {
      const hx = hoveredTile.x * TILE - camX, hy = hoveredTile.y * TILE - camY;
      const blocked = obstacleAt(hoveredTile.x, hoveredTile.y) || isNestAt(hoveredTile.x, hoveredTile.y) || isColonistAt(hoveredTile.x, hoveredTile.y);
      ctx.strokeStyle = blocked ? '#8a8478' : '#ffffff';
      ctx.lineWidth = 1;
      ctx.strokeRect(hx + 0.5, hy + 0.5, TILE - 1, TILE - 1);
    }

    for (let i = floatingTexts.length - 1; i >= 0; i--) {
      const ft = floatingTexts[i];
      const age = now - ft.born;
      if (age > 700) { floatingTexts.splice(i, 1); continue; }
      const alpha = 1 - age / 700, yOff = (age / 700) * 9;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = ft.color;
      ctx.font = 'bold 6px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(ft.text, ft.worldX - camX, ft.worldY - camY - yOff);
      ctx.globalAlpha = 1;
    }

    const grad = ctx.createRadialGradient(canvas.width/2, canvas.height/2, canvas.height/2.2, canvas.width/2, canvas.height/2, canvas.height/1.1);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function tick(now) {
    if (player.caste) {
      if (player.moving) {
        updateActorAnimation(player, now);
        if (!player.moving) onPlayerArrived(now);
      } else {
        const dir = heldDir();
        if (dir) {
          player.path = []; player.pendingAction = null; player.attackTarget = null;
          tryMove(dir);
        } else if (player.caste === 'soldier' && player.attackTarget && player.attackTarget.hp > 0) {
          const t = player.attackTarget;
          const tx = t.tileX, ty = t.tileY;
          if (isAdjacent(player.tileX, player.tileY, tx, ty)) {
            player.dir = dirBetween(player.tileX, player.tileY, tx, ty);
            attemptSoldierAttack(now);
          } else {
            if (player.path.length === 0) {
              const p = bfsToAdjacent(player.tileX, player.tileY, tx, ty, walkable);
              if (p.length) player.path = p; else player.attackTarget = null;
            }
            if (player.path.length) {
              const next = player.path.shift();
              if (walkable(next.x, next.y)) startStep(player, next.x, next.y, dirBetween(player.tileX, player.tileY, next.x, next.y));
              else player.path = [];
            }
          }
        } else if (player.path.length) {
          const next = player.path.shift();
          if (walkable(next.x, next.y)) startStep(player, next.x, next.y, dirBetween(player.tileX, player.tileY, next.x, next.y));
          else player.path = [];
        }
      }
    }

    for (const enemy of enemies) updateEnemy(enemy, now);
    for (const colonist of colonists) updateColonist(colonist, now);
    updateNest(now);
    pruneReports(now);
    updateHud();

    render(now);
    if (mapOpen) renderWorldMap();
    requestAnimationFrame(tick);
  }

  updateHud();
  requestAnimationFrame(tick);
}
