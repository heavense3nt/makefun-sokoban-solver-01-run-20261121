// Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// Approach: the levels are a hallway with 1-4 rooms off it, and a box pushed
// out of a room can never come back, so every room is solved on its own and
// the pushes are concatenated. Each room is solved push-optimally with an A*
// over pushes (macro-push search): a state is the sorted box cells plus the
// player's reachable region (canonicalised to its lowest cell), the heuristic
// is the minimum-cost assignment of boxes to goals over precomputed BFS
// distances, and dead states are pruned with static dead squares (optimistic
// pull-reachability from the goals) and 2x2 freeze blocks. The work budget is
// a fixed node cap per room, never the clock, so two runs are byte-identical.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions: [dx, dy, walk letter, push letter]. Opposite of d is d ^ 1.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const WALK = ['u', 'd', 'l', 'r'];
const PUSH = ['U', 'D', 'L', 'R'];

// Deterministic work budgets (node expansions), never the wall clock.
const CAP_A = 150_000;
const CAP_B = 1_500_000;
const CAP_GREEDY = 500_000;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goal: Uint8Array;
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goal, boxes, player };
}

interface Room {
  door: number; // level cell of the room's single door (in the row beside the hallway)
  entry: number; // hallway cell just outside the door
  cells: number[]; // room floor cells (level indices, door included)
  boxes: number[]; // the room's boxes (level indices)
  goals: number[]; // the room's goals (level indices)
}

function findRooms(lv: Level): Room[] {
  const hr = Math.floor(lv.player / lv.w);
  const rooms: Room[] = [];
  for (const r of [hr - 1, hr + 1]) {
    if (r < 0 || r >= lv.h) continue;
    for (let x = 0; x < lv.w; x++) {
      const c = r * lv.w + x;
      if (lv.wall[c]) continue;
      const e = r === hr - 1 ? c + lv.w : c - lv.w;
      if (lv.wall[e]) continue; // not a door: no hallway cell beside it
      // Flood the room from the door, never stepping into the hallway row.
      const seen = new Set<number>([c]);
      const stack = [c];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        const cx = cur % lv.w;
        const cy = Math.floor(cur / lv.w);
        for (let d = 0; d < 4; d++) {
          const nx = cx + DX[d]!;
          const ny = cy + DY[d]!;
          if (nx < 0 || nx >= lv.w || ny < 0 || ny >= lv.h || ny === hr) continue;
          const n = ny * lv.w + nx;
          if (lv.wall[n] || seen.has(n)) continue;
          seen.add(n);
          stack.push(n);
        }
      }
      const cells = [...seen].sort((a, b) => a - b);
      const cellSet = new Set(cells);
      rooms.push({
        door: c,
        entry: e,
        cells,
        boxes: lv.boxes.filter((b) => cellSet.has(b)),
        goals: cells.filter((cell) => lv.goal[cell]),
      });
    }
  }
  rooms.sort((a, b) => a.door - b.door);
  return rooms;
}

// Breadth-first walk over floor cells, treating the given box cells as walls.
// Returns the move letters (lowercase) from `from` to `to`, or null.
function walkPath(lv: Level, from: number, to: number, boxSet: Set<number>): string | null {
  if (from === to) return '';
  const prev = new Int32Array(lv.w * lv.h).fill(-2);
  prev[from] = -1;
  const queue = [from];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi]!;
    if (cur === to) break;
    const cx = cur % lv.w;
    const cy = Math.floor(cur / lv.w);
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d]!;
      const ny = cy + DY[d]!;
      if (nx < 0 || nx >= lv.w || ny < 0 || ny >= lv.h) continue;
      const n = ny * lv.w + nx;
      if (lv.wall[n] || boxSet.has(n) || prev[n] !== -2) continue;
      prev[n] = cur * 4 + d;
      queue.push(n);
    }
  }
  if (prev[to] === -2) return null;
  let moves = '';
  for (let cur = to; cur !== from; ) {
    const p = prev[cur]!;
    const d = p % 4;
    moves = WALK[d]! + moves;
    cur = Math.floor(p / 4);
  }
  return moves;
}

interface PushStep {
  box: number; // level cell the box is pushed from
  dir: number; // 0..3
}

