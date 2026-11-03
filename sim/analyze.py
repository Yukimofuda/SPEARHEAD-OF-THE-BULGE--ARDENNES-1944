# 修订版 vs 原规则：大批量对局 + 逐回合轨迹统计（多进程）
import sys, json, math, time
from collections import Counter, defaultdict
from multiprocessing import Pool
from play import Play
from engine import DRAFT
from hexmap import OBJECTIVES
from batch import outcome

VARIANTS = {
    'base': {},
    'draft': dict(DRAFT, fixed_tie=True),
    'draft_usaggr': dict(DRAFT, fixed_tie=True, us_thr=0),
    'draft_gesmart': dict(DRAFT, fixed_tie=True, ge_thr=0),       # 德军AI避开负值栏风险
    'draft_gesmart_usaggr': dict(DRAFT, fixed_tie=True, ge_thr=0, us_thr=0),
    'base_gesmart': dict(ge_thr=0),
    'draft_gesmart_t1free': dict(DRAFT, fixed_tie=True, ge_thr=0, supply_t1_free=True),  # 第1回合不做断补
}


class Rec(Play):
    def snapshot(self):
        super().snapshot()
        sc = self.score()
        self.traj.append((sc['avp'] - sc['gvp'], dict(sc['ctrl']), sc['exits']))


def one(args):
    name, seed = args
    v = VARIANTS[name]
    g = Rec(seed=seed, variant=dict(v) if v else None)
    g.traj = []
    sc = g.run()
    ft = bool(v.get('fixed_tie'))
    d = sc['avp'] - sc['gvp']
    return dict(name=name, seed=seed, diff=d, gvp=sc['gvp'], avp=sc['avp'],
                out=outcome(sc['gvp'], sc['avp'], ft),
                out_lit=outcome(sc['gvp_literal'], sc['avp_literal']),
                out_t7=outcome(0, g.traj[6][0], ft) if len(g.traj) >= 7 else None,
                traj=[t[0] for t in g.traj], ctrl_traj=[t[1] for t in g.traj],
                exits=sc['exits'], us_lost=sc['us_lost'], ge_lost=sc['ge_lost'],
                ctrl=sc['ctrl'], stats=dict(g.stats))


def side(o):
    return 'GE' if o.startswith('德') else 'US' if o.startswith('美') else 'tie' if o == '平局' else 'undef'


def ci(p, n):
    return 1.96 * math.sqrt(p * (1 - p) / n)


def report(name, rs):
    n = len(rs)
    print(f'\n===== {name}  n={n}')
    oc = Counter(r['out'] for r in rs)
    print('结果:', dict(oc.most_common()))
    sc = Counter(side(r['out']) for r in rs)
    for k in ('GE', 'US', 'tie', 'undef'):
        p = sc[k] / n
        print(f'  {k}: {p*100:.1f}% ±{ci(p, n)*100:.1f}')
    if name == 'base':
        lc = Counter(side(r['out_lit']) for r in rs)
        print('字面计分:', {k: f'{v/n*100:.1f}%' for k, v in lc.items()})
    ds = [r['diff'] for r in rs]
    m = sum(ds) / n; sd = math.sqrt(sum((x - m) ** 2 for x in ds) / n)
    print(f'分差(美-德) 均值 {m:+.2f}  标准差 {sd:.2f}')
    hist = Counter(max(-8, min(8, round(x))) for x in ds)
    print('分差分布:', ' '.join(f'{k:+d}:{hist[k]}' for k in range(-8, 9)))
    # 逐回合轨迹
    T = min(len(r['traj']) for r in rs)
    print('每回合末平均分差:', ' '.join(f'T{t+1}:{sum(r["traj"][t] for r in rs)/n:+.1f}' for t in range(T)))
    for obj in OBJECTIVES:
        print(f'  {obj} 德军控制率:', ' '.join(f'T{t+1}:{sum(1 for r in rs if r["ctrl_traj"][t][obj]=="GE")/n*100:.0f}%' for t in range(T)))
    # 末回合翻盘
    flip = sum(1 for r in rs if side(r['out_t7']) != side(r['out']))
    d8 = [abs(r['traj'][7] - r['traj'][6]) for r in rs]
    big = sum(1 for x in d8 if x >= 3)
    print(f'第8回合改变胜负归属: {flip/n*100:.1f}%   第8回合分差变动均值 {sum(d8)/n:.2f}，变动≥3分 {big/n*100:.1f}%')
    lead = sum(sum(1 for a, b in zip(r['traj'], r['traj'][1:]) if (a > 0) != (b > 0) and a != 0 and b != 0) for r in rs) / n
    print(f'领先方易位(每局平均): {lead:.2f}')
    print(f'脱离西缘: 有脱离的对局 {sum(1 for r in rs if r["exits"])/n*100:.1f}%  平均损失 美{sum(r["us_lost"] for r in rs)/n:.2f} 德{sum(r["ge_lost"] for r in rs)/n:.2f}  德军零损失 {sum(1 for r in rs if r["ge_lost"]==0)/n*100:.0f}%')
    st = Counter()
    for r in rs:
        st.update(r['stats'])
    atk = sum(v for k, v in st.items() if k.startswith('CRT:') or k == '优势差<0(规则无结果)')
    pen = st['负值栏:攻方R1'] + st['负值栏:攻方D1']
    dmg = sum(v for k, v in st.items() if k.startswith('CRT:D'))
    print(f'进攻 每局{atk/n:.1f}次: 守方受伤 {dmg/atk*100:.0f}%  攻方受罚(负值栏) {pen/atk*100:.0f}%  F/无结果 {(st["CRT:F"]+st["优势差<0(规则无结果)"]-pen)/atk*100:.0f}%')
    print(f'整补 美{st["整补:US"]/n:.2f} 德{st["整补:GE"]/n:.2f}  空袭命中 {st["空袭命中"]/n:.2f}  控制权易手 {st["控制权易手"]/n:.2f}  推进占领 {st["战斗后推进占领要点"]/n:.2f}')
    return dict(name=name, n=n, oc=dict(oc), mean=m, sd=sd)


if __name__ == '__main__':
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
    names = sys.argv[2].split(',') if len(sys.argv) > 2 else list(VARIANTS)
    t = time.time()
    jobs = [(nm, s) for nm in names for s in range(2000, 2000 + n)]
    with Pool(8) as p:
        out = p.map(one, jobs, chunksize=10)
    by = defaultdict(list)
    for r in out:
        by[r['name']].append(r)
    print(f'{len(out)} 局 用时 {time.time()-t:.0f}s')
    for nm in names:
        report(nm, by[nm])
    json.dump(out, open(f'res/analyze_{n}_{"-".join(names)}.json', 'w'), ensure_ascii=False)
