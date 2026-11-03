# 《突出部之矛：阿登1944》规则引擎（按现行规则逐条实现，模糊处采用“最合理读法”并记录）
import heapq
import random
from collections import Counter, defaultdict

from hexmap import Map, TOWNS, OBJECTIVES, neighbors, dist, neighbor_in_dir, W, H
from units import make_units

ARMORED = ('armor',)                 # “装甲单位”：森林3MP、燃油减半
INF_LIKE = ('inf', 'eng', 'mech')    # 森林防御+1（步兵/工兵；机步按步兵算）
TERRAIN_COST = {'clear': 1, 'forest': 2, 'hill': 3, 'town': 1}
TERRAIN_DEF = {'clear': 0, 'forest': 1, 'hill': 1, 'town': 2}

CRT = {0: 'F', 1: 'F', 2: 'R1', 3: 'D1R1', 4: 'D1R2', 5: 'D2'}   # >=6: D2R1；<0：规则未定义
ART = {1: 'P1', 2: 'P1X', 3: 'D1P1', 4: 'P2X', 5: 'D1X'}            # >=6: D1A
ART_ORDER = ['none', 'P1', 'P1X', 'D1P1', 'P2X', 'D1X', 'D1A']

DEFAULT_VARIANT = dict(
    fatigue_persist=False,   # 修正案A：疲劳持续到本方下一个行动阶段结束
    fatigue_mild=False,      # 修正案B：攻方疲劳只持续到对方下一个行动阶段结束；其他疲劳持续到本方下一个行动阶段结束
    tough3=False,            # 修正案：101空降“顽强”=3HP
    heal_needs_supply=False, # 修正案：整补需有补给且不在EZOC
    attacker_risk=False,     # 修正案：负优势差对攻方有结果
    blitz_ignores_zoc=True,  # 现行：派普装甲团特技名含“闪电战”，按ZOC条款可无视ZOC
    supply_bites=False,      # 字面读法：“断补”标记无定义效果；True=断补即本回合疲劳
    heal_per_turn=1,
    # ---- 修订条文草案 ----
    crt_neg=False,           # CRT 负值栏：-3~-4 攻方后撤1格，<=-5 攻方受1伤
    crit_simple=False,       # 暴击：自然6且优势差>=+2，结果提升一级（上限D2R1）
    advance=False,           # 战斗后推进
    control_markers=False,   # 控制标记：最后占据方持有
    exit_vp=3, noexit_avp=3,
    surprise_keep_town=False,# 奇袭只取消森林/高地加成，城镇+2保留
    hq_pool=False,           # CMP 为每回合总点数
    art_heavy_open=False,    # 重炮/火箭炮+1只对开阔地目标
    werfer_enemy_only=False, # 啸叫死神：区域疲劳只影响敌方
    quick_limited=False,     # 快速反应不能在被宣布攻击后使用
    dig_in_fix=False,        # 989团：自上一个本方阶段以来未移动
    min_move=False,          # 满MP单位至少可移动1格
    supply_radius=1,         # 补给追溯起点离道路的最大格数
    engineer_fix=False,      # 炸桥：整个阶段不移动不战斗 + 4-6成功
    vp_categories=False,     # 炮兵0.5、HQ 1 等分类计分
    fuel_peiper=False,       # 燃油只影响派普战斗群装甲/机步
    flak_fix=False,          # 高炮掷5-6时空袭骰-2
    cb_replace=False,        # 反炮兵：放弃本阶段射击才能反击
    fsch_fix=False,          # 空投目标不得为城镇，非法落点翻面
    us_thr=2,
)

DRAFT = dict(fatigue_mild=True, crt_neg=True, crit_simple=True, advance=True, control_markers=True,
             tough3=True, heal_needs_supply=True, supply_bites=True, supply_radius=2, blitz_ignores_zoc=False,
             surprise_keep_town=True, hq_pool=True, art_heavy_open=True, werfer_enemy_only=True,
             quick_limited=True, dig_in_fix=True, min_move=True, engineer_fix=True, vp_categories=True,
             fuel_peiper=True, flak_fix=True, cb_replace=True, noexit_avp=3, fsch_fix=True)


