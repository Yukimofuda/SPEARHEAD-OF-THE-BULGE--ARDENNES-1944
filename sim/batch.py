# 批量对局：统计结果分布与规则触发频率
import sys, json, time
from collections import Counter
from play import Play

def outcome(g, a, fixed_tie=False):
    d = a - g
    if fixed_tie:
        if abs(d) < 1: return '平局'
        if d >= 5: return '美军大胜'
        if d > 0: return '美军小胜'
        if d <= -5: return '德军大胜'
        return '德军小胜'
    if d >= 5: return '美军大胜'
    if d >= 1: return '美军小胜'
    if d == 0: return '平局'
    if d <= -5: return '德军大胜'
    if d <= -1: return '德军小胜'
    return '无法判定(差0.5)'

def run(n, variant=None, seed0=1000):
    res = Counter(); lit = Counter(); st = Counter(); agg = Counter()
    for s in range(seed0, seed0 + n):
        g = Play(seed=s, variant=variant)
        sc = g.run()
        res[outcome(sc['gvp'], sc['avp'], fixed_tie=bool(variant and variant.get('fixed_tie')))] += 1
        lit[outcome(sc['gvp_literal'], sc['avp_literal'])] += 1
        st.update(g.stats)
        agg['exits'] += sc['exits']; agg['us_lost'] += sc['us_lost']; agg['ge_lost'] += sc['ge_lost']
        agg['gvp'] += sc['gvp']; agg['avp'] += sc['avp']
        for k, v in sc['ctrl'].items():
            agg[f'{k}:{v}'] += 1
        if sc['exits']: agg['games_with_exit'] += 1
        if sc['ge_lost'] == 0: agg['games_ge_lost0'] += 1
    return res, lit, st, agg

if __name__ == '__main__':
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    var = json.loads(sys.argv[2]) if len(sys.argv) > 2 else None
    if var and var.pop('DRAFT', False):
        from engine import DRAFT
        var = dict(DRAFT, fixed_tie=True, **var)
    t = time.time()
    res, lit, st, agg = run(n, var)
    print('variant', var, 'n', n, f'{time.time()-t:.0f}s')
    print('修正版计分(德军损失计入AVP):', dict(res))
    print('字面计分(德军损失计入GVP):', dict(lit))
    print('平均:', {k: round(v / n, 2) for k, v in agg.items()})
    print('规则触发(每局平均):', {k: round(v / n, 2) for k, v in sorted(st.items(), key=lambda x: -x[1])})
