// 规则引擎：阶段自动结算（燃油、天气、补给、疲劳计时、城镇控制）、战斗与炮击（含单位特殊规则与指挥点）、
// 后撤与推进、空袭、整补、工兵行动、胜利点（按最终修订版规则书）
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const PHASES = [
  ['准备', '自动：移除压制与断补、燃油检定、天气、补给检查。双方各可整补 1 个损伤单位'],
  ['空袭', '晴朗时，把 P-47 拖到 1 个德军单位上：1-3 压制，4-6 造成 1 点损伤'],
  ['美军行动', '增援进场（第 4 回合起）→ 移动 → 战斗 → 工兵。第 1 回合美军不能移动和进攻'],
  ['德军行动', '移动 → 战斗 → 工兵（修桥、架浮桥）'],
  ['炮兵', '美军炮兵先射击，然后德军炮兵；移动过的炮兵不能射击（SS1 炮兵团例外）'],
  ['结算', '自动更新城镇控制；第 8 回合结束时计算胜负'],
];
const SIDE_OF_PHASE = [null, 'US', 'US', 'GE', null, null];
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
const MAX_ATT = 6;
const sideCn = (s) => (s === 'US' ? '美军' : '德军');
const opp = (s) => (s === 'US' ? 'GE' : 'US');