// Push-optimal A* for one room. Boxes are the room's boxes (level indices),
// the player starts at the room's entry cell. needsExit: the goal test also
// requires the door free and reachable, so the player can leave the room
// afterwards (needed for every room but the last one solved). Returns the
// push list, or null when no plan is found within the work budgets.
function solveRoom(lv: Level, room: Room, needsExit: boolean): PushStep[] | null {
  const k = room.boxes.length;
  if (k === 0) return [];
  if (k > room.goals.length) return null;
  // Local indices over the room floor plus the entry cell.
  const local = new Map<number, number>();
  room.cells.forEach((c, i) => local.set(c, i));
  const entryLocal = room.cells.length;
  local.set(room.entry, entryLocal);
  const n = room.cells.length + 1;
  const cellOf = [...room.cells, room.entry];
  // Local adjacency: nb[i][d] = local index or -1.
  const nb: number[][] = [];
  for (let i = 0; i < n; i++) {
    const c = cellOf[i]!;
    const cx = c % lv.w;
    const cy = Math.floor(c / lv.w);
    const row: number[] = [];
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d]!;
      const ny = cy + DY[d]!;
      if (nx < 0 || nx >= lv.w || ny < 0 || ny >= lv.h) {
        row.push(-1);
        continue;
      }
      const m = local.get(ny * lv.w + nx);
      row.push(m === undefined ? -1 : m);
    }
    nb.push(row);
  }
  const goalLocal = new Set(room.goals.map((g) => local.get(g)!));
  const doorLocal = local.get(room.door)!;
  const boxLocal0 = room.boxes.map((b) => local.get(b)!).sort((a, b) => a - b);

  // BFS distances from each goal over the room floor (boxes ignored).
  const distFromGoal: Int32Array[] = [];
  for (const g of goalLocal) {
    const dist = new Int32Array(n).fill(-1);
    dist[g] = 0;
    const q = [g];
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi]!;
      for (let d = 0; d < 4; d++) {
        const m = nb[cur]![d]!;
        if (m >= 0 && dist[m] < 0) {
          dist[m] = dist[cur]! + 1;
          q.push(m);
        }
      }
    }
    distFromGoal.push(dist);
  }
  const goalList = [...goalLocal];

  // Static dead squares: optimistic pull-reachability from the goals. A box
  // can be pulled from b to a neighbour a when the player can stand on a and
  // step beyond it (to a + d, where d is the pull direction): the pull drags
  // the box from b into a while the player steps past it. Treating every
  // floor cell as standable over-approximates, so a cell this BFS never
  // reaches can never hold a box that reaches a goal.
  const live = new Uint8Array(n);
  {
    const q = [...goalLocal];
    for (const g of goalLocal) live[g] = 1;
    for (let qi = 0; qi < q.length; qi++) {
      const b = q[qi]!;
      for (let d = 0; d < 4; d++) {
        const a = nb[b]![d]!;
        if (a < 0 || live[a]) continue;
        const beyond = nb[a]![d]!;
        if (beyond >= 0) {
          live[a] = 1;
          q.push(a);
        }
      }
    }
  }

  // 2x2 freeze blocks: four cells that are wall-or-box with no goal in them.
  // Each block is [level cells], with a static-solid flag per cell (wall, or
  // outside the search floor, which acts as a wall for this room's boxes).
  const floorSet = new Set(cellOf);
  const blocks: { cells: number[]; solid: boolean[]; hasGoal: boolean }[] = [];
  {
    let minX = lv.w;
    let maxX = -1;
    let minY = lv.h;
    let maxY = -1;
    for (const c of cellOf) {
      minX = Math.min(minX, c % lv.w);
      maxX = Math.max(maxX, c % lv.w);
      minY = Math.min(minY, Math.floor(c / lv.w));
      maxY = Math.max(maxY, Math.floor(c / lv.w));
    }
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x < maxX; x++) {
        const cs = [y * lv.w + x, y * lv.w + x + 1, (y + 1) * lv.w + x, (y + 1) * lv.w + x + 1];
        const solid = cs.map((c) => lv.wall[c] === 1 || !floorSet.has(c));
        const hasGoal = cs.some((c) => lv.goal[c] === 1);
        if (!hasGoal && cs.some((c, i) => !solid[i])) blocks.push({ cells: cs, solid, hasGoal });
      }
    }
  }
  const frozen = (boxSet: Set<number>): boolean => {
    for (const b of blocks) {
      let allSolid = true;
      let anyBox = false;
      for (let i = 0; i < 4; i++) {
        const c = b.cells[i]!;
        if (b.solid[i]) continue;
        if (boxSet.has(c)) {
          anyBox = true;
          continue;
        }
        allSolid = false;
        break;
      }
      if (allSolid && anyBox) return true;
    }
    return false;
  };

  // Minimum-cost assignment of boxes to goals (brute force over permutations;
  // k <= 4, so at most 24). Infinity when no box-to-goal bijection is possible.
  const perms: number[][] = [];
  {
    const used = new Array(k).fill(false);
    const cur: number[] = [];
    const gen = (): void => {
      if (cur.length === k) {
        perms.push([...cur]);
        return;
      }
      for (let g = 0; g < k; g++) {
        if (used[g]) continue;
        used[g] = true;
        cur.push(g);
        gen();
        cur.pop();
        used[g] = false;
      }
    };
    gen();
  }
  const heuristic = (boxes: number[]): number => {
    let best = Infinity;
    for (const p of perms) {
      let sum = 0;
      let ok = true;
      for (let i = 0; i < k; i++) {
        const d = distFromGoal[p[i]!]![boxes[i]!]!;
        if (d < 0) {
          ok = false;
          break;
        }
        sum += d;
      }
      if (ok && sum < best) best = sum;
    }
    return best;
  };

  // Pack sorted local box indices (6 bits each, 63 = absent) plus the player.
  const pack = (boxes: number[], player: number): number => {
    let p = 63;
    for (let i = k - 1; i >= 0; i--) p = p * 64 + boxes[i]!;
    return p * 64 + player;
  };
  const unpack = (packed: number): number[] => {
    const out: number[] = [];
    let p = Math.floor(packed / 64);
    for (let i = 0; i < k; i++) {
      out.push(p % 64);
      p = Math.floor(p / 64);
    }
    return out;
  };

  // Flood the player's reachable region over the search floor minus boxes;
  // returns the visited mask and its lowest cell (the canonical player cell).
  const flood = (start: number, boxAt: Uint8Array): { seen: Uint8Array; min: number } => {
    const seen = new Uint8Array(n);
    seen[start] = 1;
    const q = [start];
    let min = start;
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi]!;
      for (let d = 0; d < 4; d++) {
        const m = nb[cur]![d]!;
        if (m >= 0 && !seen[m] && !boxAt[m]) {
          seen[m] = 1;
          if (m < min) min = m;
          q.push(m);
        }
      }
    }
    return { seen, min };
  };

  // One A* run. strict: the goal test also requires the door free and
  // reachable, so the player can leave the room afterwards. useG: false makes
  // it greedy best-first (f = h) instead of A* (f = g + h).
  const search = (cap: number, strict: boolean, useG: boolean): PushStep[] | null => {
    const sp: number[] = [];
    const sb: number[] = [];
    const sg: number[] = [];
    const parent: number[] = [];
    const pmove: number[] = []; // boxLocal * 4 + dir
    const best = new Map<number, number>();
    const heap: [number, number, number, number][] = []; // [f, -g, counter, state]
    let counter = 0;
    const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
      a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
    const heapPush = (e: [number, number, number, number]): void => {
      let i = heap.length;
      heap.push(e);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!less(heap[i]!, heap[p]!)) break;
        [heap[i], heap[p]] = [heap[p]!, heap[i]!];
        i = p;
      }
    };
    const heapPop = (): [number, number, number, number] => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        for (let i = 0; ; ) {
          let c = 2 * i + 1;
          if (c >= heap.length) break;
          if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
          if (!less(heap[c]!, heap[i]!)) break;
          [heap[i], heap[c]] = [heap[c]!, heap[i]!];
          i = c;
        }
      }
      return top;
    };

    const boxAt0 = new Uint8Array(n);
    for (const b of boxLocal0) boxAt0[b] = 1;
    const startFlood = flood(entryLocal, boxAt0);
    const startKey = pack(boxLocal0, startFlood.min);
    const h0 = heuristic(boxLocal0);
    if (h0 === Infinity) return null;
    sp.push(startFlood.min);
    sb.push(pack(boxLocal0, 0));
    sg.push(0);
    parent.push(-1);
    pmove.push(-1);
    best.set(startKey, 0);
    heapPush([useG ? h0 : h0, 0, counter++, 0]);

    let expanded = 0;
    while (heap.length > 0) {
      const [, , , s] = heapPop();
      if (best.get(pack(unpack(sb[s]!), sp[s]!)) !== s) continue;
      const boxes = unpack(sb[s]!);
      const g = sg[s]!;
      const player = sp[s]!;
      // Goal: every box on a goal (and, when strict, the door free and
      // reachable so the player can walk out of the room afterwards).
      if (boxes.every((b) => goalLocal.has(b))) {
        if (!strict) return reconstruct(s);
        const boxAt = new Uint8Array(n);
        for (const b of boxes) boxAt[b] = 1;
        if (!boxAt[doorLocal]) {
          const fl = flood(player, boxAt);
          if (fl.seen[doorLocal]) return reconstruct(s);
        }
      }
      if (expanded >= cap) {
        return null;
      }
      expanded++;
      const boxAt = new Uint8Array(n);
      for (const b of boxes) boxAt[b] = 1;
      const { seen: reach } = flood(player, boxAt);
      for (let bi = 0; bi < k; bi++) {
        const b = boxes[bi]!;
        for (let d = 0; d < 4; d++) {
          const dest = nb[b]![d]!;
          if (dest < 0 || dest === entryLocal || boxAt[dest]) continue;
          const pushCell = nb[b]![d ^ 1]!;
          if (pushCell < 0 || !reach[pushCell]) continue;
          if (!live[dest]) continue; // box would land on a dead square
          const nb2 = [...boxes];
          nb2[bi] = dest;
          nb2.sort((x, y) => x - y);
          const boxSet = new Set(nb2.map((x) => cellOf[x]!));
          if (frozen(boxSet)) continue;
          const h = heuristic(nb2);
          if (h === Infinity) continue;
          const boxAt2 = new Uint8Array(n);
          for (const x of nb2) boxAt2[x] = 1;
          const fl2 = flood(b, boxAt2);
          const key = pack(nb2, fl2.min);
          const seenState = best.get(key);
          if (seenState !== undefined && sg[seenState]! <= g + 1) continue;
          const t = sp.length;
          sp.push(fl2.min);
          sb.push(pack(nb2, 0));
          sg.push(g + 1);
          parent.push(s);
          pmove.push(b * 4 + d);
          best.set(key, t);
          heapPush([useG ? g + 1 + h : h, -(g + 1), counter++, t]);
        }
      }
    }
    return null;

    function reconstruct(s: number): PushStep[] {
      const out: PushStep[] = [];
      for (let t = s; t > 0; t = parent[t]!) {
        const m = pmove[t]!;
        out.push({ box: cellOf[Math.floor(m / 4)]!, dir: m % 4 });
      }
      out.reverse();
      return out;
    }
  };

  // A* with the exit requirement (or without it), then a bigger budget, then
  // a greedy best-first fallback for the same requirement.
  const attempts: [number, boolean, boolean][] = needsExit
    ? [
        [CAP_A, true, true],
        [CAP_B, true, true],
        [CAP_GREEDY, true, false],
      ]
    : [
        [CAP_A, false, true],
        [CAP_B, false, true],
        [CAP_GREEDY, false, false],
      ];
  for (const [cap, strict, useG] of attempts) {
    const plan = search(cap, strict, useG);
    if (plan) {
      return plan;
    }
  }
  return null;
}

