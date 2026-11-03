# 单位数据：按规则书算子页（正面/反面 A-D-MP-R）录入
# kind: inf 步兵 / eng 工兵 / mech 机械化步兵 / armor 装甲(含坦歼、侦察、高炮) / art 炮兵 / hq 指挥部
from dataclasses import dataclass, field


@dataclass
class Unit:
    uid: str
    name: str
    side: str            # 'US' / 'GE'
    full: tuple          # (A, D, MP, R)
    red: tuple
    kind: str
    tags: set = field(default_factory=set)
    cmp: int = 0
    hp: int = 2
    max_hp: int = 2
    pos: tuple = None
    alive: bool = True
    exited: bool = False
    fatigue: int = 0     # >0 表示疲劳；每个准备阶段 -1
    suppressed: bool = False
    moved: bool = False
    attacked: bool = False
    fired_once: bool = False   # M10 伏击用
    disguised: bool = False    # 150 装甲旅伪装
    entered: bool = True       # 增援是否已进场
    route: list = None
    post: dict = None

    @property
    def damaged(self):
        return self.hp < self.max_hp

    @property
    def stats(self):
        return self.red if self.damaged else self.full

    A = property(lambda s: s.stats[0])
    D = property(lambda s: s.stats[1])
    MP = property(lambda s: s.stats[2])
    R = property(lambda s: s.stats[3])

    @property
    def on_map(self):
        return self.alive and not self.exited and self.entered and self.pos is not None

    def __repr__(self):
        st = '损' if self.damaged else '完'
        return f'{self.name}[{st}]'


