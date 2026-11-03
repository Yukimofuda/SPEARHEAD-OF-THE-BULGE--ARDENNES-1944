# 双方作战计划（我作为两边玩家的决策）+ 回合主循环
import sys
import copy
from collections import Counter

from engine import Game
from hexmap import TOWNS, OBJECTIVES, neighbors, dist, neighbor_in_dir, W, H

PEIPER_ROUTE = ['EXIT']
WEST_EDGE = [(0, y) for y in range(H)]
SS12_ROUTE = [(24, 10), 'EXIT']
SOUTH_ROUTE = [(25, 20), 'EXIT']

US_SETUP = {'US393': (28, 5), 'US9': (26, 3), 'USM10': (27, 8), 'US422': (27, 13),
            'US110': (25, 20), 'US37': (24, 10), 'US1104': (18, 5), 'US552': (23, 10),
            'US504': (12, 22)}
# 美军阵地计划：{回合起: 目标格}
US_POSTS = {
    'US393': {2: (20, 5)},            # 撤到利涅维尔堵派普路线
    'US9': {2: (22, 3)},              # 撤守马尔梅迪
    'USM10': {2: (25, 9)},            # 圣维特北侧
    'US422': {2: (25, 11)},           # 圣维特东侧
    'US110': {1: (25, 20), 4: (13, 21)},
    'US37': {1: (24, 10)},
    'US1104': {1: (18, 5)},
    'US552': {1: (23, 10), 4: (21, 11)},
    'US504': {1: (12, 22)},
    'US32': {4: (12, 5)},             # 北路：在韦尔博蒙以东堵派普
    'US508': {4: (14, 5)},
    'US27': {4: (19, 11)},            # 中路：维尔萨姆
    'USCCB': {4: (20, 10)},
    'US155': {4: (16, 13)},
    'US501': {4: (13, 22)},           # 南路：巴斯托涅
    'US41': {4: (13, 20)},
    'US8C': {4: (16, 20)},
}
US_ENTRY = {'US32': (0, 8), 'US508': (0, 8), 'US27': (0, 14), 'USCCB': (0, 14), 'US155': (0, 14),
            'US501': (0, 20), 'US41': (0, 20), 'US8C': (0, 20)}

GE_SETUP = {'GPz1': (31, 7), 'GPg1': (32, 6), 'GPg2': (32, 7), 'GArt1': (33, 6), 'GFlak': (33, 7),
            'GGr751': (31, 2), 'GGr989': (31, 4), 'GPi277': (32, 4), 'GGr48': (30, 5), 'GGr27': (30, 8),
            'GJg12': (31, 9), 'GPz12': (31, 11), 'GPg25': (30, 10), 'GPg26': (30, 12), 'GArt12': (32, 10),
            'GWerf': (32, 11), 'GPg8': (30, 19), 'G150': (24, 8)}
GE_ROUTES = {
    'GPz1': PEIPER_ROUTE, 'GPg1': PEIPER_ROUTE, 'GPg2': PEIPER_ROUTE,
    'GArt1': [(20, 5), (17, 4), (10, 6)], 'GFlak': [(20, 5), (17, 4), (10, 6)],
    'GPz12': SS12_ROUTE, 'GPg25': SS12_ROUTE, 'GPg26': SS12_ROUTE,
    'GArt12': [(27, 11), (24, 10), (19, 11)], 'GWerf': [(27, 11), (24, 10), (19, 11)],
    'GGr48': [(26, 7), (24, 8), (24, 10), (22, 3)], 'GGr27': [(27, 9), (25, 9), (24, 10)],
    'GJg12': [(27, 9), (24, 10)],
    'GGr989': [(27, 4), (22, 3)], 'GGr751': [(27, 2), (22, 3)],
    'GPi277': [(27, 5), (25, 6), (20, 5), (19, 5)],
    'GPg8': SOUTH_ROUTE,
    'G150': [(24, 10), (19, 11)],
    'GFj5': [(22, 3)], 'GFj9': [(22, 3)],
}
FSCH_TARGET = (22, 3)   # 伞兵空投选格：马尔梅迪


