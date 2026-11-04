// 移动范围：按地形、道路、河流与桥梁、敌方 ZOC、堆叠和单位特殊规则，算出选中算子本阶段能停下的格
const ARMORED = new Set(['armor', 'mech', 'art']);

export function initMove({ D, HEX, RIVER, BRIDGE, hexDist }) {
  const ROAD = new Set((D.roads || []).map((e) => [...e].sort().join('|')));
  const key = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  // 相邻格（odd-q 竖列错位）与它在 6 条边中的方向（0 = 右下，逆时针……按屏幕角度算）
  const byAx = new Map();
  const ax = (h) => [h.c, h.r - (h.c - (h.c & 1)) / 2];
  for (const h of HEX.values()) byAx.set(ax(h).join(','), h);
  const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const NB = new Map();
  for (const h of HEX.values()) {
    const [q, r] = ax(h);
    NB.set(h.id, DIRS.map(([dq, dr]) => byAx.get(q + dq + ',' + (r + dr))).filter(Boolean));
  }
  const entryHex = {};
  for (const e of Object.values(D.setup.entry)) for (const u of e.units) entryHex[u] = e.hex;

  /**
   * ctx: { units: [{p, hex}]（地图上的战斗单位与指挥部）, mark(hexId, type), turn, phase, fuel, disguised, inTray }
   * 返回 { hexes: Set<hexId>, note }
   */
  function range(p, ctx) {
    const u = p.u, side = u.side;
    if (u.kind === 'air') return { hexes: new Set(), note: '' };
    const here = ctx.hexOf(p);
    const fromTray = !here && ctx.inTray(p) === 'reinfUS';
    if (!here && !fromTray) return { hexes: new Set(), note: '' };
    if (fromTray && ctx.turn < 4) return { hexes: new Set(), note: '美军增援第 4 回合起才能进场' };
    if (side === 'US' && ctx.turn === 1) return { hexes: new Set(), note: '第 1 回合美军不能移动' };
    if (here && ctx.mark(here.id, 'P')) return { hexes: new Set(), note: '被压制：本回合不能移动' };

    const s = p.flip ? u.red : u.full;
    let mp = s[2], full = true, notes = [];
    if (here && ctx.mark(here.id, 'F')) { mp = Math.max(1, mp - 1); full = false; notes.push('疲劳 MP−1'); }
    if (u.tags.includes('peiper') && (u.kind === 'armor' || u.kind === 'mech') && ctx.fuel === ctx.turn) { mp = Math.floor(mp / 2); full = false; notes.push('燃油危机 MP 减半'); }
    if (here && u.id !== 'USCCB') {
      const ccb = ctx.units.find((o) => o.p.u.id === 'USCCB' && side === 'US' && hexDist(o.hex, here) === 1);
      if (ccb) { mp += 1; notes.push('CCB 指挥中心 MP+1'); }
    }

    // 地图上的占位与敌方 ZOC
    const occ = new Map();
    for (const o of ctx.units) if (o.p !== p && o.p.u.kind !== 'hq') occ.set(o.hex.id, o.p);
    const zoc = new Set();
    for (const o of ctx.units) {
      const e = o.p.u;
      if (e.side === side || e.kind === 'hq') continue;
      if (e.id === 'G150' && ctx.disguised) continue;
      for (const n of NB.get(o.hex.id)) zoc.add(n.id);
    }
    const blown = (a, b) => ctx.mark(a, 'B') || ctx.mark(b, 'B');
    const pontoon = (a, b) => ctx.mark(a, 'W') || ctx.mark(b, 'W');

    function step(a, b, first, roadOnly) {
      const o = occ.get(b.id);
      if (o && o.u.side !== side) return null;                // 不能进入敌方单位所在格
      const e = key(a.id, b.id);
      if (RIVER.has(e)) {
        if (BRIDGE.has(e) && !blown(a.id, b.id)) return 2;
        if (pontoon(a.id, b.id) && !u.tags.includes('heavy')) return 2;
        return null;
      }
      if (ROAD.has(e)) return 0.5;
      if (roadOnly) return null;
      let c;
      if (b.t === 'f') c = u.tags.includes('snow') && ctx.turn === 1 ? 1 : ARMORED.has(u.kind) ? 3 : 2;
      else if (b.t === 'h') c = 3;
      else c = (b.t === 'c' && u.tags.includes('recon')) ? 0.5 : 1;
      if (first && fromTray && u.tags.includes('thunder') && b.t === 'c') c = Math.max(0, c - 1);
      return c;
    }

    function dijkstra(budget, roadOnly) {
      const best = new Map(), pq = [];
      const starts = here ? [here] : [HEX.get(entryHex[u.id])].filter(Boolean);
      for (const h of starts) { best.set(h.id, 0); pq.push([0, h, true]); }
      while (pq.length) {
        pq.sort((x, y) => x[0] - y[0]);
        const [c, h, first] = pq.shift();
        if (c > best.get(h.id)) continue;
        if (!first && zoc.has(h.id)) continue;               // 进入敌方 ZOC 必须停下
        for (const n of NB.get(h.id)) {
          const sc = step(h, n, first, roadOnly);
          if (sc == null) continue;
          let nc = c + sc;
          if (first && here && full && nc > budget) nc = budget;   // 最低移动：MP 完整时总能走 1 格
          if (nc <= budget + 1e-9 && nc < (best.get(n.id) ?? 1e9)) { best.set(n.id, nc); pq.push([nc, n, false]); }
        }
      }
      return best;
    }

    const reach = dijkstra(mp, false);
    if (u.tags.includes('motor')) {                         // 摩托化行军：全程沿道路时 MP+2
      for (const [id, c] of dijkstra(mp + 2, true)) if (!reach.has(id)) reach.set(id, c);
      notes.push('沿道路 MP+2');
    }
    const hexes = new Set();
    for (const id of reach.keys()) {
      if (here && id === here.id) continue;
      if (u.kind === 'hq') { const o = occ.get(id); if (o && o.u.side === side) hexes.add(id); continue; }
      if (occ.has(id)) continue;                            // 不能停在友军战斗单位所在格
      hexes.add(id);
    }
    if (fromTray) { const eh = entryHex[u.id]; if (eh && !occ.has(eh)) hexes.add(eh); }
    return { hexes, note: `MP ${mp}${notes.length ? '（' + notes.join('，') + '）' : ''}` };
  }

  // 一组格子的外轮廓：返回每条外边的两个端点（世界坐标）
  function outline(ids) {
    const segs = [];
    const R = D.hexR / 10;
    for (const id of ids) {
      const h = HEX.get(id);
      const nbAt = new Map();
      for (const n of NB.get(id)) nbAt.set(Math.round(((Math.atan2(n.Z - h.Z, n.X - h.X) * 180 / Math.PI - 30) / 60 + 6)) % 6, n.id);
      for (let k = 0; k < 6; k++) {
        const n = nbAt.get(k);
        if (n && ids.has(n)) continue;
        const a0 = (60 * k) * Math.PI / 180, a1 = (60 * k + 60) * Math.PI / 180;
        segs.push([h.X, h.Z, a0, a1, R]);
      }
    }
    return segs;
  }

  return { range, outline, NB, ROAD };
}
