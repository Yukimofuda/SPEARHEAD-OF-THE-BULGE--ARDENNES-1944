// 规则辅助：战斗与炮击计算、回合流程、胜利点（按最终修订版规则书）
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const PHASES = [
  ['准备阶段', '整补 1 个损伤单位（有补给且不在敌方 ZOC）；移除压制与断补标记；燃油检定；天气（第 4 回合起）；补给检查（第 1 回合免查）'],
  ['空袭阶段', '天气晴朗时，美军 P-47 空袭 1 个德军单位：1-3 压制，4-6 造成 1 点损伤'],
  ['美军行动阶段', '增援进场（第 4 回合起）→ 移动 → 战斗 → 工兵。第 1 回合美军不能移动和主动进攻'],
  ['德军行动阶段', '移动 → 战斗 → 工兵（修桥、架浮桥）'],
  ['炮兵阶段', '美军炮兵全部先射击，然后德军炮兵射击；移动过的炮兵不能射击（SS1 炮兵团例外）'],
  ['结算阶段', '更新胜利点城镇控制；第 8 回合结束时计算胜利点'],
];
const CRT = (d) => d <= -5 ? '攻方D1' : d <= -3 ? '攻方R1' : d <= -1 ? '无' : d <= 1 ? 'F' : d === 2 ? 'R1' : d === 3 ? 'D1+R1' : d === 4 ? 'D1+R2' : d === 5 ? 'D2' : 'D2+R1';
const CRT_UP = ['R1', 'D1+R1', 'D1+R2', 'D2', 'D2+R1'];
const ART = (d) => d <= 0 ? '无' : ['P1', 'P1+X', 'D1+P1', 'P2+X', 'D1+X'][d - 1] || 'D1+A';
const ART_UP = ['P1', 'P1+X', 'D1+P1', 'P2+X', 'D1+X', 'D1+A'];
const EXPLAIN = {
  '攻方D1': '进攻严重受挫，攻方承受 1 点损伤。', '攻方R1': '进攻被击退，攻方后撤 1 格。', '无': '攻击没有取得效果。',
  'F': '守方疲劳。', 'R1': '守方后撤 1 格。', 'D1+R1': '守方受 1 点损伤并后撤 1 格。', 'D1+R2': '守方受 1 点损伤并后撤 2 格。',
  'D2': '守方受 2 点损伤。', 'D2+R1': '守方受 2 点损伤并后撤 1 格。',
  'P1': '目标疲劳。', 'P1+X': '目标疲劳并后撤 1 格。', 'D1+P1': '目标受 1 点损伤并疲劳。', 'P2+X': '目标疲劳（持续两个本方行动阶段）并后撤 1 格。',
  'D1+X': '目标受 1 点损伤，后撤 1 格并疲劳。', 'D1+A': '目标受 1 点损伤，目标和所有相邻单位疲劳。',
};