export function initRules(api) {
  const { D, OBJ, TERRAIN, HEX, RIVER, BRIDGE, st, pieces, hexDist, trayAt, pieceHex } = api;
  let mode = 'assault', atts = [], def = null, extra = { att: 0, def: 0 }, cmpUse = { att: {}, def: {} };
  let cur = 0, done = [], last = null, busy = false;

  const statsOf = (p) => (p.flip ? p.u.red : p.u.full);
  const markersOn = (h, type) => !!h && api.markersAt(h.id, type).length > 0;
  const fatigued = (h) => markersOn(h, 'F') || markersOn(h, 'S');
  const isVGD = (p) => p.u.tags.includes('VGD');
  const onMap = (p) => pieces.has(p.id) && !!pieceHex(p);
  const alive = (p) => onMap(p) && (p.dmg || 0) < p.u.hp;
  const combatUnits = () => [...pieces.values()].filter((q) => q.kind === 'unit' && !['hq', 'air'].includes(q.u.kind) && onMap(q));
  const phaseKey = () => st.turn + '-' + st.phase;
  const jsonOf = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
  const hitMap = () => (st.hits?.k === phaseKey() ? jsonOf(st.hits.s) : {});
  const hitBy = (p) => hitMap()[p.id] || [];
  const attacked = (p) => Object.values(hitMap()).some((l) => l.includes(p.id));
  const disguised = () => !st.g150 && st.turn <= 2;
  const lastGEPhase = () => (st.phase >= 3 ? st.turn : st.turn - 1) * 6 + 3;
  const movedSince = (p, idx) => (st.mv?.[p.id] ?? -1) >= idx;
  // 行动阶段的序号：美军第 t 回合 = 2t，德军 = 2t+1；nextSeq = 这一方下一个还没结束的行动阶段
  const nextSeq = (side) => (side === 'US' ? (st.phase <= 2 ? 2 * st.turn : 2 * st.turn + 2) : (st.phase <= 3 ? 2 * st.turn + 1 : 2 * st.turn + 3));

  function fatigue(p, e) {
    if (!alive(p)) return;
    const m = api.markersAt(pieceHex(p).id, 'F')[0];
    if (m) { if ((m.e ?? 0) < e) api.setMarkerE(m, e); } else api.placeMarker('F', p, e);
  }
  function lock(p, key = '_act') {   // 记为“本阶段已行动”：不能再移动或进攻
    const k = phaseKey(), m = hitMap();
    m[key] = [...(m[key] || []), p.id];
    st.hits = { k, s: JSON.stringify(m) }; api.commit({ hits: st.hits });
  }

  // 指挥点：攻方加到 A，守方加到 D；只给 R 格以内的友军；SS12 师部只能加 D
  const cmpLeft = (hq) => hq.u.cmp - ((st.cmp?.t === st.turn && jsonOf(st.cmp.s)[hq.id]) || 0);
  function hqsFor(p, role) {
    const h = pieceHex(p); if (!h) return [];
    return [...pieces.values()].filter((q) => q.kind === 'unit' && q.u.kind === 'hq' && q.u.side === p.u.side && onMap(q)
      && hexDist(pieceHex(q), h) <= statsOf(q)[3] && !(role === 'att' && q.u.id === 'GHQ12'));
  }

  function compute(att) {
    if (!att || !def) return null;
    const ah = pieceHex(att), dh = pieceHex(def), am = [], dm = [], warn = [];
    const T1 = st.turn === 1;
    const sa = statsOf(att), sd = statsOf(def);
    if (!ah || !dh) warn.push('有算子不在地图格上');
    if (def.u.kind === 'hq') warn.push('指挥部不能被攻击');
    if (att.u.side === def.u.side) warn.push('攻守双方是同一阵营');
    if (def.u.id === 'G150' && att.u.side === 'US' && disguised()) warn.push('伪装行动：150 装甲旅首次进攻之前（至多到第 2 回合结束），美军不能进攻或炮击它');
    if (mode === 'assault') {
      if (fatigued(ah)) am.push([markersOn(ah, 'S') ? '攻方断补' : '攻方疲劳', -1]);
      if (ah && dh && hexDist(ah, dh) !== 1) warn.push('目标不相邻');
      if (att.u.kind === 'art') warn.push('炮兵只能在炮兵阶段炮击');
      if (['hq', 'air'].includes(att.u.kind)) warn.push('这个单位不能发起地面进攻');
      if (fatigued(ah)) warn.push('攻方处于疲劳，不能主动进攻');
      if (markersOn(ah, 'P')) warn.push('攻方被压制，不能主动进攻');
      if (T1 && att.u.side === 'US') warn.push('第 1 回合美军不能主动进攻');
      if (attacked(att)) warn.push('这个单位本阶段已经行动过');
      if (api.strict() && SIDE_OF_PHASE[st.phase] !== att.u.side) warn.push(`现在不是${sideCn(att.u.side)}的行动阶段`);
      if (dh) {
        const town = dh.t === 't', hill = dh.t === 'h', forest = dh.t === 'f';
        const lose = T1 && def.u.side === 'US';
        const blast = att.u.tags.includes('pioneer') && (forest || hill);
        if (town) dm.push(['城镇', 2]);
        if (hill) dm.push(lose ? ['高地（奇袭失效）', 0] : blast ? ['高地（爆破无视）', 0] : ['高地', 1]);
        if (forest && ['inf', 'eng'].includes(def.u.kind)) dm.push(lose ? ['森林（奇袭失效）', 0] : blast ? ['森林（爆破无视）', 0] : ['森林', 1]);
        if (markersOn(dh, 'K')) dm.push(['工事', 1]);
        if (fatigued(dh)) { dm.push([markersOn(dh, 'S') ? '守方断补' : '守方疲劳', -1]); if (def.u.tags.includes('green')) dm.push(['缺乏经验', -1]); }
      }
      if (ah && dh && RIVER.has([ah.id, dh.id].sort().join('|'))) { am.push(['跨河', -1]); dm.push(['河流', 1]); }
      if (ah && dh && ah.t === 'h' && dh.t !== 'h') am.push(['从高地攻击', 1]);
      if (T1 && att.u.side === 'GE') am.push(['奇袭', 1]);
      if (T1 && def.u.side === 'US') dm.push(['情报真空', -1]);
      const prev = hitBy(def).filter((id) => id !== att.id);
      if (att.u.tags.includes('blitz')) am.push(['装甲突击', 2]);
      if (att.u.tags.includes('combined') && prev.includes('GPz1')) am.push(['步坦协同', 1]);
      if (att.u.tags.includes('ccb') && prev.some((id) => pieces.get(id)?.u.side === 'US')) am.push(['经验丰富', 1]);
      if (att.u.tags.includes('vs_vgd') && isVGD(def)) am.push(['老兵经验', 1]);
      if (att.u.tags.includes('flank') && fatigued(dh)) am.push(['侧翼掩护', 1]);
      if (att.u.tags.includes('human_wave') && ah && combatUnits().some((q) => q !== att && q.u.side === att.u.side && hexDist(pieceHex(q), ah) === 1)) am.push(['人海战术', 1]);
      if (att.u.tags.includes('woods') && ah?.t === 'f' && def.u.kind === 'inf') am.push(['林地猎手', 1]);
      if (att.u.tags.includes('mechfire') && dh?.t === 'c') am.push(['机械化火力', 1]);
      if (def.u.tags.includes('ambush') && att.u.kind === 'armor') dm.push(['伏击', 1]);
      if (def.u.tags.includes('hetzer') && dh && ['f', 'h'].includes(dh.t)) dm.push(['“追猎者”反击', 1]);
      if (def.u.tags.includes('woods') && dh?.t === 'f' && att.u.kind === 'inf') dm.push(['林地猎手', 1]);
      if (def.u.tags.includes('mechfire') && dh?.t === 'c') dm.push(['机械化火力', 1]);
      if (def.u.tags.includes('dig_in') && !movedSince(def, lastGEPhase())) dm.push(['阵地防御（未移动）', 1]);
    } else {
      if (att.u.kind !== 'art') warn.push('射击方不是炮兵单位');
      if (api.strict() && st.phase !== 4) warn.push('炮击在炮兵阶段进行');
      if (attacked(att)) warn.push('这个炮兵本阶段已经射击过');
      if (ah && dh && hexDist(ah, dh) > sa[3]) warn.push(`目标超出射程 R${sa[3]}`);
      if (!att.u.tags.includes('mobile_art') && movedSince(att, st.turn * 6)) warn.push('本回合移动过的炮兵不能射击');
      if (def.u.tags.includes('ambush') && dh && ['f', 'h'].includes(dh.t) && !st.m10) warn.push('伏击：705 坦歼营在森林/高地，首次进攻之前不能被炮兵作为目标');
      if (dh) {
        if (dh.t === 't') dm.push(['城镇', 2]); else if (dh.t === 'h') dm.push(['高地', 1]); else if (dh.t === 'f') dm.push(['森林', 1]);
        if (markersOn(dh, 'K')) dm.push(['工事', 1]);
        if (att.u.tags.includes('heavy_art') && !['t', 'f'].includes(dh.t)) am.push(['重炮/火箭炮', 1]);
        const obs = combatUnits().filter((q) => q.u.side === att.u.side && q.u.kind !== 'art' && hexDist(pieceHex(q), dh) <= (q.u.tags.includes('recon') ? 3 : 2));
        if (!obs.length) warn.push('目标 2 格以内没有己方观察哨');
        else if (obs.some((q) => hexDist(pieceHex(q), dh) === 1)) am.push(['观察哨相邻', 1]);
      }
      if (def.u.tags.includes('anti_art')) am.push(['防炮击', -2]);
    }
    const sumC = (role) => Object.values(cmpUse[role]).reduce((a, b) => a + b, 0);
    if (sumC('att')) am.push(['指挥点 CMP', sumC('att')]);
    if (sumC('def')) dm.push(['指挥点 CMP', sumC('def')]);
    const sum = (l) => l.reduce((a, [, v]) => a + v, 0);
    const A = sa[0] + sum(am) + extra.att;
    const Dv = mode === 'assault' ? sd[1] + sum(dm) + extra.def : sum(dm) + extra.def;
    return { am, dm, warn, A, D: Dv, baseA: sa[0], baseD: mode === 'assault' ? sd[1] : 0 };
  }

  const active = () => (cur < atts.length ? atts[cur] : null);
  const face = (p) => `<img class="face" src="${api.pieceImg(p)}" alt="">`;
  function attListHtml() {
    if (!atts.length) return `<span class="label">${mode === 'assault' ? '攻方' : '炮兵'}</span><span class="hint">选中己方算子，再点带红圈的敌军</span>`;
    return `<span class="label">${mode === 'assault' ? '攻方' : '炮兵'}${atts.length > 1 ? ` · ${atts.length} 个依次结算` : ''}</span>` +
      atts.map((p, i) => {
        const h = pieceHex(p), r = done[i];
        return `<div class="arow${i === cur ? ' cur' : ''}${r ? ' done' : ''}"><span class="who">${face(p)}<span><b>${esc(p.u.name)}</b><br>
          <span class="hint">${h ? TERRAIN[h.t] : '不在地图上'}${r ? ' · ' + esc(r) : ''}</span></span></span>
          <button class="btn x" data-rm="${i}" title="移出" aria-label="移出 ${esc(p.u.name)}">×</button></div>`;
      }).join('');
  }
  function defHtml() {
    if (!def) return `<span class="label">守方</span><span class="hint">等待选择目标</span>`;
    const h = pieceHex(def);
    return `<span class="label">守方</span><span class="who">${face(def)}<span><b>${esc(def.u.name)}</b><br>
      <span class="hint">${h ? h.id + ' ' + TERRAIN[h.t] : '不在地图上'}</span></span></span>`;
  }
  function modsHtml(list, base, total, label, ex) {
    return `<div><span>${label}</span><span class="num">${base}</span></div>` +
      list.map(([n, v]) => `<div><span>${esc(n)}</span><span class="num ${v < 0 ? 'neg' : v > 0 ? 'pos' : ''}">${v >= 0 ? '+' : ''}${v}</span></div>`).join('') +
      (ex ? `<div><span>手动修正</span><span class="num">${ex > 0 ? '+' : ''}${ex}</span></div>` : '') +
      `<div class="sum"><b>合计</b><b class="num">${total}</b></div>`;
  }
  function cmpHtml() {
    const a = active(); if (!a || !def) return '';
    const btns = [];
    for (const [role, p] of [['att', a], ['def', def]]) {
      for (const hq of hqsFor(p, role)) {
        const left = cmpLeft(hq) - (cmpUse[role][hq.id] || 0);
        btns.push(`<button class="btn" data-cmp="${role}:${hq.id}" ${left <= 0 ? 'disabled' : ''}>${esc(hq.u.name)} ${role === 'att' ? 'A' : 'D'}+1 <span class="hint">剩 ${left}</span></button>`);
        if (cmpUse[role][hq.id]) btns.push(`<button class="btn" data-uncmp="${role}:${hq.id}" title="撤回">↺</button>`);
      }
    }
    return btns.length ? `<span class="hint">指挥点</span>${btns.join('')}` : '';
  }
  function renderCombat() {
    const a = active();
    const as = $('#attSlot'), ds = $('#defSlot');
    as.innerHTML = attListHtml(); as.className = 'slot att ' + (atts[0]?.u.side || '');
    ds.innerHTML = defHtml(); ds.className = 'slot def ' + (def?.u.side || '');
    $('#attExtra').textContent = extra.att; $('#defExtra').textContent = extra.def;
    const c = compute(a);
    $('#attMods').innerHTML = c ? modsHtml(c.am, c.baseA, c.A, mode === 'assault' ? '攻击力 A' : '炮兵 A', extra.att) : '';
    $('#defMods').innerHTML = c ? modsHtml(c.dm, c.baseD, c.D, mode === 'assault' ? '防御力 D' : '目标修正', extra.def) : '';
    if (c && c.warn.length) $('#attMods').innerHTML += `<span class="warn">${c.warn.map(esc).join('；')}</span>`;
    const cr = $('#cmpRow'); cr.innerHTML = cmpHtml(); cr.hidden = !cr.innerHTML;
    const rb = $('#rollCombat');
    rb.disabled = !c || busy || (last && !last.applied) || (api.strict() && c.warn.length > 0);
    rb.textContent = !a && atts.length ? '全部结算完毕' : (mode === 'assault' ? '进攻' : '开火') + (atts.length > 1 && a ? ` · 第 ${cur + 1}/${atts.length} 个` : '');
    as.querySelectorAll('[data-rm]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); removeAtt(+b.dataset.rm); });
    cr.querySelectorAll('[data-cmp]').forEach((b) => b.onclick = () => { const [r, id] = b.dataset.cmp.split(':'); cmpUse[r][id] = (cmpUse[r][id] || 0) + 1; renderCombat(); });
    cr.querySelectorAll('[data-uncmp]').forEach((b) => b.onclick = () => { const [r, id] = b.dataset.uncmp.split(':'); cmpUse[r][id] = Math.max(0, (cmpUse[r][id] || 0) - 1); renderCombat(); });
  }
  function removeAtt(i) {
    atts.splice(i, 1); done.splice(i, 1);
    if (cur > i) cur--;
    if (last && last.idx === i && !last.applied) last = null;
    renderResult(); renderCombat();
  }
  function spendCmp() {
    const used = st.cmp?.t === st.turn ? jsonOf(st.cmp.s) : {};
    let any = false;
    for (const role of ['att', 'def']) for (const [id, n] of Object.entries(cmpUse[role])) if (n) { used[id] = (used[id] || 0) + n; any = true; }
    if (any) { st.cmp = { t: st.turn, s: JSON.stringify(used) }; api.commit({ cmp: st.cmp }); }
    cmpUse = { att: {}, def: {} };
  }
  function markHit(att) {
    lock(att, def.id);
    if (att.u.id === 'G150' && !st.g150) { st.g150 = 1; api.commit({ g150: 1 }); api.log('150 装甲旅首次进攻，伪装解除', 'GE'); }
    if (att.u.tags.includes('ambush') && !st.m10) { st.m10 = 1; api.commit({ m10: 1 }); }
  }

  async function doRoll(reroll = null) {
    if (busy) return;
    const att = reroll ? last.att : active();
    const c = reroll ? last.c : compute(att); if (!c) return;
    busy = true; $('#rollCombat').disabled = true;
    let ra, rd;
    try {
      if (reroll) {
        const f = await api.rollDice(['def'], reroll); if (!f) return;
        ra = last.ra; rd = f[0];
      } else {
        api.setPend({});
        const f = await api.rollDice(['att', 'def'], mode === 'assault' ? '战斗' : '炮击'); if (!f) return;
        [ra, rd] = f;
        markHit(att); spendCmp();
      }
    } finally { busy = false; }
    const diff = c.A + ra - (c.D + rd);
    let res = mode === 'assault' ? CRT(diff) : ART(diff), crit = false;
    if (ra === 6 && diff >= 2) {
      const up = mode === 'assault' ? CRT_UP : ART_UP, i = up.indexOf(res);
      if (i >= 0 && i < up.length - 1) { res = up[i + 1]; crit = true; }
    }
    const rerolls = reroll ? [...last.rerolls, reroll] : [];
    last = { ra, rd, diff, res, crit, att, def, mode, c, idx: cur, applied: false, rerolls, notes: [] };
    api.log(`${mode === 'assault' ? '战斗' : '炮击'} ${att.u.name}（${c.A}+${ra}）对 ${def.u.name}（${c.D}+${rd}）：优势差 ${diff >= 0 ? '+' : ''}${diff} → ${res}${crit ? '（暴击提升）' : ''}${reroll ? '（' + reroll + '）' : ''}`, att.u.side);
    done[cur] = res;
    if (rerollOptions(last).length) { renderResult(); renderCombat(); } else applyResult();
  }

  function rerollOptions(r) {
    if (r.mode !== 'assault' || r.applied) return [];
    const o = [];
    if (r.def.u.tags.includes('nuts') && !r.rerolls.includes('Nuts! 重掷')) o.push('Nuts! 重掷');
    const hq = [...pieces.values()].find((q) => q.u?.id === 'GHQ12' && onMap(q));
    if (r.def.u.id === 'GPz12' && hq && hexDist(pieceHex(hq), pieceHex(r.def)) <= 1 && !r.rerolls.includes('师部重掷')) o.push('师部重掷');
    return o;
  }
  function renderResult() {
    const r = last, box = $('#result');
    if (!r) { box.hidden = true; return; }
    box.hidden = false;
    const opts = rerollOptions(r);
    box.innerHTML = `<span class="label">${r.mode === 'assault' ? '战斗结果' : '炮击结果'} · ${esc(r.att.u.name)} → ${esc(r.def.u.name)}</span>
      <div class="row" style="justify-content:space-between"><span class="big">${esc(r.res)}</span><span class="num">骰 ${r.ra} : ${r.rd} · 优势差 ${r.diff >= 0 ? '+' : ''}${r.diff}</span></div>
      <span>${EXPLAIN[r.res] || ''}${r.crit ? ' 攻方掷出 6，结果提升一级。' : ''}</span>
      ${r.notes.map((n) => `<span class="hint">· ${esc(n)}</span>`).join('')}
      ${r.applied ? '' : `<div class="row"><button class="btn primary" id="applyRes">接受结果</button>${opts.map((o) => `<button class="btn" data-reroll="${esc(o)}">${esc(o)}防御骰</button>`).join('')}</div>`}`;
    const ab = $('#applyRes'); if (ab) ab.onclick = applyResult;
    box.querySelectorAll('[data-reroll]').forEach((b) => b.onclick = () => doRoll(b.dataset.reroll));
  }
  // 执行结果：损伤、疲劳（带到期时间）、后撤与推进都自动处理
  function applyResult() {
    const r = last; if (!r || r.applied) return;
    r.applied = true;
    const res = r.res, A = r.att, T = r.def, n = r.notes;
    const defHex = pieceHex(T)?.id, attHex = pieceHex(A)?.id;
    const hits = res.startsWith('D2') ? 2 : res.startsWith('D1') ? 1 : 0;
    if (r.mode === 'assault') {
      if (res === '攻方D1') api.damage(A, 1);
      if (hits) api.damage(T, hits);
      if (res === 'F') fatigue(T, nextSeq(T.u.side));
      if (T.u.tags.includes('first_contact') && st.turn === 1 && A.u.side === 'GE' && res !== '无' && !res.startsWith('攻方')) { fatigue(T, nextSeq(T.u.side)); if (alive(T)) n.push('初次交战：第 1 回合被击中，自动疲劳。'); }
      fatigue(A, nextSeq(opp(A.u.side)));
      const steps = res === '攻方R1' ? 0 : /R2/.test(res) ? 2 : /R1/.test(res) ? 1 : 0;
      if (res === '攻方R1') { if (alive(A)) api.startRetreat(A, 1, defHex, null); }
      else if (hits && !alive(T)) {
        n.push(`${T.u.name} 被消灭。${A.u.name} 可以推进到空出的格（绿色轮廓）${A.u.tags.includes('blitz') ? '，装甲突击还可以再走至多 2 格' : ''}。`);
        if (alive(A)) api.offerAdvance(A, defHex, A.u.tags.includes('blitz'));
      } else if (steps && alive(T)) {
        if (hits && T.u.tags.includes('fanatic')) n.push('狂热防御：受损但未被消灭，无视后撤。');
        else if (hits && T.u.tags.includes('veteran')) n.push('老兵坚韧：受损后坚守原地，无视后撤。');
        else { n.push(`把 ${T.u.name} 拖到橙色轮廓内后撤 ${steps} 格；之后 ${A.u.name} 可以推进。`); api.startRetreat(T, steps, attHex, A.id); }
      }
    } else {
      if (hits) api.damage(T, 1);
      if (res !== '无') fatigue(T, nextSeq(T.u.side) + (res.startsWith('P2') ? 2 : 0));
      if (res === 'D1+A') {
        const h = HEX.get(defHex);
        for (const q of combatUnits()) {
          if (q === T || (A.u.tags.includes('werfer') && q.u.side === A.u.side)) continue;
          if (h && hexDist(h, pieceHex(q)) === 1) fatigue(q, nextSeq(q.u.side));
        }
      }
      if (/X/.test(res) && alive(T)) { n.push(`士气崩溃：把 ${T.u.name} 拖到橙色轮廓内后撤 1 格。`); api.startRetreat(T, 1, null, null); }
    }
    cur++;
    if (!alive(T)) { for (let i = cur; i < atts.length; i++) done[i] = '目标已消灭'; cur = atts.length; }
    renderResult(); refresh();
  }

  // ---------------- 空袭（把 P-47 拖到德军单位上）
  async function airStrike(target) {
    if (st.phase !== 1) return '只有空袭阶段才能出动 P-47';
    if (st.turn <= 3 || st.weather !== '晴朗') return '天气不是晴朗，P-47 不能出动';
    if (st.air === st.turn) return '本回合已经空袭过';
    if (!target || target.u.side !== 'GE') return '把 P-47 拖到一个德军单位上';
    st.air = st.turn; api.commit({ air: st.turn });
    const th = pieceHex(target);
    const flak = [...pieces.values()].some((q) => q.u?.tags?.includes('flak') && onMap(q) && hexDist(pieceHex(q), th) <= 1);
    const f = await api.rollDice(flak ? ['att', 'def'] : ['att'], 'P-47 空袭'); if (!f) return null;
    const cut = flak && f[1] >= 5 ? 2 : 0, v = f[0] - cut;
    const res = v <= 3 ? '压制' : '1 点损伤';
    api.log(`P-47 空袭 ${target.u.name}：掷 ${f[0]}${flak ? `，旋风高炮 ${f[1]}${cut ? ' → 空袭骰 −2' : ' 未拦截'}` : ''} → ${res}`, 'US');
    if (v <= 3) api.placeMarker('P', target); else api.damage(target, 1);
    api.toast(`P-47 空袭：${res}`);
    refresh();
    return null;
  }

  // ---------------- 整补与工兵
  const regUsed = () => (st.reg?.t === st.turn ? (st.reg.s || '') : '');
  function canRegroup(p) {
    if (st.phase !== 0 || p.kind !== 'unit' || !alive(p) || !(p.dmg > 0) || ['hq', 'air'].includes(p.u.kind)) return false;
    const h = pieceHex(p);
    return !regUsed().includes(p.u.side) && !markersOn(h, 'S') && !api.inEnemyZoc(p);
  }
  function regroup(p) {
    if (!canRegroup(p)) return;
    st.reg = { t: st.turn, s: regUsed() + p.u.side }; api.commit({ reg: st.reg });
    api.heal(p);
    api.log(`${p.u.name} 整补，恢复到完好面`, p.u.side);
    refresh();
  }
  function engActions(p) {
    const out = [], h = pieceHex(p);
    if (p.kind !== 'unit' || p.u.kind !== 'eng' || !h || SIDE_OF_PHASE[st.phase] !== p.u.side || st.phase === 1) return out;
    if (attacked(p) || api.movedThisPhase(p) || markersOn(h, 'P')) return out;
    const bridgesAt = [...BRIDGE].filter((e) => e.split('|').includes(h.id)).map((e) => e.split('|').find((x) => x !== h.id));
    const blown = (o) => api.markersAt(o, 'B').length > 0 || api.markersAt(h.id, 'B').length > 0;
    if (p.u.side === 'US') {
      if (!markersOn(h, 'K')) out.push(['构筑工事', () => { api.placeMarker('K', p); lock(p); api.log(`${p.u.name} 在 ${h.id} 构筑工事（守方防御 +1）`, 'US'); refresh(); }]);
      const o = bridgesAt.find((x) => !blown(x));
      if (o) out.push(['炸桥（4-6 成功）', async () => {
        lock(p);
        const f = await api.rollDice(['att'], '炸桥'); if (!f) return;
        if (f[0] >= 4) { const oh = HEX.get(o); api.placeMarker('B', { tx: oh.X, tz: oh.Z }); }
        api.log(`${p.u.name} 炸桥 ${h.id}–${o}：掷 ${f[0]} → ${f[0] >= 4 ? '炸毁' : '失败'}`, 'US'); api.toast(f[0] >= 4 ? '桥被炸毁' : '炸桥失败'); refresh();
      }]);
    } else {
      const bm = [h.id, ...bridgesAt].flatMap((x) => api.markersAt(x, 'B'))[0];
      if (bm) out.push(['修复桥梁', () => { api.removeMarker(bm); lock(p); api.log(`${p.u.name} 修复了 ${h.id} 的桥梁`, 'GE'); refresh(); }]);
      const river = [...RIVER].some((e) => e.split('|').includes(h.id) && !BRIDGE.has(e));
      if (river && !markersOn(h, 'W')) out.push(['架设浮桥', () => { api.placeMarker('W', p); lock(p); api.log(`${p.u.name} 在 ${h.id} 架设浮桥（重型装甲不能使用）`, 'GE'); refresh(); }]);
    }
    return out;
  }

  // ---------------- 回合：切换阶段时自动结算
  function setPhase(turn, phase) {
    api.commit({ turn, phase }); st.turn = turn; st.phase = phase;
    api.log(`第 ${turn} 回合 · ${PHASES[phase][0]}阶段`, 'OBS');
  }
  function endAction(seq) {   // 行动阶段结束：到期的疲劳和断补标记移除
    let n = 0;
    for (const m of [...pieces.values()]) if (m.kind === 'marker' && ['F', 'S'].includes(m.type) && m.e != null && m.e <= seq) { api.removeMarker(m); n++; }
    if (n) api.log(`${n} 个疲劳/断补标记到期移除`, 'OBS');
  }
  function updateControl() {
    for (const hid of Object.keys(OBJ)) {
      const u = combatUnits().find((q) => pieceHex(q).id === hid);
      if (u && st.ctrl[hid] !== u.u.side) { st.ctrl[hid] = u.u.side; api.commit({ ctrl: { [hid]: u.u.side } }); api.log(`${D.towns[hid][0]} 由${sideCn(u.u.side)}控制`, u.u.side); }
    }
  }
  async function enter(t, p) {
    if (p === 0) {
      for (const m of [...pieces.values()]) if (m.kind === 'marker' && ['P', 'S'].includes(m.type)) api.removeMarker(m);
      const sum = [];
      const f = await api.rollDice(['att'], '燃油检定');
      if (f) { st.fuel = f[0] === 1 ? t : 0; api.commit({ fuel: st.fuel }); api.log(`燃油检定 ${f[0]}${f[0] === 1 ? ' → 燃油危机：派普战斗群装甲/机械化单位本回合 MP 减半' : ' → 正常'}`, 'GE'); if (f[0] === 1) sum.push('燃油危机'); }
      if (t >= 4) {
        const w = await api.rollDice(['def'], '天气');
        if (w) { st.weather = w[0] <= 4 ? '晴朗' : '浓雾/暴雪'; api.commit({ weather: st.weather }); api.log(`天气掷骰 ${w[0]} → ${st.weather}`, 'OBS'); sum.push(st.weather); }
      } else if (st.weather !== '浓雾/暴雪') { st.weather = '浓雾/暴雪'; api.commit({ weather: st.weather }); }
      if (t >= 2) {
        const out = api.supplyCheck();
        for (const u of out) api.placeMarker('S', u, nextSeq(u.u.side));
        if (out.length) { api.log(`补给检查：${out.map((u) => u.u.name).join('、')} 断补（本回合视为疲劳，不能整补）`, 'OBS'); sum.push(`${out.length} 个单位断补`); }
        else api.log('补给检查：全部单位有补给', 'OBS');
      }
      api.toast(`第 ${t} 回合开始${sum.length ? ' · ' + sum.join(' · ') : ''}`);
    }
    if (p === 1 && !(t >= 4 && st.weather === '晴朗')) { api.log('天气恶劣，跳过空袭阶段', 'OBS'); setPhase(t, 2); p = 2; }
    if (p === 5) {
      updateControl();
      if (t === 8) { const r = vp(); api.log(`终局：GVP ${r.g}，AVP ${r.a} → ${outcomeOf(r)}`, 'OBS'); api.toast(`对局结束：${outcomeOf(r)}`); }
    }
  }
  async function next(dir = 1) {
    if (busy) return;
    if (dir > 0 && api.strict() && api.getPend().r) { api.toast('先完成后撤（橙色轮廓）'); return; }
    let t = st.turn, p = st.phase + dir;
    if (p > 5) { if (t >= 8) { api.toast('第 8 回合已结束，胜负见“胜利点”'); return; } p = 0; t++; }
    if (p < 0) { if (t <= 1) return; p = 5; t--; }
    if (dir > 0) {
      if (st.phase === 2 || st.phase === 3) endAction(st.turn * 2 + (st.phase === 3 ? 1 : 0));
      api.setPend({});
    }
    setPhase(t, p);
    atts = []; def = null; cur = 0; done = []; last = null; cmpUse = { att: {}, def: {} };
    renderResult(); refresh();
    if (dir > 0) { busy = true; refresh(); try { await enter(t, p); } finally { busy = false; refresh(); } }
  }
  async function rollWeather() {
    if (st.turn <= 3) { api.toast('第 1-3 回合天气固定为浓雾/暴雪'); return; }
    const f = await api.rollDice(['free'], '天气'); if (!f) return;
    const w = f[0] <= 4 ? '晴朗' : '浓雾/暴雪';
    api.commit({ weather: w }); st.weather = w; api.log(`天气掷骰 ${f[0]} → ${w}`, 'OBS'); refresh();
  }
  async function rollFuel() {
    const f = await api.rollDice(['free'], '燃油检定'); if (!f) return;
    st.fuel = f[0] === 1 ? st.turn : 0; api.commit({ fuel: st.fuel });
    api.log(`燃油检定 ${f[0]}${f[0] === 1 ? ' → 燃油危机' : ' → 正常'}`, 'GE'); api.toast(f[0] === 1 ? '燃油危机：派普战斗群 MP 减半' : `燃油检定 ${f[0]}，正常`); refresh();
  }
  function rollAir() {
    const sel = api.selectedUnit?.();
    if (sel && sel.u.side === 'GE') { airStrike(sel).then((msg) => msg && api.toast(msg)); return; }
    api.toast('把桌上的 P-47 算子拖到目标德军单位上');
  }

  // ---------------- 胜利点
  function vp() {
    const units = [...pieces.values()].filter((p) => p.kind === 'unit' && p.u.kind !== 'air');
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
  const outcomeOf = (r) => { const d = r.a - r.g; return d >= 5 ? '美军大胜' : d >= 1 ? '美军小胜' : d > -1 ? '平局' : d > -5 ? '德军小胜' : '德军大胜'; };
  function renderVP() {
    const r = vp(), d = r.a - r.g;
    $('#gvp').textContent = r.g; $('#avp').textContent = r.a; $('#hudG').textContent = r.g; $('#hudA').textContent = r.a;
    $('#outcome').textContent = `按现在的局面：${outcomeOf(r)}（差 ${d >= 0 ? '+' : ''}${d}）`;
    $('#vpTable').innerHTML = '<tr><th>项目</th><th>GVP</th><th>AVP</th></tr>' + r.rows.map(([n, x, y]) => `<tr><td>${esc(n)}</td><td class="num">${x || ''}</td><td class="num">${y || ''}</td></tr>`).join('');
    const box = $('#ctrlList'); box.replaceChildren();
    for (const [hid, v] of Object.entries(OBJ)) {
      const row = document.createElement('div'); row.className = 'ctrl';
      row.innerHTML = `<span>${esc(D.towns[hid][0])} <span class="hint">${hid} · ${v} 分</span></span>`;
      const seg = document.createElement('span'); seg.className = 'seg';
      for (const s of ['US', 'GE']) {
        const b = document.createElement('button'); b.dataset.v = s; b.textContent = sideCn(s);
        b.setAttribute('aria-pressed', String((st.ctrl[hid] || 'US') === s));
        b.onclick = () => { api.commit({ ctrl: { [hid]: s } }); st.ctrl[hid] = s; api.log(`${D.towns[hid][0]} 控制权改为${sideCn(s)}`, s); refresh(); };
        seg.append(b);
      }
      row.append(seg); box.append(row);
    }
  }

  // 当前命令：一句话告诉玩家现在该做什么
  function orderText() {
    const t = st.turn, pend = api.getPend();
    if (pend.r && pieces.get(pend.r.id)) return ['alert', `<b>后撤</b>　把 ${esc(pieces.get(pend.r.id).u.name)} 拖到橙色轮廓内（还要后撤 ${pend.r.n} 格）`];
    if (pend.a && pieces.get(pend.a.id)) return [SIDE_OF_PHASE[st.phase] || '', `<b>推进</b>　${esc(pieces.get(pend.a.id).u.name)} 可以拖到绿色轮廓内${pend.a.burst ? '（装甲突击，至多 2 格）' : ''}，也可以不推进`];
    if (busy && st.phase === 0) return ['', '<b>准备阶段</b>　正在结算燃油、天气和补给……'];
    switch (st.phase) {
      case 0: return ['', t === 1 ? '<b>部署</b>　单位已按剧本就位，德军可以在部署区内调整、空投伞兵。准备好就结束阶段'
        : '<b>准备阶段</b>　燃油、天气、补给已结算。双方各可整补 1 个损伤单位：选中它，点“整补”'];
      case 1: return ['US', st.air === t ? '<b>空袭阶段</b>　本回合已经空袭' : '<b>空袭阶段</b>　天气晴朗：把 P-47 拖到 1 个德军单位上'];
      case 2: return ['US', t === 1 ? '<b>美军行动</b>　第 1 回合美军措手不及，不能移动和进攻（工兵可以行动）'
        : `<b>美军行动</b>　拖动美军算子移动（青色轮廓内）；选中算子，再点带红圈的敌军进攻${t >= 4 ? '。增援从增援盒拖到进场格' : ''}`];
      case 3: return ['GE', `<b>德军行动</b>　拖动德军算子移动（青色轮廓内）；选中算子，再点带红圈的敌军进攻${t === 1 ? '。奇袭：进攻骰 +1' : ''}`];
      case 4: return ['', '<b>炮兵阶段</b>　美军先射击。选中炮兵，再点射程内带红圈的目标'];
      default: return ['', t === 8 ? `<b>对局结束</b>　${outcomeOf(vp())}` : '<b>结算阶段</b>　城镇控制和胜利点已更新'];
    }
  }
  function renderTurn() {
    $('#turnNum').textContent = st.turn; $('#phaseName').textContent = PHASES[st.phase][0];
    $('#weather').textContent = st.turn <= 3 ? '浓雾 · 暴雪' : st.weather;
    $('#turnTrack').innerHTML = Array.from({ length: 8 }, (_, i) => `<i class="${i + 1 < st.turn ? 'past' : i + 1 === st.turn ? 'now' : ''}${i + 1 === 4 ? ' reinf' : ''}" title="第 ${i + 1} 回合${i + 1 === 4 ? '：美军增援进场' : ''}">${i + 1}</i>`).join('');
    $('#phaseRail').innerHTML = PHASES.map(([n], i) => `<span class="${i < st.phase ? 'past' : i === st.phase ? 'now ' + (SIDE_OF_PHASE[i] || '') : ''}">${n}</span>`).join('');
    const [cls, html] = orderText();
    $('#order').className = cls; $('#orderText').innerHTML = html;
    $('#nextPhase').disabled = busy;
    $('#nextPhase').textContent = st.phase === 5 ? (st.turn >= 8 ? '对局结束' : '下一回合 ▸') : '结束阶段 ▸';
    const ol = $('#phaseList'); ol.replaceChildren();
    PHASES.forEach(([n, d], i) => {
      const li = document.createElement('li'); if (i === st.phase) li.className = 'now';
      li.innerHTML = `<b>${i + 1}. ${n}阶段</b><small>${d}</small>`; ol.append(li);
    });
    $('#rollWeather').disabled = st.turn <= 3;
  }

  function refresh() { renderTurn(); renderVP(); renderCombat(); api.onRefresh?.(); }

  // ---------------- 接线
  document.querySelectorAll('.tab').forEach((t) => t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    document.querySelectorAll('.pane').forEach((p) => (p.hidden = p.dataset.pane !== t.dataset.tab));
  });
  function setMode(m) {
    if (mode === m) return;
    mode = m; last = null; cur = 0; done = []; atts = []; def = null; renderResult();
    document.querySelectorAll('.mode button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.mode === m)));
    renderCombat();
  }
  document.querySelectorAll('.mode button').forEach((b) => b.onclick = () => setMode(b.dataset.mode));
  document.querySelectorAll('[data-step]').forEach((b) => b.onclick = () => { extra[b.dataset.step] = Math.max(-6, Math.min(6, extra[b.dataset.step] + +b.dataset.d)); renderCombat(); });
  $('#rollCombat').onclick = () => doRoll();
  $('#swapBtn').onclick = () => { const a = atts[cur] || atts[0]; if (!a || !def) return; const d0 = def; def = a; atts = [d0]; cur = 0; done = []; last = null; renderResult(); renderCombat(); };
  const clear = () => { atts = []; def = null; cur = 0; done = []; last = null; extra = { att: 0, def: 0 }; cmpUse = { att: {}, def: {} }; renderResult(); renderCombat(); };
  $('#clearBtn').onclick = clear;
  $('#nextPhase').onclick = () => next(1); $('#nextPhase2').onclick = () => next(1); $('#prevPhase').onclick = () => next(-1);
  $('#rollWeather').onclick = rollWeather; $('#rollFuel').onclick = rollFuel; $('#rollAir').onclick = rollAir;

  function setSlot(role, p) {
    if (!p || p.kind !== 'unit') return;
    if (role === 'att') {
      if (atts.includes(p)) return;
      if (atts.length && atts[0].u.side !== p.u.side) { atts = []; done = []; cur = 0; }
      if (atts.length >= MAX_ATT) { api.toast(`最多 ${MAX_ATT} 个攻方`); return; }
      if (cur >= atts.length) { atts = atts.filter((_, i) => !done[i]); done = []; cur = 0; }
      atts.push(p);
    } else if (def !== p) { def = p; done = []; cur = 0; atts = atts.filter((q) => q !== p && !attacked(q)); }
    if (!last || last.applied) last = null;
    cmpUse = { att: {}, def: {} };
    renderResult(); renderCombat();
  }
  // 选中己方算子后点敌军：进入战斗面板
  function engage(att, target, m) {
    setMode(m);
    setSlot('def', target); setSlot('att', att);
    document.querySelector('.tab[data-tab="combat"]').click();
  }
  return { refresh, setSlot, engage, airStrike, canRegroup, regroup, engActions, attacked, disguised, nextSeq, api };
}
