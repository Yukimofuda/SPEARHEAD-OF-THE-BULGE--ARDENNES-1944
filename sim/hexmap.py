# 测试用简化地图（规则书只给了圣维特附近的局部地图，这里按真实地理示意搭建）
# odd-q 平顶六角格：x 为列（0=西缘/默兹河方向，35=东缘/德军出发区），y 为行（0=北）
import random

W, H = 36, 28

def to_axial(x, y):
    return x, y - (x - (x & 1)) // 2

def from_axial(q, r):
    return q, r + (q - (q & 1)) // 2

AX_DIRS = [(0, -1), (1, -1), (1, 0), (0, 1), (-1, 1), (-1, 0)]  # 12点方向起顺时针

def neighbors(h):
    q, r = to_axial(*h)
    out = []
    for dq, dr in AX_DIRS:
        x, y = from_axial(q + dq, r + dr)
        if 0 <= x < W and 0 <= y < H:
            out.append((x, y))
    return out

def neighbor_in_dir(h, d):
    q, r = to_axial(*h)
    dq, dr = AX_DIRS[d]
    return from_axial(q + dq, r + dr)

def dist(a, b):
    aq, ar = to_axial(*a)
    bq, br = to_axial(*b)
    return (abs(aq - bq) + abs(ar - br) + abs(aq + ar - bq - br)) // 2

def hex_line(a, b):
    n = dist(a, b)
    aq, ar = to_axial(*a)
    bq, br = to_axial(*b)
    out = []
    for i in range(n + 1):
        t = i / max(n, 1)
        q = aq + (bq - aq) * t + 1e-6
        r = ar + (br - ar) * t + 1e-6
        s = -q - r
        rq, rr, rs = round(q), round(r), round(s)
        dq, dr, ds = abs(rq - q), abs(rr - r), abs(rs - s)
        if dq > dr and dq > ds:
            rq = -rr - rs
        elif dr > ds:
            rr = -rq - rs
        out.append(from_axial(rq, rr))
    return out

TOWNS = {
    'Malmedy': (22, 3), 'StVith': (24, 10), 'Bastogne': (12, 22), 'Clervaux': (25, 20),
    'Houffalize': (15, 15), 'Stavelot': (17, 4), 'Werbomont': (10, 6), 'Wiltz': (21, 24),
    'Losheim': (29, 7), 'Bullingen': (25, 6), 'Ligneuville': (20, 5), 'Vielsalm': (19, 11),
    'Schonberg': (27, 11), 'Dasburg': (29, 19),
}
OBJECTIVES = {'Bastogne': 3, 'StVith': 2, 'Malmedy': 1}

ROADS = [
    [(35, 6), (29, 7), (25, 6), (20, 5), (17, 4), (10, 6), (0, 8)],   # 派普路线
    [(25, 6), (22, 3), (17, 4)],                                      # 马尔梅迪
    [(22, 3), (24, 10)],                                              # 马尔梅迪-圣维特
    [(35, 11), (27, 11), (24, 10), (19, 11), (15, 15), (12, 22)],     # 圣维特-乌法利兹-巴斯托涅
    [(29, 7), (27, 11)],
    [(15, 15), (7, 14), (0, 14)],                                     # 乌法利兹向西
    [(10, 6), (15, 15)],
    [(35, 19), (29, 19), (25, 20), (12, 22)],                         # 克莱沃-巴斯托涅
    [(12, 22), (0, 20)],                                              # 巴斯托涅向西
    [(35, 25), (21, 24), (12, 22)],                                   # 维尔茨
    [(25, 20), (24, 10)],
]

# 河流按“列边界 + 行范围”定义，跨越的相邻格之间即为河流格边
RIVERS = [('Our', 27, range(8, 28)), ('Ambleve', 18, range(0, 9))]


class Map:
    def __init__(self, seed=1944):
        rng = random.Random(seed)
        self.terrain = {}
        for x in range(W):
            for y in range(H):
                r = rng.random()
                self.terrain[(x, y)] = 'forest' if r < 0.48 else ('hill' if r < 0.66 else 'clear')
        # 一次平滑，让森林成片
        t2 = {}
        for h, t in self.terrain.items():
            ns = [self.terrain[n] for n in neighbors(h)]
            fc = ns.count('forest')
            t2[h] = 'forest' if fc >= 4 else ('clear' if fc <= 1 and t == 'forest' else t)
        self.terrain = t2
        for name, h in TOWNS.items():
            self.terrain[h] = 'town'
        self.road_edges = set()
        self.road_hexes = set()
        for path in ROADS:
            for a, b in zip(path, path[1:]):
                line = hex_line(a, b)
                for p, q in zip(line, line[1:]):
                    self.road_edges.add(frozenset((p, q)))
                    self.road_hexes.update((p, q))
        self.river_edges = set()
        for _, col, rows in RIVERS:
            for y in rows:
                a = (col, y)
                for n in neighbors(a):
                    if n[0] == col + 1 and n[1] in rows:
                        self.river_edges.add(frozenset((a, n)))
        self.bridges = {e for e in self.river_edges if e in self.road_edges}
        self.blown = set()
        self.pontoons = set()
        self.forts = set()

    def crosses_river(self, a, b):
        return frozenset((a, b)) in self.river_edges

    def ascii(self, units=None):
        ch = {'clear': '.', 'forest': 'f', 'hill': '^', 'town': 'T'}
        rows = []
        for y in range(H):
            line = ''
            for x in range(W):
                c = ch[self.terrain[(x, y)]]
                if (x, y) in self.road_hexes and c != 'T':
                    c = '=' if c == '.' else c.upper() if c != '^' else '#'
                if units and (x, y) in units:
                    c = units[(x, y)]
                line += c
            rows.append(f'{y:2d} {line}')
        return '\n'.join(rows)


if __name__ == '__main__':
    m = Map()
    print(m.ascii())
    print('bridges', len(m.bridges), sorted(tuple(sorted(e)) for e in m.bridges))
    from collections import Counter
    print(Counter(m.terrain.values()))