export function initRules(api) {
  const { D, HEX, RIVER, OBJ, TRAYS, TERRAIN, st, pieces, hexDist, trayAt, pieceHex } = api;
  let mode = 'assault', att = null, def = null, extra = { att: 0, def: 0 }, last = null;

  const statsOf = (p) => (p.flip ? p.u.red : p.u.full);
  const markersOn = (h, type) => !!h && [...pieces.values()].some((q) => q.kind === 'marker' && q.type === type && pieceHex(q)?.id === h.id);
  const isVGD = (p) => p.u.tags.includes('VGD');

  function compute() {
    if (!att || !def) return null;
    const ah = pieceHex(att), dh = pieceHex(def), am = [], dm = [], warn = [];
    const T1 = st.turn === 1;
    const sa = statsOf(att), sd = statsOf(def);
    if (!ah || !dh) warn.push('有算子不在地图格上');
    if (mode === 'assault') {
      if (att.u.side === def.u.side) warn.push('攻守双方是同一阵营');
      if (ah && dh && hexDist(ah, dh) !== 1) warn.push('目标不相邻（直接战斗只能攻击相邻格）');
      if (att.u.kind === 'art') warn.push('炮兵请用“炮击”');
      if (markersOn(ah, 'F')) warn.push('攻方处于疲劳，不能主动进攻');
      if (dh) {
        const town = dh.t === 't', hill = dh.t === 'h', forest = dh.t === 'f';
        const lose = T1 && def.u.side === 'US';
        if (town) dm.push(['城镇', 2]);
        if (hill) lose ? dm.push(['高地（奇袭失效）', 0]) : dm.push(['高地', 1]);
        if (forest && ['inf', 'eng'].includes(def.u.kind)) lose ? dm.push(['森林（奇袭失效）', 0]) : dm.push(['森林', 1]);
        if (markersOn(dh, 'K')) dm.push(['工事', 1]);
        if (markersOn(dh, 'F')) { dm.push(['疲劳', -1]); if (def.u.id === 'US422') dm.push(['缺乏经验', -1]); }
      }
      if (ah && dh && RIVER.has([ah.id, dh.id].sort().join('|'))) { am.push(['跨河', -1]); dm.push(['河流', 1]); }
      if (ah && dh && ah.t === 'h' && dh.t !== 'h') am.push(['从高地攻击', 1]);
      if (T1 && att.u.side === 'GE') am.push(['奇袭', 1]);
      if (T1 && def.u.side === 'US') dm.push(['情报真空', -1]);
      if (att.u.id === 'GPz1') am.push(['装甲突击', 2]);
      if (att.u.id === 'US508' && isVGD(def)) am.push(['老兵经验', 1]);
      if (att.u.id === 'GPg25' && markersOn(dh, 'F')) am.push(['侧翼掩护', 1]);
      if (def.u.id === 'USM10' && att.u.kind === 'armor') dm.push(['伏击', 1]);
      if (def.u.id === 'GJg12' && dh && ['f', 'h'].includes(dh.t)) dm.push(['追猎者', 1]);
      if (att.u.id === 'GPi277' && dh && ['f', 'h'].includes(dh.t)) {
        const i = dm.findIndex(([n]) => n === '森林' || n === '高地'); if (i >= 0) dm[i] = [dm[i][0] + '（爆破无视）', 0];
      }
    } else {
      if (att.u.kind !== 'art') warn.push('射击方不是炮兵单位');
      if (ah && dh && hexDist(ah, dh) > sa[3]) warn.push(`目标超出射程 R${sa[3]}`);
      if (dh) {
        if (dh.t === 't') dm.push(['城镇', 2]); else if (dh.t === 'h') dm.push(['高地', 1]); else if (dh.t === 'f') dm.push(['森林', 1]);
        if (markersOn(dh, 'K')) dm.push(['工事', 1]);
        if (att.u.tags.includes('heavy_art') && !['t', 'f'].includes(dh.t)) am.push(['重炮/火箭炮', 1]);
      }
      if ($('#obsAdj').checked) am.push(['观察哨相邻', 1]);
      if (def.u.id === 'GFj9') am.push(['防炮击', -2]);
    }
    const sum = (l) => l.reduce((a, [, v]) => a + v, 0);
    const A = sa[0] + sum(am) + extra.att;
    const Dv = mode === 'assault' ? sd[1] + sum(dm) + extra.def : sum(dm) + extra.def;
    return { am, dm, warn, A, D: Dv, baseA: sa[0], baseD: mode === 'assault' ? sd[1] : 0 };
  }

  function slotHtml(p, role) {
    if (!p) return `<span class="label">${role === 'att' ? '攻方 / 炮兵' : '守方 / 目标'}</span><span class="hint">点选算子后按 ${role === 'att' ? 'A' : 'D'}</span>`;
    const s = statsOf(p), h = pieceHex(p);
    return `<span class="label">${role === 'att' ? '攻方' : '守方'} · ${p.u.side === 'US' ? '美军' : '德军'}</span><b>${esc(p.u.name)}</b>
      <span class="stat num">${s.join('-')}</span><span class="hint">${h ? h.id + ' ' + TERRAIN[h.t] : '不在地图上'}${p.flip ? ' · 损伤面' : ''}</span>`;
  }
  function modsHtml(list, base, total, label) {
    return `<div><span>${label}</span><span class="num">${base}</span></div>` +
      list.map(([n, v]) => `<div><span>${esc(n)}</span><span class="num ${v < 0 ? 'neg' : v > 0 ? 'pos' : ''}">${v >= 0 ? '+' : ''}${v}</span></div>`).join('') +
      `<div style="border-top:1px solid var(--line);padding-top:2px"><b>合计</b><b class="num">${total}</b></div>`;
  }
  function renderCombat() {
    $('#attSlot').innerHTML = slotHtml(att, 'att'); $('#attSlot').classList.toggle('filled', !!att);
    $('#defSlot').innerHTML = slotHtml(def, 'def'); $('#defSlot').classList.toggle('filled', !!def);
    $('#attExtra').textContent = extra.att; $('#defExtra').textContent = extra.def;
    $('#obsRow').hidden = mode !== 'arty';
    const c = compute();
    $('#attMods').innerHTML = c ? modsHtml(c.am, c.baseA, c.A + (extra.att ? '' : ''), mode === 'assault' ? '攻击力 A' : '炮兵 A') + (extra.att ? `<div><span>额外修正</span><span class="num">${extra.att > 0 ? '+' : ''}${extra.att}</span></div>` : '') : '';
    $('#defMods').innerHTML = c ? modsHtml(c.dm, c.baseD, c.D, mode === 'assault' ? '防御力 D' : '目标修正') + (extra.def ? `<div><span>额外修正</span><span class="num">${extra.def > 0 ? '+' : ''}${extra.def}</span></div>` : '') : '';
    $('#rollCombat').disabled = !c;
    if (c && c.warn.length) $('#attMods').innerHTML += `<div class="neg">⚠ ${c.warn.map(esc).join('；')}</div>`;
  }

  async function doRoll(rerollDef = false) {
    const c = compute(); if (!c) return;
    $('#rollCombat').disabled = true;
    let ra, rd;
    if (rerollDef && last) {
      const f = await api.rollDice(['def'], 'Nuts! 重掷'); if (!f) return;
      ra = last.ra; rd = f[0];
    } else {
      const f = await api.rollDice(['att', 'def'], mode === 'assault' ? '战斗' : '炮击'); if (!f) return;
      [ra, rd] = f;
    }
    const diff = c.A + ra - (c.D + rd);
    let res = mode === 'assault' ? CRT(diff) : ART(diff), crit = false;
    if (ra === 6 && diff >= 2) {
      const up = mode === 'assault' ? CRT_UP : ART_UP, i = up.indexOf(res);
      if (i >= 0 && i < up.length - 1) { res = up[i + 1]; crit = true; }
    }
    last = { ra, rd, diff, res, crit, att, def, mode, applied: false };
    const line = `${att.u.name}（${c.A}+${ra}）对 ${def.u.name}（${c.D}+${rd}）：优势差 ${diff >= 0 ? '+' : ''}${diff} → ${res}${crit ? '（暴击提升）' : ''}`;
    api.log((mode === 'assault' ? '战斗 ' : '炮击 ') + line, att.u.side);
    renderResult(c);
    renderCombat();
  }
  function renderResult(c) {
    const r = last, box = $('#result');
    if (!r) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<span class="label">${r.mode === 'assault' ? '战斗结果' : '炮击结果'}</span>
      <div class="row" style="justify-content:space-between"><span class="big">${esc(r.res)}</span><span class="num">骰 ${r.ra} : ${r.rd} · 优势差 ${r.diff >= 0 ? '+' : ''}${r.diff}</span></div>
      <span>${EXPLAIN[r.res] || ''}${r.crit ? ' 攻方掷出 6，结果提升一级。' : ''}${r.mode === 'assault' ? ' 攻方结算后疲劳。' : ''}</span>
      ${/R\d/.test(r.res) && r.res !== '攻方R1' ? '<span class="hint">后撤请手动拖动守方算子：新格不能与攻方相邻，只能撤进敌方 ZOC 时每格受 1 点损伤。守方被消灭或后撤后，攻方可推进进入空出的格。</span>' : ''}
      <div class="row"><button class="btn primary" id="applyRes" ${r.applied ? 'disabled' : ''}>${r.applied ? '已执行' : '执行损伤与疲劳'}</button>
      ${r.mode === 'assault' && r.def.u.tags.includes('nuts') && !r.applied ? '<button class="btn" id="nutsBtn">Nuts! 重掷防御骰</button>' : ''}</div>`;
    $('#applyRes').onclick = applyResult;
    const nb = $('#nutsBtn'); if (nb) nb.onclick = () => doRoll(true);
  }
  function applyResult() {
    const r = last; if (!r || r.applied) return;
    r.applied = true;
    const res = r.res;
    if (r.mode === 'assault') {
      if (res === '攻方D1') api.damage(r.att, 1);
      if (res.startsWith('D2')) api.damage(r.def, 2); else if (res.startsWith('D1')) api.damage(r.def, 1);
      if (res === 'F') api.placeMarker('F', r.def);
      if (pieces.has(r.att.id) && trayAt(r.att.tx, r.att.tz) == null) api.placeMarker('F', r.att);
    } else {
      if (res.startsWith('D1')) api.damage(r.def, 1);
      if (res !== '无' && pieces.has(r.def.id) && !trayAt(r.def.tx, r.def.tz)) api.placeMarker('F', r.def);
      if (res === 'D1+A') {
        const h = pieceHex(r.def);
        for (const q of pieces.values()) {
          if (q.kind !== 'unit' || q === r.def) continue;
          if (r.att.u.id === 'GWerf' && q.u.side === r.att.u.side) continue;
          const qh = pieceHex(q); if (h && qh && hexDist(h, qh) === 1) api.placeMarker('F', q);
        }
      }
    }
    api.toast('已执行：' + res);
    renderResult(); refresh();
  }

  // ---------------- 回合
  function setPhase(turn, phase, note) {
    api.commit({ turn, phase }); st.turn = turn; st.phase = phase;
    api.log(`进入第 ${turn} 回合 · ${PHASES[phase][0]}${note ? ' · ' + note : ''}`, 'OBS');
    refresh();
  }
  function next(dir = 1) {
    let t = st.turn, p = st.phase + dir;
    if (p > 5) { if (t >= 8) { api.toast('第 8 回合已结束，请查看胜利点'); return; } p = 0; t++; }
    if (p < 0) { if (t <= 1) return; p = 5; t--; }
    setPhase(t, p, t >= 4 && p === 2 && dir > 0 ? '美军增援可以从进场格进入' : '');
    if (t <= 3 && p === 0 && st.weather !== '浓雾/暴雪') { api.commit({ weather: '浓雾/暴雪' }); st.weather = '浓雾/暴雪'; }
  }
  async function rollWeather() {
    if (st.turn <= 3) { api.toast('第 1-3 回合天气固定为浓雾/暴雪'); return; }
    const f = await api.rollDice(['free'], '天气'); if (!f) return;
    const w = f[0] <= 4 ? '晴朗' : '浓雾/暴雪';
    api.commit({ weather: w }); st.weather = w; api.log(`天气掷骰 ${f[0]} → ${w}`, 'OBS'); refresh();
  }
  async function rollFuel() {
    const f = await api.rollDice(['free'], '燃油检定'); if (!f) return;
    api.log(`燃油检定 ${f[0]}${f[0] === 1 ? ' → 燃油危机：派普战斗群装甲/机械化单位本回合 MP 减半' : ' → 正常'}`, 'GE');
    api.toast(f[0] === 1 ? '燃油危机！派普战斗群 MP 减半' : `燃油检定 ${f[0]}，正常`);
  }
  async function rollAir() {
    if (st.weather !== '晴朗') { api.toast('只有晴朗天气才能空袭'); return; }
    const f = await api.rollDice(['free'], 'P-47 空袭'); if (!f) return;
    api.log(`P-47 空袭掷骰 ${f[0]} → ${f[0] <= 3 ? '压制（放压制标记）' : '造成 1 点损伤'}（目标在 SS1 高炮营本格或相邻时，德军另掷 D6，5-6 空袭骰 −2）`, 'US');
    api.toast(f[0] <= 3 ? `掷出 ${f[0]}：压制` : `掷出 ${f[0]}：1 点损伤`);
  }

  // ---------------- 胜利点
  function vp() {
    const units = [...pieces.values()].filter((p) => p.kind === 'unit');
    const inTray = (k) => units.filter((p) => trayAt(p.tx, p.tz) === k);
    const exits = inTray('exitGE').filter((p) => ['armor', 'mech'].includes(p.u.kind));
    const usLoss = inTray('deadUS'), geLoss = inTray('deadGE');
    const usPts = (p) => (p.u.kind === 'armor' || p.u.tags.includes('airborne') || p.u.kind === 'hq') ? 1 : 0.5;
    const gePts = (p) => (p.u.kind === 'armor' || p.u.tags.includes('SS') || p.u.kind === 'hq') ? 1 : 0.5;
    const rows = [];
    let g = 0, a = 0;
    for (const [hid, v] of Object.entries(OBJ)) {
      const who = st.ctrl[hid] || 'US';
      rows.push([`${D.towns[hid][0]}（${v}）`, who === 'GE' ? v : 0, who === 'US' ? v : 0]);
      if (who === 'GE') g += v; else a += v;
    }
    rows.push([`德军脱离 ${exits.length} 个单位`, exits.length * 3, 0]); g += exits.length * 3;
    if (!exits.length) { rows.push(['德军无单位脱离', 0, 3]); a += 3; }
    const ul = usLoss.reduce((s, p) => s + usPts(p), 0), gl = geLoss.reduce((s, p) => s + gePts(p), 0);
    rows.push([`美军损失 ${usLoss.length} 个单位`, ul, 0]); g += ul;
    rows.push([`德军损失 ${geLoss.length} 个单位`, 0, gl]); a += gl;
    const sv = Object.entries(OBJ).find(([h]) => D.towns[h][1] === 'St. Vith')?.[0], bs = Object.entries(OBJ).find(([h]) => D.towns[h][1] === 'Bastogne')?.[0];
    if (st.ctrl[sv] !== 'GE' && st.ctrl[bs] !== 'GE') { rows.push(['天气优势（终局时生效）', 0, 1]); a += 1; }
    return { g, a, rows };
  }
  function renderVP() {
    const r = vp(), d = r.a - r.g;
    $('#gvp').textContent = r.g; $('#avp').textContent = r.a;
    const out = d >= 5 ? '美军大胜' : d >= 1 ? '美军小胜' : d > -1 ? '平局' : d > -5 ? '德军小胜' : '德军大胜';
    $('#outcome').textContent = `当前判定：${out}（d = ${d >= 0 ? '+' : ''}${d}）`;
    $('#vpTable').innerHTML = '<tr><th>项目</th><th>GVP</th><th>AVP</th></tr>' + r.rows.map(([n, x, y]) => `<tr><td>${esc(n)}</td><td class="num">${x || ''}</td><td class="num">${y || ''}</td></tr>`).join('');
    const box = $('#ctrlList'); box.replaceChildren();
    for (const [hid, v] of Object.entries(OBJ)) {
      const row = document.createElement('div'); row.className = 'ctrl';
      row.innerHTML = `<span>${esc(D.towns[hid][0])} <span class="hint">${hid} · ${v} 分</span></span>`;
      const seg = document.createElement('span'); seg.className = 'seg';
      for (const s of ['US', 'GE']) {
        const b = document.createElement('button'); b.dataset.v = s; b.textContent = s === 'US' ? '美军' : '德军';
        b.setAttribute('aria-pressed', String((st.ctrl[hid] || 'US') === s));
        b.onclick = () => { api.commit({ ctrl: { [hid]: s } }); st.ctrl[hid] = s; api.log(`${D.towns[hid][0]} 控制权改为${s === 'US' ? '美军' : '德军'}`, s); refresh(); };
        seg.append(b);
      }
      row.append(seg); box.append(row);
    }
  }

  function renderTurn() {
    $('#turnNum').textContent = st.turn;
    $('#phaseName').textContent = PHASES[st.phase][0];
    $('#weather').textContent = st.turn <= 3 ? '浓雾/暴雪（固定）' : st.weather;
    const ol = $('#phaseList'); ol.replaceChildren();
    PHASES.forEach(([n, d], i) => {
      const li = document.createElement('li'); if (i === st.phase) li.className = 'now';
      li.innerHTML = `<b>${i + 1}. ${n}</b><small>${d}</small>`; ol.append(li);
    });
    $('#rollWeather').disabled = st.turn <= 3;
  }

  function refresh() { renderTurn(); renderVP(); renderCombat(); }

  // ---------------- 接线
  document.querySelectorAll('.tab').forEach((t) => t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    document.querySelectorAll('.pane').forEach((p) => (p.hidden = p.dataset.pane !== t.dataset.tab));
  });
  document.querySelectorAll('.mode button').forEach((b) => b.onclick = () => {
    mode = b.dataset.mode; last = null; renderResult();
    document.querySelectorAll('.mode button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderCombat();
  });
  document.querySelectorAll('[data-step]').forEach((b) => b.onclick = () => { extra[b.dataset.step] = Math.max(-6, Math.min(6, extra[b.dataset.step] + +b.dataset.d)); renderCombat(); });
  $('#obsAdj').onchange = renderCombat;
  $('#rollCombat').onclick = () => doRoll(false);
  $('#swapBtn').onclick = () => { [att, def] = [def, att]; renderCombat(); };
  $('#clearBtn').onclick = () => { att = def = null; last = null; extra = { att: 0, def: 0 }; renderResult(); renderCombat(); };
  $('#attSlot').onclick = () => { if (api.selectedUnit?.()) setSlot('att', api.selectedUnit()); };
  $('#nextPhase').onclick = () => next(1); $('#nextPhase2').onclick = () => next(1); $('#prevPhase').onclick = () => next(-1);
  $('#rollWeather').onclick = rollWeather; $('#rollFuel').onclick = rollFuel; $('#rollAir').onclick = rollAir;

  function setSlot(role, p) {
    if (!p || p.kind !== 'unit') return;
    if (role === 'att') att = p; else def = p;
    last = null; renderResult(); renderCombat();
    document.querySelector('.tab[data-tab="combat"]').click();
    api.toast(`${p.u.name} 设为${role === 'att' ? '攻方' : '守方'}`);
  }
  return { refresh, setSlot, api };
}
