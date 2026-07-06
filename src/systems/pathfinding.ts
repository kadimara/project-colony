// Grid pathfinding: 4-directional BFS shortest paths, BFS-to-adjacent (for
// targets you can't stand on top of), and Bresenham line-of-sight.
// `walkable`/`isWall` are passed in so this stays independent of any
// particular game's entity/terrain state.
import type { Point } from '../types/types';

export type Walkable = (x: number, y: number) => boolean;
export type IsWall = (x: number, y: number) => boolean;

export function isAdjacent(ax: number, ay: number, bx: number, by: number): boolean {
  return Math.abs(ax - bx) + Math.abs(ay - by) === 1;
}

export function findPath(startX: number, startY: number, goalX: number, goalY: number, walkable: Walkable): Point[] {
  if (!walkable(goalX, goalY)) return [];
  if (startX === goalX && startY === goalY) return [];
  const key = (x: number, y: number) => x + ',' + y;
  const visited = new Set<string>([key(startX, startY)]);
  const cameFrom = new Map<string, Point>();
  const queue: Point[] = [{ x: startX, y: startY }]; let head = 0;
  const dirs = [[0,-1],[0,1],[-1,0],[1,0]];
  while (head < queue.length) {
    const cur = queue[head++];
    if (cur.x === goalX && cur.y === goalY) break;
    for (const [dx, dy] of dirs) {
      const nx = cur.x + dx, ny = cur.y + dy, k = key(nx, ny);
      if (visited.has(k) || !walkable(nx, ny)) continue;
      visited.add(k); cameFrom.set(k, cur); queue.push({ x: nx, y: ny });
    }
  }
  if (!visited.has(key(goalX, goalY))) return [];
  const path: Point[] = []; let cur: Point | undefined = { x: goalX, y: goalY };
  while (!(cur.x === startX && cur.y === startY)) {
    path.push(cur); cur = cameFrom.get(key(cur.x, cur.y));
    if (!cur) return [];
  }
  path.reverse();
  return path;
}

// cost of entering (x,y); null means impassable
export type Cost = (x: number, y: number) => number | null;

// weighted shortest path (Dijkstra) for callers where some tiles are
// passable but expensive rather than a flat yes/no — e.g. a scout tunneling
// through walls, which should still prefer an all-open route when one is
// cheap enough. The binary heap below is kept local/inline rather than a
// reusable module since this is the only weighted search in the game.
export function findWeightedPath(startX: number, startY: number, goalX: number, goalY: number, cost: Cost): Point[] {
  if (cost(goalX, goalY) === null) return [];
  if (startX === goalX && startY === goalY) return [];
  const key = (x: number, y: number) => x + ',' + y;

  const heap: [number, number, number][] = []; // [dist, x, y]
  const push = (item: [number, number, number]) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]]; i = p;
    }
  };
  const pop = (): [number, number, number] => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last; let i = 0;
      while (true) {
        const l = 2 * i + 1, r = 2 * i + 2; let s = i;
        if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
        if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
        if (s === i) break;
        [heap[i], heap[s]] = [heap[s], heap[i]]; i = s;
      }
    }
    return top;
  };

  const dist = new Map<string, number>([[key(startX, startY), 0]]);
  const cameFrom = new Map<string, Point>();
  const visited = new Set<string>();
  const dirs = [[0,-1],[0,1],[-1,0],[1,0]];
  push([0, startX, startY]);

  while (heap.length) {
    const [d, cx, cy] = pop();
    const ck = key(cx, cy);
    if (visited.has(ck)) continue;
    visited.add(ck);
    if (cx === goalX && cy === goalY) break;
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy, nk = key(nx, ny);
      if (visited.has(nk)) continue;
      const c = cost(nx, ny);
      if (c === null) continue;
      const nd = d + c;
      if (!dist.has(nk) || nd < dist.get(nk)!) {
        dist.set(nk, nd); cameFrom.set(nk, { x: cx, y: cy }); push([nd, nx, ny]);
      }
    }
  }

  if (!visited.has(key(goalX, goalY))) return [];
  const path: Point[] = []; let cur: Point | undefined = { x: goalX, y: goalY };
  while (!(cur.x === startX && cur.y === startY)) {
    path.push(cur); cur = cameFrom.get(key(cur.x, cur.y));
    if (!cur) return [];
  }
  path.reverse();
  return path;
}

// BFS to the nearest tile adjacent to (goalX,goalY) — used for obstacles,
// which you can never stand on top of.
export function bfsToAdjacent(startX: number, startY: number, goalX: number, goalY: number, walkable: Walkable): Point[] {
  const isGoal = (x: number, y: number) => isAdjacent(x, y, goalX, goalY);
  if (isGoal(startX, startY)) return [];
  const key = (x: number, y: number) => x + ',' + y;
  const visited = new Set<string>([key(startX, startY)]);
  const cameFrom = new Map<string, Point>();
  const queue: Point[] = [{ x: startX, y: startY }]; let head = 0;
  const dirs = [[0,-1],[0,1],[-1,0],[1,0]];
  let goalNode: Point | null = null;
  while (head < queue.length && !goalNode) {
    const cur = queue[head++];
    for (const [dx, dy] of dirs) {
      const nx = cur.x + dx, ny = cur.y + dy, k = key(nx, ny);
      if (visited.has(k) || !walkable(nx, ny)) continue;
      visited.add(k); cameFrom.set(k, cur);
      if (isGoal(nx, ny)) { goalNode = { x: nx, y: ny }; break; }
      queue.push({ x: nx, y: ny });
    }
  }
  if (!goalNode) return [];
  const path: Point[] = []; let cur: Point | undefined = goalNode;
  while (!(cur.x === startX && cur.y === startY)) {
    path.push(cur); cur = cameFrom.get(key(cur.x, cur.y));
    if (!cur) return [];
  }
  path.reverse();
  return path;
}

// true if no wall tile lies strictly between (ax,ay) and (bx,by)
export function hasLineOfSight(ax: number, ay: number, bx: number, by: number, isWall: IsWall): boolean {
  let x0 = ax, y0 = ay;
  const x1 = bx, y1 = by;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (true) {
    if (!(x0 === ax && y0 === ay) && !(x0 === x1 && y0 === y1) && isWall(x0, y0)) return false;
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return true;
}
