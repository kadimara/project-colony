// @ts-nocheck
// World generation: seeded RNG, simplex noise, and the procedural cave-wall
// pass that turns noise into a walkable/solid tile map.

export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 2D simplex noise (public-domain reference algorithm, seeded permutation)
export function makeSimplex2D(noiseSeed) {
  const noiseRng = mulberry32(noiseSeed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(noiseRng() * (i + 1));
    const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
  }
  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    permMod12[i] = perm[i] % 12;
  }
  const grad3 = [
    [1,1],[-1,1],[1,-1],[-1,-1],
    [1,0],[-1,0],[1,0],[-1,0],
    [0,1],[0,-1],[0,1],[0,-1],
  ];
  const F2 = 0.5 * (Math.sqrt(3) - 1);
  const G2 = (3 - Math.sqrt(3)) / 6;
  return function noise2D(xin, yin) {
    let n0 = 0, n1 = 0, n2 = 0;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const X0 = i - t, Y0 = j - t;
    const x0 = xin - X0, y0 = yin - Y0;
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    const gi0 = permMod12[ii + perm[jj]];
    const gi1 = permMod12[ii + i1 + perm[jj + j1]];
    const gi2 = permMod12[ii + 1 + perm[jj + 1]];
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) { t0 *= t0; n0 = t0 * t0 * (grad3[gi0][0] * x0 + grad3[gi0][1] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) { t1 *= t1; n1 = t1 * t1 * (grad3[gi1][0] * x1 + grad3[gi1][1] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) { t2 *= t2; n2 = t2 * t2 * (grad3[gi2][0] * x2 + grad3[gi2][1] * y2); }
    return 70 * (n0 + n1 + n2); // ~[-1, 1]
  };
}

export function fbm(noise2D, x, y, octaves, persistence, lacunarity, scale) {
  let total = 0, amplitude = 1, frequency = 1 / scale, maxValue = 0;
  for (let o = 0; o < octaves; o++) {
    total += noise2D(x * frequency, y * frequency) * amplitude;
    maxValue += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }
  return total / maxValue;
}

// preset tuned in the map generator tool (320x320) — scale is adjusted
// proportionally (60 * 100/320) since this game's map is smaller, which
// keeps the same pocket density/frequency rather than flattening it out
export const CAVE_PRESET = { scale: 19, octaves: 4, persistence: 0.8, lacunarity: 2.0, threshold: -0.16 };

// ground tile variants (aesthetic checkerboard, not walkability)
export const DIRT = 0, DIRT2 = 1;

export function buildMap(mapW, mapH) {
  const map = [];
  for (let y = 0; y < mapH; y++) {
    const row = [];
    for (let x = 0; x < mapW; x++) row.push((x + y) % 5 === 0 ? DIRT2 : DIRT);
    map.push(row);
  }
  return map;
}

// generates the solid-wall set for a mapW x mapH cave from fbm noise, then
// carves out a safety bubble around the spawn point so the player never
// spawns sealed inside solid rock
export function buildWalls(seed, mapW, mapH, spawnX, spawnY) {
  const walls = new Set();
  const noise2D = makeSimplex2D(seed);
  const { scale, octaves, persistence, lacunarity, threshold } = CAVE_PRESET;
  // direct 1:1 mapping: one noise sample per tile. Walkable below the
  // threshold (matches the map generator tool's "walkable below" convention),
  // solid at or above it.
  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const n = fbm(noise2D, x, y, octaves, persistence, lacunarity, scale);
      if (n >= threshold) walls.add(x + ',' + y);
    }
  }
  const carve = (x, y) => { if (x > 0 && y > 0 && x < mapW - 1 && y < mapH - 1) walls.delete(x + ',' + y); };
  const SPAWN_SAFETY_R = 3;
  for (let y = spawnY - SPAWN_SAFETY_R; y <= spawnY + SPAWN_SAFETY_R; y++) {
    for (let x = spawnX - SPAWN_SAFETY_R; x <= spawnX + SPAWN_SAFETY_R; x++) {
      if (Math.abs(x - spawnX) + Math.abs(y - spawnY) <= SPAWN_SAFETY_R) carve(x, y);
    }
  }
  return walls;
}