class Game:
    def __init__(self, seed=0, variant=None, verbose=False):
        self.rng = random.Random(seed)
        self.V = dict(DEFAULT_VARIANT, **(variant or {}))
        self.map = Map()
        self.units = make_units()
        self.by_id = {u.uid: u for u in self.units}
        self.turn = 0
        self.weather = 'snow'
        self.fuel_crisis = False
        self.verbose = verbose
        self.log_lines = []
        self.stats = Counter()        # 规则触发统计
        self.losses = {'US': [], 'GE': []}
        self.exits = []
        self.phase = ''
        self.action_idx = 0
        self.attacked_targets = defaultdict(list)   # 本阶段每个目标被谁攻击过
        self.ctrl = {name: 'US' for name in OBJECTIVES}
        self.hq_left = {}
        if self.V['tough3']:
            u = self.by_id['US501']; u.hp = u.max_hp = 3

    # ------------------------------------------------------------ 工具
    def log(self, s):
        self.log_lines.append(f'T{self.turn} {self.phase}: {s}')
        if self.verbose:
            print(self.log_lines[-1])

    def d6(self):
        return self.rng.randint(1, 6)

    def combat_units(self, side=None):
        return [u for u in self.units if u.on_map and u.kind != 'hq' and (side is None or u.side == side)]

    def occupant(self, h):
        for u in self.units:
            if u.on_map and u.kind != 'hq' and u.pos == h:
                return u
        return None

    def enemy(self, side):
        return 'GE' if side == 'US' else 'US'

    def exerts_zoc_on(self, u, side):
        """u 是否对 side 方施加 ZOC"""
        if u.side == side or not u.on_map or u.kind == 'hq':
            return False
        if u.disguised and side == 'US':
            return False
        return True

    def ezoc(self, side):
        z = set()
        for u in self.units:
            if self.exerts_zoc_on(u, side):
                z.update(neighbors(u.pos))
        return z

    def terrain(self, h):
        return self.map.terrain[h]

    # ------------------------------------------------------------ 疲劳时钟
    def set_fatigue(self, u, n=1, attacker=False):
        if self.V['fatigue_mild'] and attacker:
            t_idx = 2 * self.turn - 1 if self.phase == '美军行动' else 2 * self.turn
            u.fatigue = 1
            u.fat_until = max(getattr(u, 'fat_until', 0), t_idx + 1)
            return
        if not (self.V['fatigue_persist'] or self.V['fatigue_mild']):
            u.fatigue = max(u.fatigue, n)
            return
        # 修正案：疲劳持续到“本方下一个行动阶段”结束（P2 再多一个本方阶段）
        own = 1 if u.side == 'US' else 2
        cur = self.action_idx
        t_idx = 2 * self.turn - 1 if self.phase == '美军行动' else (2 * self.turn if self.phase == '德军行动' else None)
        if t_idx is None:   # 准备/炮兵阶段：下一回合本方阶段
            base = 2 * (self.turn + (1 if self.phase == '炮兵阶段' else 0)) - 2 + own
            if self.phase == '准备阶段':
                base = 2 * self.turn - 2 + own
        else:
            base = t_idx + (2 if (t_idx % 2 == 1) == (u.side == 'US') else 1)
        until = base + 2 * (n - 1)
        u.fatigue = 1
        u.fat_until = max(getattr(u, 'fat_until', 0), until)

    def end_action_phase(self, side):
        if not (self.V['fatigue_persist'] or self.V['fatigue_mild']):
            return
        idx = 2 * self.turn - (1 if side == 'US' else 0)
        for u in self.units:
            if u.fatigue and getattr(u, 'fat_until', 0) <= idx:
                u.fatigue = 0

    # ------------------------------------------------------------ 移动
    def step_cost(self, u, a, b):
        e = frozenset((a, b))
        occ = self.occupant(b)
        if occ and occ.side != u.side:
            return None
        if e in self.map.river_edges:
            if e in self.map.bridges and e not in self.map.blown:
                return 2
            if e in self.map.pontoons and 'heavy' not in u.tags:
                return 2
            return None
        if e in self.map.road_edges:
            return 0.25 if 'motor' in u.tags else 0.5
        t = self.terrain(b)
        if t == 'forest':
            if 'snow' in u.tags and self.turn == 1:
                return 1
            return 3 if u.kind in ARMORED or u.kind in ('art', 'mech') else 2
        if t == 'clear' and 'recon' in u.tags:
            return 0.5
        if 'thunder' in u.tags and not u.moved and self.turn == 4 and t == 'clear':
            return 0
        return TERRAIN_COST[t]

    def static_cost(self, u, a, b):
        """不考虑单位占位的地形消耗（用于AI寻路）"""
        e = frozenset((a, b))
        if e in self.map.river_edges:
            if e in self.map.bridges and e not in self.map.blown:
                return 2
            if e in self.map.pontoons and 'heavy' not in u.tags:
                return 2
            return None
        if e in self.map.road_edges:
            return 0.5
        t = self.terrain(b)
        if t == 'forest':
            return 3 if u.kind in ARMORED or u.kind in ('art', 'mech') else 2
        return TERRAIN_COST[t]

    def path_dist(self, u, target):
        targets = tuple(target) if isinstance(target, list) else (target,)
        key = (u.kind, 'heavy' in u.tags, targets, frozenset(self.map.blown))
        cache = self.__dict__.setdefault('_pd_cache', {})
        if key not in cache:
            best = {t: 0 for t in targets}
            pq = [(0, t) for t in targets]
            while pq:
                c, h = heapq.heappop(pq)
                if c > best[h]:
                    continue
                for n in neighbors(h):
                    sc = self.static_cost(u, n, h)
                    if sc is None:
                        continue
                    if c + sc < best.get(n, 1e9):
                        best[n] = c + sc
                        heapq.heappush(pq, (c + sc, n))
            cache[key] = best
        return cache[key]

    def effective_mp(self, u):
        mp = u.MP
        if u.fatigue > 0:
            mp = max(1, mp - 1)
            self.stats['疲劳导致MP-1实际生效'] += 1
        if u.side == 'GE' and self.fuel_crisis:
            if self.V['fuel_peiper']:
                if 'peiper' in u.tags and u.kind in ('armor', 'mech'):
                    mp = mp // 2
            elif u.kind in ARMORED:
                mp = mp / 2
        return mp

    def reachable(self, u, mp=None):
        if mp is None:
            mp = self.effective_mp(u)
        z = self.ezoc(u.side)
        ignore_zoc = 'blitz' in u.tags and self.V['blitz_ignores_zoc']
        best = {u.pos: 0}
        pq = [(0, u.pos)]
        while pq:
            c, h = heapq.heappop(pq)
            if c > best.get(h, 1e9):
                continue
            if h != u.pos and h in z and not ignore_zoc:
                continue   # 进入敌方控制区必须停止
            for n in neighbors(h):
                sc = self.step_cost(u, h, n)
                if sc is None:
                    continue
                if u.kind == 'hq' and u.side == 'US' and n in z:
                    continue
                nc = c + sc
                if self.V['min_move'] and h == u.pos and nc > mp and mp >= u.MP - 1e-9:
                    nc = mp   # 满MP单位至少可移动1格
                if nc <= mp + 1e-9 and nc < best.get(n, 1e9):
                    best[n] = nc
                    heapq.heappush(pq, (nc, n))
        # 终点不能与友军战斗单位堆叠（规则未写堆叠上限，按 1 个战斗单位/格）
        return {h: c for h, c in best.items() if h == u.pos or not self.occupant(h)}

    def move_unit(self, u, dest, why=''):
        if dest != u.pos:
            self.log(f'{u} {u.pos}->{dest} {why}')
            u.pos = dest
            u.moved = True
            for hq in self.units:
                if hq.kind == 'hq' and hq.on_map and getattr(hq, 'follow', None) == u.uid:
                    hq.pos = dest

    # ------------------------------------------------------------ 补给
    def supply_net(self, side):
        z = self.ezoc(side)
        src = [h for h in self.map.road_hexes if h[0] == (0 if side == 'US' else W - 1)]
        src += [hq.pos for hq in self.units if hq.kind == 'hq' and hq.on_map and hq.side == side]
        seen = set(h for h in src if h not in z)
        stack = list(seen)
        while stack:
            h = stack.pop()
            for n in neighbors(h):
                if n in seen or frozenset((h, n)) not in self.map.road_edges:
                    continue
                if n in z:
                    continue
                occ = self.occupant(n)
                if occ and occ.side != side:
                    continue
                if frozenset((h, n)) in self.map.river_edges and frozenset((h, n)) in self.map.blown:
                    continue
                seen.add(n)
                stack.append(n)
        return seen

    def in_supply(self, u, net):
        r = self.V['supply_radius']
        return any(dist(u.pos, h) <= r for h in net)

    # ------------------------------------------------------------ 伤害与后撤
    def damage(self, u, n, src=''):
        if n <= 0 or not u.alive:
            return
        u.hp -= n
        if u.hp <= 0:
            u.alive = False
            self.losses[u.side].append(u)
            self.log(f'  ** {u.name} 被消灭 ({src})')
            for hq in self.units:
                if hq.kind == 'hq' and hq.on_map and getattr(hq, 'follow', None) == u.uid:
                    self.relocate_hq(hq)
        else:
            self.log(f'  {u.name} 受 {n} 点损伤 -> 剩余HP {u.hp}')

    def relocate_hq(self, hq):
        # 规则未定义：被跟随单位消灭后指挥部如何处理。此处转移到最近友军，3格外则消灭
        friends = [f for f in self.combat_units(hq.side)]
        friends.sort(key=lambda f: dist(f.pos, hq.pos))
        if friends and dist(friends[0].pos, hq.pos) <= 3:
            hq.follow = friends[0].uid
            hq.pos = friends[0].pos
            self.stats['指挥部失去宿主(规则未定义)'] += 1
        else:
            hq.alive = False
            self.losses[hq.side].append(hq)
            self.stats['指挥部失去宿主被移除(规则未定义)'] += 1

    def retreat(self, u, from_hex, n):
        """R1/R2：向非攻击方邻接方向后撤"""
        for step in range(n):
            if not u.alive:
                return
            z = self.ezoc(u.side)
            cands = []
            for nb in neighbors(u.pos):
                if nb in neighbors(from_hex) or nb == from_hex:
                    continue
                if self.occupant(nb):
                    continue
                e = frozenset((u.pos, nb))
                if e in self.map.river_edges and not (e in self.map.bridges and e not in self.map.blown):
                    continue
                cands.append(nb)
            if not cands:
                self.stats['被包围原地受2伤'] += 1
                self.log(f'  {u.name} 无路可退，原地受2点损伤')
                self.damage(u, 2, '无法后撤')
                return
            free = [c for c in cands if c not in z]
            home = -1 if u.side == 'US' else 1
            if free:
                pick = max(free, key=lambda c: (dist(c, from_hex), home * c[0]))
            else:
                self.stats['后撤入EZOC受1伤'] += 1
                self.damage(u, 1, '撤入敌控区')
                if not u.alive:
                    return
                pick = max(cands, key=lambda c: (dist(c, from_hex), home * c[0]))
            self.log(f'  {u.name} 后撤 {u.pos}->{pick}')
            u.pos = pick
            for hq in self.units:
                if hq.kind == 'hq' and hq.on_map and getattr(hq, 'follow', None) == u.uid:
                    hq.pos = pick

    # ------------------------------------------------------------ 直接战斗
    def hq_bonus(self, u, role, commit=False):
        """指挥点：R 范围内友军战斗时 +CMP（规则未说明是每回合总量还是每次战斗，按每次战斗）"""
        best = 0
        for hq in self.units:
            if hq.kind != 'hq' or not hq.on_map or hq.side != u.side:
                continue
            if dist(hq.pos, u.pos) > hq.R:
                continue
            if hq.uid == 'GHQ12' and role == 'A':
                continue
            if hq.uid == 'GHQ12' and '12ss' not in u.tags:
                continue
            if hq.uid == 'USHQ' and dist(hq.pos, u.pos) > 1:
                continue   # “其邻近的美军单位”
            if self.V['hq_pool']:
                left = self.hq_left.get(hq.uid, hq.cmp)
                if left > best:
                    best, who = left, hq.uid
            else:
                best = max(best, hq.cmp)
        if self.V['hq_pool'] and commit and best:
            self.hq_left[who] = 0      # AI 一次用完该指挥部本回合的点数
        return best

    def defense_terrain(self, d, att, surprise):
        t = self.terrain(d.pos)
        if surprise and d.side == 'US':
            if not (self.V['surprise_keep_town'] and t == 'town'):
                return 0
        mod = TERRAIN_DEF[t]
        if t == 'forest' and d.kind not in INF_LIKE:
            mod = 0
        if 'pioneer' in att.tags and t in ('forest', 'hill'):
            mod = 0
        if self.map.crosses_river(att.pos, d.pos):
            mod += 1
        if d.pos in self.map.forts:
            mod += 1
        return mod

    def expected_diff(self, a, d):
        A, D, ar, dr, _ = self.combat_values(a, d)
        return A + ar - D - dr

    def combat_values(self, a, d, commit=False):
        surprise = self.turn == 1 and a.side == 'GE'
        A = a.A
        D = d.D
        notes = []
        ta, td = self.terrain(a.pos), self.terrain(d.pos)
        if ta == 'hill' and td != 'hill':
            A += 1; notes.append('高地+1')
        if self.map.crosses_river(a.pos, d.pos):
            A -= 1; notes.append('跨河-1')
        if a.fatigue > 0:
            A -= 1
        D += self.defense_terrain(d, a, surprise)
        if d.fatigue > 0:
            D -= 1
            if 'green' in d.tags:
                D -= 1
        if surprise:
            D -= 1; notes.append('情报真空D-1')
        ar = dr = 0
        if surprise:
            ar += 1
        # ---- 特殊规则 ----
        if 'peiper' in a.tags and a.uid == 'GPz1':
            ar += 2
        if 'combined' in a.tags and 'GPz1' in [x.uid for x in self.attacked_targets[d.uid]]:
            A += 1; notes.append('步坦协同+1')
        if 'flank' in a.tags and d.fatigue > 0:
            A += 1
        if 'human_wave' in a.tags and any(self.occupant(n) and self.occupant(n).side == a.side for n in neighbors(a.pos)):
            A += 1
        if 'woods' in a.tags and td == 'forest' and d.kind == 'inf':
            A += 1
        if 'woods' in d.tags and td == 'forest' and a.kind == 'inf':
            D += 1
        if 'vs_vgd' in a.tags and 'VGD' in d.tags:
            ar += 1
        if 'mechfire' in a.tags and td == 'clear':
            A += 1
        if 'mechfire' in d.tags and td == 'clear':
            D += 1
        if 'dig_in' in d.tags and not d.moved and not (self.V['dig_in_fix'] and getattr(d, 'moved_prev', False)):
            dr += 1
            self.stats['989团阵地防御(美军阶段恒成立)'] += 1
        if 'hetzer' in d.tags and td in ('forest', 'hill'):
            D += 1
        if 'ambush' in d.tags and a.kind == 'armor':
            D += 1   # 条文重复写了两次“防御装甲单位时D+1”，此处只算一次
        A += self.hq_bonus(a, 'A', commit)
        D += self.hq_bonus(d, 'D', commit)
        return A, D, ar, dr, notes

    def resolve_combat(self, a, d):
        A, D, ar, dr, notes = self.combat_values(a, d, commit=True)
        ra, rd = self.d6(), self.d6()
        if ('nuts' in d.tags or (d.uid == 'GPz12' and any(h.uid == 'GHQ12' and h.on_map and dist(h.pos, d.pos) <= 1 for h in self.units))):
            if A + ar + ra - (D + dr + rd) >= 2:
                rd2 = self.d6(); self.stats['防御重掷'] += 1
                rd = rd2
        diff = (A + ar + ra) - (D + dr + rd)
        extra = 0
        if ra == 6 and not self.V['crit_simple']:
            diff += 1
            self.stats['暴击'] += 1
            if diff >= 4:
                extra = 1
        self.attacked_targets[d.uid].append(a)
        res = 'none' if diff < 0 else (CRT[diff] if diff <= 5 else 'D2R1')
        if self.V['crit_simple'] and ra == 6 and diff >= 2:
            order = ['R1', 'D1R1', 'D1R2', 'D2', 'D2R1']
            res = order[min(order.index(res) + 1, len(order) - 1)]
            self.stats['暴击'] += 1
        self.stats['优势差<0(规则无结果)' if diff < 0 else f'CRT:{res}'] += 1
        self.log(f'{a} 攻击 {d}@{d.pos}: A{A}+{ar}+骰{ra} vs D{D}+{dr}+骰{rd} 差{diff:+d} -> {res}{"+暴击1伤" if extra else ""} {" ".join(notes)}')
        a.attacked = True
        self.set_fatigue(a, 1, attacker=True)
        if a.disguised:
            a.disguised = False
            self.log(f'  {a.name} 伪装暴露')
        if 'ambush' in a.tags:
            a.fired_once = True
        if self.V['attacker_risk'] and diff <= -3:
            self.damage(a, 1, '进攻受挫')
            self.stats['攻方受挫受1伤'] += 1
        if self.V['crt_neg'] and diff <= -3:
            if diff <= -5:
                self.stats['负值栏:攻方D1'] += 1
                self.damage(a, 1, '进攻受挫')
            else:
                self.stats['负值栏:攻方R1'] += 1
                self.retreat(a, d.pos, 1)
        dmg = extra
        ret = 0
        fat = False
        if res in ('F',):
            fat = True
        if res.startswith('D'):
            dmg += int(res[1])
        if 'R' in res:
            ret = int(res[res.index('R') + 1])
        if self.turn == 1 and 'first_contact' in d.tags and res != 'none':
            fat = True
        if fat:
            self.set_fatigue(d, 1)
        hp_before = d.hp
        dpos = d.pos
        self.damage(d, dmg, f'被{a.name}攻击')
        if not d.alive:
            self.advance_after(a, dpos)
            if 'blitz' in a.tags and a.alive:
                self.stats['派普摧毁后额外移动'] += 1
                self.blitz_move(a)
            return res
        if ret:
            if 'veteran' in d.tags and d.hp < hp_before:
                self.stats['老兵坚韧忽略后撤'] += 1
                ret = 0
            if 'fanatic' in d.tags and d.hp < hp_before:
                ret = 0
            if ret:
                self.retreat(d, a.pos, ret)
                if d.pos != dpos:
                    self.advance_after(a, dpos)
        return res

    def advance_after(self, a, h):
        """战斗后推进：AI 只在空出的格是要点城镇时推进"""
        if not self.V['advance'] or not a.alive or self.occupant(h):
            return
        if any(h == TOWNS[n] for n in OBJECTIVES) and not any(a.pos == TOWNS[n] for n in OBJECTIVES):
            self.stats['战斗后推进占领要点'] += 1
            self.move_unit(a, h, '(战斗后推进)')
            self.update_control()

    def update_control(self):
        for name in OBJECTIVES:
            o = self.occupant(TOWNS[name])
            if o:
                if self.ctrl[name] != o.side:
                    self.stats['控制权易手'] += 1
                self.ctrl[name] = o.side

    def blitz_move(self, a):
        # “可立即额外移动2格”：未说明是否计地形/ZOC，按 2 格、无视地形消耗、仍受ZOC停止
        r = self.reachable(a, mp=99)
        cands = [h for h in r if dist(h, a.pos) <= 2 and not self.occupant(h)]
        if a.route and cands:
            tgt = self.next_waypoint(a)
            best = min(cands, key=lambda h: dist(h, tgt) if tgt else 0)
            self.move_unit(a, best, '(闪电战追击)')

    # ------------------------------------------------------------ 间接射击
    def art_targets(self, art):
        side = art.side
        obs = [u for u in self.combat_units(side) if u.kind != 'art']
        out = []
        for t in self.combat_units(self.enemy(side)):
            if dist(art.pos, t.pos) > art.R:
                continue
            if t.disguised and side == 'US':
                continue
            if 'ambush' in t.tags and not t.fired_once and self.terrain(t.pos) in ('forest', 'hill'):
                self.stats['M10伏击免炮'] += 1
                continue
            near = [o for o in obs if dist(o.pos, t.pos) <= 2]
            if not near:
                continue
            adj = any(dist(o.pos, t.pos) == 1 for o in near)
            out.append((t, adj))
        return out

    def artillery_fire(self, art, t, obs_adj, counter=False):
        heavy = 'heavy_art' in art.tags
        if heavy and self.V['art_heavy_open'] and self.terrain(t.pos) in ('town', 'forest'):
            heavy = False
        bonus = (1 if heavy else 0) + (1 if obs_adj else 0) - (1 if counter else 0)
        if 'anti_art' in t.tags:
            bonus -= 2
        mod = TERRAIN_DEF[self.terrain(t.pos)] + (1 if t.pos in self.map.forts else 0)
        ra, rd = self.d6(), self.d6()
        diff = art.A + ra + bonus - (rd + mod)
        res = 'none' if diff <= 0 else (ART[diff] if diff <= 5 else 'D1A')
        if ra == 6 and diff >= 2:
            i = min(ART_ORDER.index(res) + 1, len(ART_ORDER) - 1)
            res = ART_ORDER[i]
        if 'werfer' in art.tags and res.startswith('D1'):
            res = res if res.endswith('A') else res + '+A'
        self.stats[f'炮击:{res}'] += 1
        self.log(f'{art} 炮击 {t}@{t.pos}: A{art.A}+{bonus}+骰{ra} vs 骰{rd}+地形{mod} 差{diff:+d} -> {res}')
        art.attacked = True
        if res == 'none':
            return
        if 'P2' in res:
            self.set_fatigue(t, 2)
        elif 'P1' in res:
            self.set_fatigue(t, 1)
            self.stats['P1压制(准备阶段即被清除)'] += 1
        if res.startswith('D1'):
            self.damage(t, 1, f'{art.name}炮击')
        if 'X' in res and t.alive:
            self.set_fatigue(t, 1)
            self.retreat(t, art.pos, 1)
        if 'A' in res and t.alive or (res.endswith('A') and not t.alive):
            for n in neighbors(t.pos):
                o = self.occupant(n)
                if o:
                    if self.V['werfer_enemy_only'] and 'werfer' in art.tags and o.side == art.side:
                        continue
                    self.set_fatigue(o, 1)
                    if o.side == art.side:
                        self.stats['区域压制波及友军'] += 1
            if t.alive:
                self.set_fatigue(t, 1)

    def artillery_phase(self):
        self.phase = '炮兵阶段'
        shots = []
        for side in ('US', 'GE'):
            for art in [u for u in self.combat_units(side) if u.kind == 'art']:
                if art.A <= 0 or art.attacked:
                    continue
                if art.moved and 'mobile_art' not in art.tags:
                    self.stats['火炮移动后不能射击(推定)'] += 1
                    continue
                tg = self.art_targets(art)
                if not tg:
                    continue
                t, adj = max(tg, key=lambda x: (x[0].damaged, x[1], -TERRAIN_DEF[self.terrain(x[0].pos)], x[0].A))
                self.artillery_fire(art, t, adj)
                if side == 'GE' and t.side == 'US':
                    shots.append(art)
        # 155 重炮反炮兵（“消耗1AP”——AP 在规则中未定义）
        cb = self.by_id['US155']
        if cb.on_map and cb.A > 0 and not (self.V['cb_replace'] and cb.attacked):
            for art in shots:
                if art.alive and dist(cb.pos, art.pos) <= cb.R:
                    self.stats['反炮兵射击'] += 1
                    self.artillery_fire(cb, art, False, counter=True)
                    break

    # ------------------------------------------------------------ 准备阶段
    def prep_phase(self):
        self.phase = '准备阶段'
        for side in ('US', 'GE'):
            for _ in range(self.V['heal_per_turn']):
                cands = [u for u in self.units if u.on_map and u.side == side and u.damaged]
                if self.V['heal_needs_supply']:
                    net = self.supply_net(side)
                    z = self.ezoc(side)
                    cands = [u for u in cands if self.in_supply(u, net) and u.pos not in z]
                if cands:
                    u = max(cands, key=lambda u: (u.full[0] + u.full[1]))
                    z = self.ezoc(side)
                    if u.pos in z:
                        self.stats['整补:与敌接触中满血复原'] += 1
                    u.hp = u.max_hp
                    self.stats[f'整补:{side}'] += 1
                    self.log(f'整补 {u.name} 翻回正面')
        before = sum(1 for u in self.units if u.on_map and u.fatigue > 0)
        for u in self.units:
            if u.fatigue > 0 and not (self.V['fatigue_persist'] or self.V['fatigue_mild']):
                u.fatigue -= 1
            u.suppressed = False
            u.moved_prev = u.moved if u.side == 'GE' else False
            u.moved = u.attacked = False
        self.hq_left = {}
        self.stats['准备阶段清除的疲劳标记'] += before
        self.fuel_crisis = self.d6() == 1
        if self.fuel_crisis:
            self.stats['燃油危机'] += 1
            self.log('德军燃油危机：所有装甲单位MP减半')
        if self.turn <= 3:
            self.weather = 'snow'
        else:
            self.weather = 'clear' if self.d6() <= 4 else 'snow'
        self.log(f'天气：{"晴朗" if self.weather == "clear" else "浓雾/暴雪"}')
        for side in ('US', 'GE'):
            net = self.supply_net(side)
            for u in self.combat_units(side):
                if not self.in_supply(u, net):
                    self.stats[f'断补:{side}'] += 1
                    if self.turn == 1:
                        self.stats[f'开局即断补:{side}'] += 1
                    if self.V['supply_bites'] and not (self.turn == 1 and self.V.get('supply_t1_free')):
                        self.set_fatigue(u, 1)
                        self.log(f'{u.name} 断补')

    # ------------------------------------------------------------ 空袭
    def air_phase(self):
        self.phase = '空袭阶段'
        if self.weather != 'clear' or self.turn < 4:
            return
        tg = [u for u in self.combat_units('GE')]
        if not tg:
            return
        def val(u):
            return (u.uid in ('GPz1', 'GPz12'), 'mech' == u.kind or 'armor' == u.kind, -u.pos[0], u.A)
        t = max(tg, key=val)
        r = self.d6()
        flak = self.by_id['GFlak']
        if flak.on_map and dist(flak.pos, t.pos) <= 1:
            fr = self.d6()
            if self.V['flak_fix']:
                if fr >= 5:
                    r -= 2
                    self.stats['高炮生效'] += 1
            elif fr <= 2:
                r -= fr
                self.stats['高炮生效'] += 1
        self.stats['空袭'] += 1
        if r >= 4:
            self.log(f'P-47 空袭 {t}: 骰{r} -> 1点损伤')
            self.stats['空袭命中'] += 1
            self.damage(t, 1, 'P-47')
        elif r >= 1:
            self.log(f'P-47 空袭 {t}: 骰{r} -> 压制')
            t.suppressed = True
        else:
            self.log(f'P-47 空袭 {t}: 被高炮抵消')

    # ------------------------------------------------------------ 胜利点
    def score(self):
        ctrl = {}
        for name in OBJECTIVES:
            o = self.occupant(TOWNS[name])
            ctrl[name] = o.side if o else None
        if self.V['control_markers']:
            self.update_control()
            ctrl = dict(self.ctrl)
        gvp = avp = 0.0
        gvp += self.V['exit_vp'] * len(self.exits)
        for name, v in OBJECTIVES.items():
            if ctrl[name] == 'GE':
                gvp += v
            elif ctrl[name] == 'US':
                avp += v
        cat = self.V['vp_categories']
        for u in self.losses['US']:
            if u.kind == 'armor' or 'airborne' in u.tags or (cat and u.kind == 'hq'):
                gvp += 1
            elif u.kind in ('inf', 'eng', 'mech') or (cat and u.kind == 'art'):
                gvp += 0.5
        if not self.exits:
            avp += self.V['noexit_avp']
        ge_loss = 0.0
        for u in self.losses['GE']:
            if u.kind == 'armor' or 'SS' in u.tags or (cat and u.kind == 'hq'):
                ge_loss += 1
            elif u.kind != 'hq':
                ge_loss += 0.5
        weather_bonus = ctrl['StVith'] != 'GE' and ctrl['Bastogne'] != 'GE'
        avp_fixed = avp + ge_loss + (1 if weather_bonus else 0)
        gvp_literal = gvp + ge_loss       # 字面：“每消灭一个德军装甲或SS单位：获得1 GVP”
        avp_literal = avp + (1 if weather_bonus else 0)
        return dict(gvp=gvp, avp=avp_fixed, gvp_literal=gvp_literal, avp_literal=avp_literal,
                    ctrl=ctrl, exits=len(self.exits), us_lost=len(self.losses['US']),
                    ge_lost=len([u for u in self.losses['GE'] if u.kind != 'hq']))

    # ------------------------------------------------------------ AI 公用
    def next_waypoint(self, u):
        if not u.route:
            return None
        while u.route and u.route[0] != 'EXIT' and (u.pos == u.route[0] or (dist(u.pos, u.route[0]) <= 0)):
            u.route.pop(0)
        if not u.route:
            return None
        return u.route[0] if u.route[0] != 'EXIT' else (0, u.pos[1])