def make_units():
    U = []
    def add(*a, **k):
        U.append(Unit(*a, **k))
    # ---------------- 美军初始 ----------------
    add('US393', '美393团', 'US', (3, 4, 3, 1), (2, 3, 2, 1), 'inf', {'first_contact'})
    add('US422', '美422团', 'US', (3, 4, 3, 1), (2, 3, 2, 1), 'inf', {'green'})
    add('US9', '美9团', 'US', (4, 4, 3, 1), (3, 3, 2, 1), 'inf', {'veteran'})
    add('USM10', '美705坦歼营', 'US', (2, 5, 2, 3), (1, 4, 1, 3), 'armor', {'ambush', 'td'})
    add('US110', '美110团', 'US', (3, 5, 3, 1), (2, 4, 2, 1), 'inf')
    add('US1104', '美1104工兵营', 'US', (1, 3, 3, 1), (1, 2, 2, 1), 'eng')
    add('US504', '美504伞兵团', 'US', (4, 4, 3, 1), (3, 3, 2, 1), 'inf', {'airborne'})
    add('US37', '美37坦克营', 'US', (5, 4, 4, 2), (4, 3, 3, 2), 'armor')
    add('US552', '美552炮兵营', 'US', (2, 2, 3, 4), (0, 0, 2, 4), 'art')
    # ---------------- 美军第4回合增援 ----------------
    add('US32', '美3装甲师32团', 'US', (6, 5, 4, 2), (5, 4, 3, 2), 'armor', {'reinf', 'thunder'})
    add('US8C', '美8骑兵侦察营', 'US', (3, 4, 5, 2), (2, 3, 4, 2), 'armor', {'reinf', 'recon'})
    add('US501', '美501伞兵团', 'US', (4, 5, 3, 1), (3, 4, 2, 1), 'inf', {'reinf', 'airborne', 'nuts', 'tough'})
    add('US508', '美508伞兵团', 'US', (4, 5, 3, 1), (3, 4, 2, 1), 'inf', {'reinf', 'airborne', 'vs_vgd'})
    add('US27', '美27坦克营', 'US', (5, 4, 4, 2), (4, 3, 3, 2), 'armor', {'reinf'})
    add('US41', '美41装步团', 'US', (4, 4, 4, 2), (3, 3, 3, 2), 'mech', {'reinf', 'mechfire'})
    add('US155', '美155重炮群', 'US', (3, 2, 2, 4), (0, 0, 1, 4), 'art', {'reinf', 'heavy_art', 'counterbattery'})
    add('USCCB', '美1装甲师CCB', 'US', (6, 5, 4, 2), (5, 4, 3, 2), 'armor', {'reinf', 'ccb'})
    add('USHQ', '美军指挥部', 'US', (0, 0, 5, 2), (0, 0, 5, 2), 'hq', {'reinf'}, cmp=2)
    # ---------------- 德军：派普战斗群 ----------------
    add('GPz1', '派普SS1装甲团', 'GE', (7, 5, 4, 2), (6, 5, 3, 2), 'armor', {'SS', 'peiper', 'heavy', 'blitz'})
    add('GPg1', '派普SS1掷弹团', 'GE', (6, 5, 4, 1), (5, 4, 4, 1), 'mech', {'SS', 'peiper', 'combined'})
    add('GPg2', '派普SS2掷弹团', 'GE', (6, 5, 4, 1), (5, 4, 4, 1), 'mech', {'SS', 'peiper', 'combined'})
    add('GArt1', 'SS1炮兵团', 'GE', (3, 2, 3, 3), (2, 2, 2, 3), 'art', {'SS', 'peiper', 'mobile_art'})
    add('GHQ1', 'SS1师部', 'GE', (0, 0, 5, 2), (0, 0, 5, 2), 'hq', {'SS'}, cmp=2)
    add('GFlak', 'SS1高炮营', 'GE', (3, 3, 2, 2), (2, 2, 2, 2), 'armor', {'SS', 'flak'})
    # ---------------- 德军：SS12 ----------------
    add('GPz12', 'SS12装甲团', 'GE', (6, 5, 4, 2), (5, 4, 3, 2), 'armor', {'SS', '12ss', 'fanatic'})
    add('GPg25', 'SS25掷弹团', 'GE', (5, 4, 4, 1), (4, 4, 4, 1), 'mech', {'SS', '12ss', 'flank'})
    add('GPg26', 'SS26掷弹团', 'GE', (5, 4, 4, 1), (4, 4, 4, 1), 'mech', {'SS', '12ss', 'motor'})
    add('GArt12', 'SS12炮兵团', 'GE', (2, 1, 3, 3), (1, 0, 2, 3), 'art', {'SS', '12ss'})
    add('GHQ12', 'SS12师部', 'GE', (0, 0, 4, 2), (0, 0, 4, 2), 'hq', {'SS', '12ss'}, cmp=1)
    add('GWerf', 'SS12火箭营', 'GE', (5, 1, 3, 3), (3, 0, 2, 3), 'art', {'SS', '12ss', 'heavy_art', 'werfer'})
    # ---------------- 德军：国防军 ----------------
    add('GGr48', '48掷弹团', 'GE', (3, 4, 3, 1), (2, 3, 2, 1), 'inf', {'VGD', 'snow'})
    add('GGr27', '27掷弹团', 'GE', (3, 4, 3, 1), (2, 3, 2, 1), 'inf', {'VGD'})
    add('GPg8', '3装掷师8团', 'GE', (4, 4, 4, 1), (3, 3, 3, 1), 'mech', {'quick'})
    add('G150', '150装甲旅', 'GE', (3, 3, 4, 1), (2, 2, 3, 1), 'armor', {'disguise'})
    add('GGr751', '751掷弹团', 'GE', (3, 4, 3, 1), (2, 3, 2, 1), 'inf', {'VGD', 'human_wave'})
    add('GGr989', '989掷弹团', 'GE', (3, 4, 3, 1), (2, 3, 2, 1), 'inf', {'VGD', 'dig_in'})
    add('GPi277', '277工兵营', 'GE', (3, 4, 3, 1), (2, 3, 2, 1), 'eng', {'VGD', 'pioneer'})
    add('GJg12', '12坦歼营', 'GE', (3, 3, 2, 2), (2, 2, 1, 2), 'armor', {'VGD', 'hetzer'})
    add('GFj5', '伞兵5团', 'GE', (3, 3, 3, 1), (1, 2, 2, 1), 'inf', {'fsch', 'woods'})
    add('GFj9', '伞兵9团', 'GE', (3, 3, 3, 1), (1, 2, 2, 1), 'inf', {'fsch', 'anti_art'})
    return U