function solve(text: string): string {
  const lv = parseLevel(text);
  const rooms = findRooms(lv);
  if (rooms.length === 0) return '';
  // Solve every room twice: with the exit requirement and without it. The
  // room whose exit costs the most pushes goes last, where no exit is needed
  // (a room with no exit-satisfying plan at all must go last).
  const plans: { room: Room; strict: PushStep[] | null; loose: PushStep[] | null }[] = [];
  for (const room of rooms) {
    const strict = solveRoom(lv, room, true);
    const loose = solveRoom(lv, room, false);
    if (loose === null) return ''; // room unsolvable even without an exit
    plans.push({ room, strict, loose });
  }
  let last = 0;
  let bestGap = -1;
  plans.forEach((p, i) => {
    const gap = p.strict === null ? Infinity : p.strict.length - p.loose!.length;
    if (gap > bestGap) {
      bestGap = gap;
      last = i;
    }
  });
  const order = plans.map((_, i) => i).filter((i) => i !== last);
  order.push(last);
  const boxSet = new Set(lv.boxes);
  let player = lv.player;
  let moves = '';
  let pushes = 0;
  for (const i of order) {
    const { room, strict, loose } = plans[i]!;
    const plan = i === last ? loose! : strict ?? loose!;
    const w1 = walkPath(lv, player, room.entry, boxSet);
    if (w1 === null) return '';
    moves += w1;
    player = room.entry;
    for (const step of plan) {
      const pushCell = step.box - DY[step.dir]! * lv.w - DX[step.dir]!;
      const w2 = walkPath(lv, player, pushCell, boxSet);
      if (w2 === null) return '';
      moves += w2;
      moves += PUSH[step.dir]!;
      boxSet.delete(step.box);
      const dest = step.box + DY[step.dir]! * lv.w + DX[step.dir]!;
      boxSet.add(dest);
      player = step.box;
      pushes++;
    }
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