class Play(Game):
    # ---------------------------------------------------------------- 部署
    def setup(self):
        self.phase = '部署'
        self.posts = copy.deepcopy(US_POSTS)
        for uid, h in US_SETUP.items():
            self.by_id[uid].pos = h
        for u in self.units:
            if 'reinf' in u.tags:
                u.entered = False
        for uid, h in GE_SETUP.items():
            u = self.by_id[uid]
            u.pos = h
        for uid in GE_ROUTES:
            self.by_id[uid].route = list(GE_ROUTES[uid])
        self.by_id['G150'].disguised = True
        hq = self.by_id['GHQ1']; hq.follow = 'GPz1'; hq.pos = self.by_id['GPz1'].pos
        hq = self.by_id['GHQ12']; hq.follow = 'GPz12'; hq.pos = self.by_id['GPz12'].pos
        self.by_id['USHQ'].follow = 'USCCB'
        # 冯·德·海德伞兵：选格 -> 方向骰 -> 距离骰-1 -> 翻面骰
        for uid in ('GFj5', 'GFj9'):
            u = self.by_id[uid]
            d = self.d6() - 1
            n = self.d6() - 1
            fix = self.V.get('fsch_fix')
            h = FSCH_TARGET if not fix else (23, 4)
            off = False
            for _ in range(n):
                nh = neighbor_in_dir(h, d)
                if not (0 <= nh[0] < W and 0 <= nh[1] < H):
                    off = True
                    break
                h = nh
            flip = self.d6() <= 4
            bad_town = fix and self.terrain(h) == 'town'
            if off or self.occupant(h) or bad_town:
                self.stats['空投落点非法(规则未定义)'] += 1
                if fix:
                    flip = True   # 修订：非法落点一律翻面
                free = sorted((x for x in [(a, b) for a in range(W) for b in range(H)]
                               if not self.occupant(x) and not (fix and self.terrain(x) == 'town')),
                              key=lambda x: dist(x, h))
                h = free[0]
            u.pos = h
            if flip:
                u.hp = 1
            self.log(f'{u.name} 空投 方向{d} 距离{n} -> {h} {"翻面" if flip else "正面"} 地形{self.terrain(h)}')

    # ---------------------------------------------------------------- 通用移动决策
    def best_dest(self, u, target, avoid_enemy=False):
        r = self.reachable(u)
        if not r:
            return u.pos
        z = self.ezoc(u.side)
        def key(h):
            k = dist(h, target)
            pen = 0
            if avoid_enemy and h in z:
                pen = 3
            return (k + pen, r[h])
        return min(r, key=key)

    def us_post(self, u):
        p = self.posts.get(u.uid)
        if not p:
            return None
        cur = None
        for t in sorted(p):
            if t <= self.turn:
                cur = p[t]
        return cur

    # ---------------------------------------------------------------- 美军行动阶段
    def us_phase(self):
        self.phase = '美军行动'
        self.attacked_targets.clear()
        if self.turn == 1:
            self.engineer_us()
            self.end_action_phase('US')
            return
        # 增援进场
        if self.turn >= 4:
            for u in self.units:
                if u.side == 'US' and not u.entered and u.kind != 'hq':
                    eh = US_ENTRY[u.uid]
                    if self.occupant(eh):
                        alt = [n for n in neighbors(eh) if n[0] == 0 and not self.occupant(n)]
                        if not alt:
                            continue
                        eh = alt[0]
                    u.entered = True
                    u.pos = eh
                    self.log(f'增援 {u.name} 于 {eh} 进场')
                    self.us_move(u)
                    if u.uid == 'USCCB':
                        hq = self.by_id['USHQ']; hq.entered = True; hq.pos = u.pos
        for u in sorted(self.combat_units('US'), key=lambda u: -u.pos[0]):
            if u.moved or u.suppressed:
                continue
            self.us_move(u)
        self.us_combat()
        self.engineer_us()
        self.end_action_phase('US')

    def us_move(self, u):
        post = self.us_post(u)
        if any(u.pos == TOWNS[n] for n in OBJECTIVES):
            return   # 守备要点的单位不离开
        if 'reinf' in u.tags or u.kind == 'armor':
            post = self.reserve_override(u) or post
        if post is None or u.pos == post:
            return
        occ = self.occupant(post)
        if occ and occ.side == 'US' and occ is not u:
            frees = [n for n in neighbors(post) if not self.occupant(n)]
            if not frees:
                return
            post = min(frees, key=lambda n: dist(n, u.pos))
        r = self.reachable(u)
        pd = self.path_dist(u, post)
        dest = min(r, key=lambda h: (pd.get(h, 999), r[h]))
        self.move_unit(u, dest, f'(前往阵地{post})')
        hq = self.by_id['USHQ']
        if getattr(hq, 'follow', None) == u.uid and hq.entered:
            hq.pos = u.pos

    def reserve_override(self, u):
        """机动预备队：若有德军装甲/机步距西缘<=8格，去堵它前方道路；德军占据要点则去夺回"""
        ge = [g for g in self.combat_units('GE') if g.kind in ('armor', 'mech')]
        threats = [g for g in ge if g.pos[0] <= 10]
        if threats:
            g = min(threats, key=lambda g: g.pos[0])
            tgt = (max(0, g.pos[0] - 2), g.pos[1])
            mobile = [x for x in self.combat_units('US') if x.kind in ('armor', 'mech', 'inf') and
                      not any(x.pos == TOWNS[n] for n in OBJECTIVES)]
            mobile.sort(key=lambda x: dist(x.pos, g.pos))
            if u in mobile[:3]:
                return tgt
        for name in OBJECTIVES:
            o = self.occupant(TOWNS[name])
            if o and o.side == 'GE' and dist(u.pos, TOWNS[name]) <= 6:
                return TOWNS[name]
        return None

    def us_combat(self):
        for u in sorted(self.combat_units('US'), key=lambda u: -u.A):
            if u.kind == 'art' or u.fatigue > 0 or u.suppressed or u.attacked:
                continue
            tg = [self.occupant(n) for n in neighbors(u.pos)]
            tg = [t for t in tg if t and t.side == 'GE' and not t.disguised]
            if not tg:
                continue
            best = max(tg, key=lambda t: (self.expected_diff(u, t), t.damaged))
            e = self.expected_diff(u, best)
            in_obj = any(best.pos == TOWNS[n] for n in OBJECTIVES)
            thr = self.V.get('us_thr', 2)
            if e >= thr or (best.damaged and e >= thr - 1) or (in_obj and e >= thr - 2):
                if 'quick' in best.tags and best.fatigue == 0 and not self.V['quick_limited']:
                    if self.quick_react(best):
                        continue
                self.resolve_combat(u, best)

    def quick_react(self, g):
        # 3装掷师8团“快速反应”：美军阶段任意时间用1MP移动1格——可在被宣布攻击时闪避
        z = self.ezoc('GE')
        opts = [n for n in neighbors(g.pos) if not self.occupant(n) and n not in z and self.step_cost(g, g.pos, n) is not None]
        if opts:
            self.stats['快速反应闪避攻击'] += 1
            self.move_unit(g, max(opts, key=lambda n: n[0]), '(快速反应闪避)')
            return True
        return False

    def engineer_us(self):
        e = self.by_id['US1104']
        if not e.on_map or e.attacked:
            return
        for br in self.map.bridges - self.map.blown:
            if e.pos in br:
                far = [h for h in br if h != e.pos][0]
                if any(dist(g.pos, far) <= 6 for g in self.combat_units('GE')):
                    if self.V['engineer_fix']:
                        if e.moved:
                            return
                        if self.d6() < 4:
                            self.stats['炸桥失败'] += 1
                            return
                    self.map.blown.add(br)
                    self.stats['美军炸桥'] += 1
                    self.log(f'{e.name} 炸毁桥梁 {tuple(br)}（规则未规定炸桥的MP消耗/位置要求）')
                    # 下一座桥
                    others = [b for b in self.map.bridges - self.map.blown if any(h[0] == 18 for h in b)]
                    if others:
                        self.posts['US1104'][self.turn + 1] = [h for h in others[0] if h[0] == 18][0]
                    return
        if not e.moved and e.pos not in self.map.forts:
            self.map.forts.add(e.pos)
            self.stats['美军构筑工事'] += 1
            self.log(f'{e.name} 在 {e.pos} 构筑工事')

    # ---------------------------------------------------------------- 德军行动阶段
    def ge_phase(self):
        self.phase = '德军行动'
        self.attacked_targets.clear()
        pi = self.by_id['GPi277']
        repairing = False
        if pi.on_map and not pi.suppressed:
            for br in self.map.blown:
                if pi.pos in br:
                    repairing = True
        order = sorted(self.combat_units('GE'), key=lambda u: u.pos[0])
        for u in order:
            if u.suppressed or (u is pi and repairing):
                continue
            if u.kind == 'art' and self.art_targets(u) and 'mobile_art' not in u.tags:
                continue   # 有目标就不动（推定：非自行火炮移动后不能射击）
            self.ge_move(u)
        self.ge_combat()
        if repairing and not pi.attacked:
            br = [b for b in self.map.blown if pi.pos in b][0]
            self.map.blown.discard(br)
            self.stats['德军修桥'] += 1
            self.log(f'{pi.name} 修复桥梁 {tuple(br)}')

    def ge_move(self, u):
        if not u.route:
            return
        for name in OBJECTIVES:          # 占据要点的单位就地守备
            if u.pos == TOWNS[name]:
                return
        while u.route and u.route[0] != 'EXIT':
            wp = u.route[0]
            occ = self.occupant(wp)
            if u.pos == wp or (dist(u.pos, wp) <= 1 and occ and occ.side == 'GE'):
                u.route.pop(0)
                continue
            break
        if not u.route:
            return
        r = self.reachable(u)
        if u.uid == 'GPi277' and self.map.blown:
            br = min(self.map.blown, key=lambda b: min(dist(h, u.pos) for h in b))
            targets = max(br, key=lambda h: h[0])
        elif u.route[0] == 'EXIT':
            exits = [h for h, c in r.items() if h[0] == 0 and c <= self.effective_mp(u) - 0.5]
            if u.pos[0] == 0 or exits:
                self.log(f'{u} 从西缘脱离！')
                u.exited = True
                self.exits.append(u)
                return
            targets = WEST_EDGE
        else:
            targets = u.route[0]
        pd = self.path_dist(u, targets)
        dest = min(r, key=lambda h: (pd.get(h, 999), r[h]))
        self.move_unit(u, dest)

    def ge_combat(self):
        attackers = [u for u in self.combat_units('GE') if u.kind != 'art']
        attackers.sort(key=lambda u: (u.uid != 'GPz1', -u.A))
        for u in attackers:
            if not u.alive or u.fatigue > 0 or u.suppressed or u.attacked:
                continue
            if u.disguised and self.turn <= 2:
                # 伪装单位：只在能打出好结果时才暴露
                pass
            tg = [self.occupant(n) for n in neighbors(u.pos)]
            tg = [t for t in tg if t and t.side == 'US']
            if not tg:
                continue
            wp = self.next_waypoint(u) or u.pos
            best = max(tg, key=lambda t: (t.pos == wp, any(t.pos == TOWNS[n] for n in OBJECTIVES), self.expected_diff(u, t)))
            thr = self.V.get('ge_thr', 0 if self.V['attacker_risk'] else -2)
            if self.expected_diff(u, best) >= thr:
                self.resolve_combat(u, best)

    # ---------------------------------------------------------------- 主循环
    def run(self):
        self.setup()
        for t in range(1, 9):
            self.turn = t
            self.prep_phase()
            self.air_phase()
            self.us_phase()
            if self.V['control_markers']:
                self.update_control()
            self.ge_phase()
            self.end_action_phase('GE')
            if self.V['control_markers']:
                self.update_control()
            self.artillery_phase()
            if self.V['control_markers']:
                self.update_control()
            self.phase = '结算'
            self.snapshot()
        return self.score()

    def snapshot(self):
        sc = self.score()
        self.log(f'回合结束：要点 {sc["ctrl"]}  脱离{sc["exits"]}  美损{sc["us_lost"]} 德损{sc["ge_lost"]}  GVP{sc["gvp"]} AVP{sc["avp"]}')

    def board(self):
        marks = {}
        for u in self.units:
            if u.on_map and u.kind != 'hq':
                marks[u.pos] = ('U' if u.side == 'US' else 'G') if not u.damaged else ('u' if u.side == 'US' else 'g')
        return self.map.ascii(marks)


if __name__ == '__main__':
    seed = int(sys.argv[1]) if len(sys.argv) > 1 else 7
    g = Play(seed=seed, verbose=True)
    res = g.run()
    print(res)
    print(g.board())
    print(dict(g.stats))
