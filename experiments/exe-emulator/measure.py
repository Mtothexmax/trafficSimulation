"""Runs the emulated controller, shows where the time goes and compares every reply with a
recording of the real exe (made by record_real.py).

usage:  python measure.py <exe> <supply1> <supply2> <seconds> [<recording.json> [extra files...]]
"""
import sys, time, json
import emu as E
import scenario

exe, s1, s2, seconds = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
ref = json.load(open(sys.argv[5])) if len(sys.argv) > 5 else None
t0 = time.time()
em, record, timing = E.run(exe, [s1, s2] + sys.argv[6:], seconds, quiet=True, clock=ref['started'] if ref else None)
print('simulated %d s in %.1f s (start %.2f s, DateiLesen+Init %.1f s, %.1f ms per control step)' % (seconds, time.time() - t0, timing['start'], timing['init'], timing['per_step'] * 1000))
print('imports: %d of %d used, %d calls; not implemented but called: %s' % (len(em.calls), len(em.stub_of), sum(em.calls.values()), sorted(em.missing) or 'none'))
for name, n in sorted(em.calls.items(), key=lambda x: -x[1])[:8]:
    print('  %-28s %9d' % (name, n))
for line in em.log[:10]:
    print('log:', line)
pictures = sum(len(scenario.wanted(r)) for r in record)
print('signal pictures asked for: %d, values in all replies: %d' % (pictures, sum(len(r) for r in record)))
if ref:
    real = ref['record'][:seconds]
    same = sum(1 for a, b in zip(real, record) if a == b)
    print('compared with the real exe: %d of %d replies identical' % (same, len(record)))
    for sec, (a, b) in enumerate(zip(real, record), 1):
        if a != b:
            diff = [(x, y) for x, y in zip(a, b) if x != y][:4]
            print('  first difference at t=%d: %d vs %d values; real/emulated: %s' % (sec, len(a), len(b), diff))
            break
