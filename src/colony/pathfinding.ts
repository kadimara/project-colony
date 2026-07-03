// @ts-nocheck
// Grid pathfinding: 4-directional BFS shortest paths, BFS-to-adjacent (for
// targets you can't stand on top of), and Bresenham line-of-sight.
// `walkable`/`isWall` are passed in so this stays independent of any
// particular game's entity/terrain state.

export function isAdjacent(ax, ay, bx, by) {
  return Math.abs(ax - bx) + Math.abs(ay - by) === 1;
}

export function findPath(startX, startY, goalX, goalY, walkable) {
  if (!walkable(goalX, goalY)) return [];
  if (startX === goalX && startY === goalY) return [];
  const key = (x, y) => x + ',' + y;
  const visited = new Set([key(startX, startY)]);
  const cameFrom = new Map();
  const queue = [{ x: startX, y: startY }]; let head = 0;
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
  const path = []; let cur = { x: goalX, y: goalY };
  while (!(cur.x === startX && cur.y === startY)) {
    path.push(cur); cur = cameFrom.get(key(cur.x, cur.y));
    if (!cur) return [];
  }
  path.reverse();
  return path;
}

// BFS to the nearest tile adjacent to (goalX,goalY) — used for obstacles,
// which you can never stand on top of.
export function bfsToAdjacent(startX, startY, goalX, goalY, walkable) {
  const isGoal = (x, y) => isAdjacent(x, y, goalX, goalY);
  if (isGoal(startX, startY)) return [];
  const key = (x, y) => x + ',' + y;
  const visited = new Set([key(startX, startY)]);
  const cameFrom = new Map();
  const queue = [{ x: startX, y: startY }]; let head = 0;
  const dirs = [[0,-1],[0,1],[-1,0],[1,0]];
  let goalNode = null;
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
  const path = []; let cur = goalNode;
  while (!(cur.x === startX && cur.y === startY)) {
    path.push(cur); cur = cameFrom.get(key(cur.x, cur.y));
    if (!cur) return [];
  }
  path.reverse();
  return path;
}

// true if no wall tile lies strictly between (ax,ay) and (bx,by)
export function hasLineOfSight(ax, ay, bx, by, isWall) {
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
