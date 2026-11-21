"""How much x86 code does the controller execute? (basis for estimating a browser emulator)"""
import os, sys
from unicorn import UC_HOOK_BLOCK
import emu as E
import scenario

exe, s1, s2 = sys.argv[1:4]
files = {os.path.basename(p): open(p, 'rb').read() for p in (s1, s2)}
em = E.Emulator(exe, files, '1 1 X ' + ' '.join(files))
count = [0, 0]  # blocks, bytes of code


def on_block(uc, address, size, user):
    count[0] += 1
    count[1] += size


em.uc.hook_add(UC_HOOK_BLOCK, on_block, begin=em.base, end=em.base + 0x200000)
AVG = 3.2  # bytes per x86 instruction, typical for this kind of code


def phase(name, fn):
    b, s, c = count[0], count[1], sum(em.calls.values())
    fn()
    print('%-22s %7.1f million instructions (approx.), %8d import calls' % (name, (count[1] - s) / AVG / 1e6, sum(em.calls.values()) - c))


phase('start', em.start)
phase('DateiLesen', lambda: em.poke('DateiLesen', scenario.SETUP))
phase('Init', lambda: em.poke('Init', scenario.SETUP))
picture = {sg: 2 for sg in scenario.GROUPS}


def steps(n, first):
    for sec in range(first, first + n):
        em.poke('Rechnen', scenario.step(sec, picture))
        for c, i, v in scenario.wanted(em.request('Wunschbild')):
            picture[i] = v


phase('20 control steps', lambda: steps(20, 1))
phase('20 more (t=100..119)', lambda: steps(20, 100))
