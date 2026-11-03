#!/bin/zsh
cd "$(dirname "$0")"
N=300
python3 batch.py $N '{}' > res/base.txt 2>&1 &
python3 batch.py $N '{"us_thr": 0}' > res/us_aggr.txt 2>&1 &
python3 batch.py $N '{"fatigue_persist": true}' > res/fatigue.txt 2>&1 &
python3 batch.py $N '{"attacker_risk": true}' > res/risk.txt 2>&1 &
python3 batch.py $N '{"heal_needs_supply": true}' > res/heal.txt 2>&1 &
python3 batch.py $N '{"blitz_ignores_zoc": false}' > res/noblitz.txt 2>&1 &
python3 batch.py $N '{"supply_bites": true}' > res/supply.txt 2>&1 &
python3 batch.py $N '{"fatigue_persist": true, "attacker_risk": true, "heal_needs_supply": true, "blitz_ignores_zoc": false, "tough3": true}' > res/allfix.txt 2>&1 &
wait
