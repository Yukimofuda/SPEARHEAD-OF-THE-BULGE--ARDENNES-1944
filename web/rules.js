// 规则辅助：战斗与炮击计算（含单位特殊规则与指挥点）、空袭、回合流程、胜利点（按最终修订版规则书）
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const PHASES = [
  ['准备阶段', '整补 1 个损伤单位（有补给且不在敌方 ZOC）；移除压制与断补标记；燃油检定；天气（第 4 回合起）；补给检查（第 1 回合免查）'],
  ['空袭阶段', '天气晴朗时，把 P-47 算子拖到 1 个德军单位上：1-3 压制，4-6 造成 1 点损伤'],
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
const MAX_ATT = 6;

export function initRules(api) {
  const { D, OBJ, TERRAIN, st, pieces, hexDist, trayAt, pieceHex } = api;
  let mode = 'assault', atts = [], def = null, extra = { att: 0, def: 0 }, cmpUse = { att: {}, def: {} };
  let cur = 0, done = [], last = null;

  const statsOf = (p) => (p.flip ? p.u.red : p.u.full);
  const markersOn = (h, type) => !!h && [...pieces.values()].some((q) => q.kind === 'marker' && q.type === type && pieceHex(q)?.id === h.id);
  const isVGD = (p) => p.u.tags.includes('VGD');
  const onMap = (p) => pieces.has(p.id) && !!pieceHex(p) && !trayAt(p.tx, p.tz);
  const combatUnits = () => [...pieces.values()].filter((q) => q.kind === 'unit' && !['hq', 'air'].includes(q.u.kind) && onMap(q));
  const phaseKey = () => st.turn + '-' + st.phase;
  // hits / cmp 存成 JSON 字符串，同步时整体覆盖，不会和上一阶段的数据合并在一起
  const jsonOf = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
  const hitBy = (p) => (st.hits?.k === phaseKey() && jsonOf(st.hits.s)[p.id]) || [];
  const disguised = () => !st.g150 && st.turn <= 2;
  // 本方最近一次德军行动阶段的开始（用于“阵地防御”）
  const lastGEPhase = () => (st.phase >= 3 ? st.turn : st.turn - 1) * 6 + 3;
  const movedSince = (p, idx) => (st.mv?.[p.id] ?? -1) >= idx;

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
    if (markersOn(ah, 'F')) am.push(['攻方疲劳', -1]);
    if (mode === 'assault') {
      if (ah && dh && hexDist(ah, dh) !== 1) warn.push('目标不相邻（直接战斗只能攻击相邻格）');
      if (att.u.kind === 'art') warn.push('炮兵请用“炮击”');
      if (['hq', 'air'].includes(att.u.kind)) warn.push('这个单位不能发起地面进攻');
      if (markersOn(ah, 'F')) warn.push('攻方处于疲劳，不能主动进攻');
      if (markersOn(ah, 'P')) warn.push('攻方被压制，不能主动进攻');
      if (T1 && att.u.side === 'US') warn.push('第 1 回合美军不能主动进攻');
      if (dh) {
        const town = dh.t === 't', hill = dh.t === 'h', forest = dh.t === 'f';
        const lose = T1 && def.u.side === 'US';
        const blast = att.u.tags.includes('pioneer') && (forest || hill);
        if (town) dm.push(['城镇', 2]);
        if (hill) dm.push(lose ? ['高地（奇袭失效）', 0] : blast ? ['高地（爆破无视）', 0] : ['高地', 1]);
        if (forest && ['inf', 'eng'].includes(def.u.kind)) dm.push(lose ? ['森林（奇袭失效）', 0] : blast ? ['森林（爆破无视）', 0] : ['森林', 1]);
        if (markersOn(dh, 'K')) dm.push(['工事', 1]);
        if (markersOn(dh, 'F')) { dm.push(['守方疲劳', -1]); if (def.u.tags.includes('green')) dm.push(['缺乏经验', -1]); }
      }
      if (ah && dh && api.RIVER.has([ah.id, dh.id].sort().join('|'))) { am.push(['跨河', -1]); dm.push(['河流', 1]); }
      if (ah && dh && ah.t === 'h' && dh.t !== 'h') am.push(['从高地攻击', 1]);
      if (T1 && att.u.side === 'GE') am.push(['奇袭', 1]);
      if (T1 && def.u.side === 'US') dm.push(['情报真空', -1]);
      // 攻方特殊规则
      const prev = hitBy(def).filter((id) => id !== att.id);
      if (att.u.tags.includes('blitz')) am.push(['装甲突击', 2]);
      if (att.u.tags.includes('combined') && prev.includes('GPz1')) am.push(['步坦协同', 1]);
      if (att.u.tags.includes('ccb') && prev.some((id) => pieces.get(id)?.u.side === 'US')) am.push(['经验丰富', 1]);
      if (att.u.tags.includes('vs_vgd') && isVGD(def)) am.push(['老兵经验', 1]);
      if (att.u.tags.includes('flank') && markersOn(dh, 'F')) am.push(['侧翼掩护', 1]);
      if (att.u.tags.includes('human_wave') && ah && combatUnits().some((q) => q !== att && q.u.side === att.u.side && hexDist(pieceHex(q), ah) === 1)) am.push(['人海战术', 1]);
      if (att.u.tags.includes('woods') && ah?.t === 'f' && def.u.kind === 'inf') am.push(['林地猎手', 1]);
      if (att.u.tags.includes('mechfire') && dh?.t === 'c') am.push(['机械化火力', 1]);
      // 守方特殊规则
      if (def.u.tags.includes('ambush') && att.u.kind === 'armor') dm.push(['伏击', 1]);
      if (def.u.tags.includes('hetzer') && dh && ['f', 'h'].includes(dh.t)) dm.push(['“追猎者”反击', 1]);
      if (def.u.tags.includes('woods') && dh?.t === 'f' && att.u.kind === 'inf') dm.push(['林地猎手', 1]);
      if (def.u.tags.includes('mechfire') && dh?.t === 'c') dm.push(['机械化火力', 1]);
      if (def.u.tags.includes('dig_in') && !movedSince(def, lastGEPhase())) dm.push(['阵地防御（未移动）', 1]);
    } else {
      if (att.u.kind !== 'art') warn.push('射击方不是炮兵单位');
      if (ah && dh && hexDist(ah, dh) > sa[3]) warn.push(`目标超出射程 R${sa[3]}`);
      if (!att.u.tags.includes('mobile_art') && movedSince(att, st.turn * 6)) warn.push('本回合移动过的炮兵不能射击');
      if (def.u.tags.includes('ambush') && dh && ['f', 'h'].includes(dh.t) && !st.m10) warn.push('伏击：705 坦歼营在森林/高地，首次进攻之前不能被炮兵作为目标');
      if (dh) {
        if (dh.t === 't') dm.push(['城镇', 2]); else if (dh.t === 'h') dm.push(['高地', 1]); else if (dh.t === 'f') dm.push(['森林', 1]);
        if (markersOn(dh, 'K')) dm.push(['工事', 1]);
        if (att.u.tags.includes('heavy_art') && !['t', 'f'].includes(dh.t)) am.push(['重炮/火箭炮', 1]);
        // 观察哨：目标 2 格以内（8 骑兵侦察营 3 格）有己方非炮兵单位；相邻时 +1
        const obs = combatUnits().filter((q) => q.u.side === att.u.side && q.u.kind !== 'art' && hexDist(pieceHex(q), dh) <= (q.u.tags.includes('recon') ? 3 : 2));
        if (!obs.length) warn.push('目标附近没有己方观察哨（2 格以内的非炮兵单位）');
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
  function attListHtml() {
    if (!atts.length) return `<span class="label">${mode === 'assault' ? '攻方' : '炮兵'}</span><span class="hint">点选算子后按 A（可以加多个，依次结算）</span>`;
    return `<span class="label">${mode === 'assault' ? '攻方' : '炮兵'} · ${atts[0].u.side === 'US' ? '美军' : '德军'}${atts.length > 1 ? ` · ${atts.length} 个依次结算` : ''}</span>` +
      atts.map((p, i) => {
        const s = statsOf(p), h = pieceHex(p), r = done[i];
        return `<div class="arow${i === cur ? ' cur' : ''}${r ? ' done' : ''}"><span><b>${esc(p.u.name)}</b> <span class="num">${s.join('-')}</span>
          <span class="hint">${h ? h.id + ' ' + TERRAIN[h.t] : '不在地图上'}${r ? ' · ' + esc(r) : ''}</span></span>
          <button class="btn x" data-rm="${i}" title="移出">×</button></div>`;
      }).join('');
  }
  function defHtml() {
    if (!def) return `<span class="label">守方 / 目标</span><span class="hint">点选算子后按 D</span>`;
    const s = statsOf(def), h = pieceHex(def);
    return `<span class="label">守方 · ${def.u.side === 'US' ? '美军' : '德军'}</span><b>${esc(def.u.name)}</b>
      <span class="stat num">${s.join('-')}</span><span class="hint">${h ? h.id + ' ' + TERRAIN[h.t] : '不在地图上'}${def.flip ? ' · 损伤面' : ''}</span>`;
  }
  function modsHtml(list, base, total, label) {
    return `<div><span>${label}</span><span class="num">${base}</span></div>` +
      list.map(([n, v]) => `<div><span>${esc(n)}</span><span class="num ${v < 0 ? 'neg' : v > 0 ? 'pos' : ''}">${v >= 0 ? '+' : ''}${v}</span></div>`).join('') +
      `<div style="border-top:1px solid var(--line);padding-top:2px"><b>合计</b><b class="num">${total}</b></div>`;
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
    $('#attSlot').innerHTML = attListHtml(); $('#attSlot').classList.toggle('filled', atts.length > 0);
    $('#defSlot').innerHTML = defHtml(); $('#defSlot').classList.toggle('filled', !!def);
    $('#attExtra').textContent = extra.att; $('#defExtra').textContent = extra.def;
    const c = compute(a);
    $('#attMods').innerHTML = c ? modsHtml(c.am, c.baseA, c.A, mode === 'assault' ? '攻击力 A' : '炮兵 A') + (extra.att ? `<div><span>额外修正</span><span class="num">${extra.att > 0 ? '+' : ''}${extra.att}</span></div>` : '') : '';
    $('#defMods').innerHTML = c ? modsHtml(c.dm, c.baseD, c.D, mode === 'assault' ? '防御力 D' : '目标修正') + (extra.def ? `<div><span>额外修正</span><span class="num">${extra.def > 0 ? '+' : ''}${extra.def}</span></div>` : '') : '';
    if (c && c.warn.length) $('#attMods').innerHTML += `<div class="neg">⚠ ${c.warn.map(esc).join('；')}</div>`;
    const cr = $('#cmpRow'); cr.innerHTML = cmpHtml(); cr.hidden = !cr.innerHTML;
    const rb = $('#rollCombat');
    rb.disabled = !c || (last && !last.applied);
    rb.textContent = atts.length > 1 ? (a ? `掷骰结算 · 第 ${cur + 1}/${atts.length} 个` : '全部结算完毕') : '掷骰结算';
    $('#attSlot').querySelectorAll('[data-rm]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); removeAtt(+b.dataset.rm); });
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
    const k = phaseKey(), m = st.hits?.k === k ? jsonOf(st.hits.s) : {};
    m[def.id] = [...(m[def.id] || []), att.id];
    st.hits = { k, s: JSON.stringify(m) }; api.commit({ hits: st.hits });
    if (att.u.id === 'G150' && !st.g150) { st.g150 = 1; api.commit({ g150: 1 }); api.log('150 装甲旅首次进攻，伪装解除', 'GE'); }
    if (att.u.tags.includes('ambush') && !st.m10) { st.m10 = 1; api.commit({ m10: 1 }); }
  }

  async function doRoll(reroll = null) {
    const att = reroll ? last.att : active();
    const c = reroll ? last.c : compute(att); if (!c) return;
    $('#rollCombat').disabled = true;
    let ra, rd;
    if (reroll) {
      const f = await api.rollDice(['def'], reroll); if (!f) return;
      ra = last.ra; rd = f[0];
    } else {
      const f = await api.rollDice(['att', 'def'], mode === 'assault' ? '战斗' : '炮击'); if (!f) return;
      [ra, rd] = f;
      markHit(att); spendCmp();
    }
    const diff = c.A + ra - (c.D + rd);
    let res = mode === 'assault' ? CRT(diff) : ART(diff), crit = false;
    if (ra === 6 && diff >= 2) {
      const up = mode === 'assault' ? CRT_UP : ART_UP, i = up.indexOf(res);
      if (i >= 0 && i < up.length - 1) { res = up[i + 1]; crit = true; }
    }
    const rerolls = reroll ? [...last.rerolls, reroll] : [];
    last = { ra, rd, diff, res, crit, att, def, mode, c, idx: cur, applied: false, rerolls };
    const line = `${att.u.name}（${c.A}+${ra}）对 ${def.u.name}（${c.D}+${rd}）：优势差 ${diff >= 0 ? '+' : ''}${diff} → ${res}${crit ? '（暴击提升）' : ''}${reroll ? '（' + reroll + '）' : ''}`;
    api.log((mode === 'assault' ? '战斗 ' : '炮击 ') + line, att.u.side);
    done[cur] = res;
    renderResult(); renderCombat();
  }

  // 结果之后要提醒玩家的特殊规则
  function notes(r) {
    const out = [], dmg = /D\d/.test(r.res) && r.res !== '攻方D1', rt = /R\d|X/.test(r.res) && r.res !== '攻方R1';
    const hits = r.res.startsWith('D2') ? 2 : r.res.startsWith('D1') ? 1 : 0;
    const survived = pieces.has(r.def.id) && onMap(r.def) && (r.applied || (r.def.dmg || 0) + hits < r.def.u.hp);
    if (!survived) return r.mode === 'assault' ? [`${r.def.u.name} 被消灭。攻方可以推进进入空出的格。`,
      ...(r.att.u.tags.includes('blitz') ? ['装甲突击：消灭敌方单位后可以立即再移动至多 2 格（不计地形，进入敌方 ZOC 即停，不能再进攻）。'] : [])] : [`${r.def.u.name} 被消灭。`];
    if (rt && dmg && r.def.u.tags.includes('fanatic')) out.push('狂热防御：受损但未被消灭，忽略后撤。');
    else if (rt && dmg && r.def.u.tags.includes('veteran')) out.push('老兵坚韧：受损后可以原地不动，忽略后撤。');
    else if (rt && survived) out.push('后撤请拖动守方算子：新格不能与攻方相邻，只能撤进敌方 ZOC 时每格受 1 点损伤，无格可撤时原地受 2 点损伤。');
    if (r.res === '攻方R1') out.push('攻方后撤 1 格，请拖动攻方算子。');
    if (r.mode === 'assault' && rt) out.push('守方后撤后，攻方可以推进进入空出的格。');
    if (r.mode === 'assault' && r.def.u.tags.includes('first_contact') && st.turn === 1 && r.att.u.side === 'GE' && r.res !== '无' && !r.res.startsWith('攻方')) out.push('初次交战：第 1 回合被击中，自动疲劳。');
    return out;
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
    const nts = r.applied ? r.notes : notes(r);
    box.innerHTML = `<span class="label">${r.mode === 'assault' ? '战斗结果' : '炮击结果'} · ${esc(r.att.u.name)} → ${esc(r.def.u.name)}</span>
      <div class="row" style="justify-content:space-between"><span class="big">${esc(r.res)}</span><span class="num">骰 ${r.ra} : ${r.rd} · 优势差 ${r.diff >= 0 ? '+' : ''}${r.diff}</span></div>
      <span>${EXPLAIN[r.res] || ''}${r.crit ? ' 攻方掷出 6，结果提升一级。' : ''}${r.mode === 'assault' ? ' 攻方结算后疲劳。' : ''}</span>
      ${nts.map((n) => `<span class="hint">· ${esc(n)}</span>`).join('')}
      <div class="row"><button class="btn primary" id="applyRes" ${r.applied ? 'disabled' : ''}>${r.applied ? '已执行' : '执行损伤与疲劳'}</button>
      ${rerollOptions(r).map((o) => `<button class="btn" data-reroll="${esc(o)}">${esc(o)}防御骰</button>`).join('')}</div>`;
    $('#applyRes').onclick = applyResult;
    box.querySelectorAll('[data-reroll]').forEach((b) => b.onclick = () => doRoll(b.dataset.reroll));
  }
  function applyResult() {
    const r = last; if (!r || r.applied) return;
    r.notes = notes(r);
    r.applied = true;
    const res = r.res;
    const dead = (p) => (p.dmg || 0) >= p.u.hp;
    const fatigue = (p) => { if (pieces.has(p.id) && !dead(p) && onMap(p) && !markersOn(pieceHex(p), 'F')) api.placeMarker('F', p); };
    if (r.mode === 'assault') {
      if (res === '攻方D1') api.damage(r.att, 1);
      if (res.startsWith('D2')) api.damage(r.def, 2); else if (res.startsWith('D1')) api.damage(r.def, 1);
      if (res === 'F') fatigue(r.def);
      if (r.def.u.tags.includes('first_contact') && st.turn === 1 && r.att.u.side === 'GE' && res !== '无' && !res.startsWith('攻方')) fatigue(r.def);
      fatigue(r.att);
    } else {
      if (res.startsWith('D1')) api.damage(r.def, 1);
      if (res !== '无') fatigue(r.def);
      if (res === 'D1+A') {
        const h = pieceHex(r.def);
        for (const q of combatUnits()) {
          if (q === r.def) continue;
          if (r.att.u.tags.includes('werfer') && q.u.side === r.att.u.side) continue;
          if (h && hexDist(h, pieceHex(q)) === 1) fatigue(q);
        }
      }
    }
    api.toast('已执行：' + res);
    // 下一个攻方；守方已离开地图时，剩下的进攻作废
    cur++;
    if (dead(r.def) || !onMap(r.def)) { for (let i = cur; i < atts.length; i++) done[i] = '目标已消灭，未进攻'; cur = atts.length; }
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
    return null;
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
    const crisis = f[0] === 1;
    st.fuel = crisis ? st.turn : 0; api.commit({ fuel: st.fuel });
    api.log(`燃油检定 ${f[0]}${crisis ? ' → 燃油危机：派普战斗群装甲/机械化单位本回合 MP 减半' : ' → 正常'}`, 'GE');
    api.toast(crisis ? '燃油危机！派普战斗群 MP 减半（移动范围已自动计入）' : `燃油检定 ${f[0]}，正常`);
  }
  function rollAir() {
    const sel = api.selectedUnit?.();
    if (sel && sel.u.side === 'GE') { airStrike(sel).then((msg) => msg && api.toast(msg)); return; }
    api.toast('把桌上的 P-47 算子拖到目标德军单位上，就会自动空袭');
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
    mode = b.dataset.mode; last = null; cur = 0; done = []; renderResult();
    document.querySelectorAll('.mode button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderCombat();
  });
  document.querySelectorAll('[data-step]').forEach((b) => b.onclick = () => { extra[b.dataset.step] = Math.max(-6, Math.min(6, extra[b.dataset.step] + +b.dataset.d)); renderCombat(); });
  $('#rollCombat').onclick = () => doRoll();
  $('#swapBtn').onclick = () => { const a = atts[cur] || atts[0]; if (!a || !def) return; const d0 = def; def = a; atts = [d0]; cur = 0; done = []; last = null; renderResult(); renderCombat(); };
  $('#clearBtn').onclick = () => { atts = []; def = null; cur = 0; done = []; last = null; extra = { att: 0, def: 0 }; cmpUse = { att: {}, def: {} }; renderResult(); renderCombat(); };
  $('#nextPhase').onclick = () => next(1); $('#nextPhase2').onclick = () => next(1); $('#prevPhase').onclick = () => next(-1);
  $('#rollWeather').onclick = rollWeather; $('#rollFuel').onclick = rollFuel; $('#rollAir').onclick = rollAir;

  function setSlot(role, p) {
    if (!p || p.kind !== 'unit') return;
    if (role === 'att') {
      if (atts.includes(p)) { api.toast(`${p.u.name} 已经在攻方里`); return; }
      if (atts.length && atts[0].u.side !== p.u.side) { atts = []; done = []; cur = 0; }
      if (atts.length >= MAX_ATT) { api.toast(`最多 ${MAX_ATT} 个攻方`); return; }
      if (cur >= atts.length) { atts = atts.filter((_, i) => !done[i]); done = []; cur = 0; }
      atts.push(p);
    } else {
      if (def !== p) { def = p; done = []; cur = 0; atts = atts.filter((q) => q !== p); }
    }
    if (!last || last.applied) last = null;
    cmpUse = { att: {}, def: {} };
    renderResult(); renderCombat();
    document.querySelector('.tab[data-tab="combat"]').click();
    api.toast(`${p.u.name} 设为${role === 'att' ? (atts.length > 1 ? `第 ${atts.length} 个攻方` : '攻方') : '守方'}`);
  }
  return { refresh, setSlot, airStrike, api };
}
