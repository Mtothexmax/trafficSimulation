"""The input both the real and the emulated controller get, so their answers can be compared."""

GROUPS = range(1, 12)
DETECTORS = range(1, 13)
CYCLE = 110

SETUP = [(1001, 0, CYCLE), (1011, 0, 1)] + [(2001, sg, 2) for sg in GROUPS]


def step(sec, picture):
    """Triples for control step `sec`: cycle second, program, actual signal pictures and a
    detector pattern: quiet for 150 s, then 150 s with every detector occupied now and
    then (staggered), and so on."""
    out = [(1002, 0, sec % CYCLE), (1011, 0, 1)]
    out += [(2001, sg, picture[sg]) for sg in GROUPS]
    for d in DETECTORS:
        occupied = 1 if (sec // 150) % 2 == 1 and ((sec + d * 17) % (30 + d * 3)) < 12 else 0
        out.append((3001, d, occupied))
    return out


def wanted(reply):
    """The signal pictures the controller asks for in its reply."""
    return [[c, i, v] for c, i, v in reply if c in (2002, 2003)]
