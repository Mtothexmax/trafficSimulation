"""Runs the REAL controller exe (Windows, over DDE) with the scenario and records what it asks for.

usage:  python record_real.py <folder with exe and supply> <exe> <supply1> <supply2> <seconds> <out.json>

The folder is used as working directory – the exe writes files there, so pass a copy.
"""
import ctypes, json, struct, subprocess, sys, time, os
from ctypes import wintypes as w
import scenario

folder, exe, s1, s2, seconds, out_path = sys.argv[1:7]
seconds = int(seconds)
u = ctypes.WinDLL('user32')
HDATA = ctypes.c_void_p
CB = ctypes.WINFUNCTYPE(HDATA, w.UINT, w.UINT, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, HDATA, ctypes.c_size_t, ctypes.c_size_t)
u.DdeInitializeW.argtypes = [ctypes.POINTER(w.DWORD), CB, w.DWORD, w.DWORD]
u.DdeCreateStringHandleW.argtypes = [w.DWORD, w.LPCWSTR, ctypes.c_int]
u.DdeCreateStringHandleW.restype = ctypes.c_void_p
u.DdeConnect.argtypes = [w.DWORD, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
u.DdeConnect.restype = ctypes.c_void_p
u.DdeClientTransaction.argtypes = [ctypes.c_char_p, w.DWORD, ctypes.c_void_p, ctypes.c_void_p, w.UINT, w.UINT, w.DWORD, ctypes.POINTER(w.DWORD)]
u.DdeClientTransaction.restype = HDATA
u.DdeGetData.argtypes = [HDATA, ctypes.c_char_p, w.DWORD, w.DWORD]
u.DdeGetData.restype = w.DWORD
u.DdeFreeDataHandle.argtypes = [HDATA]
u.DdeDisconnect.argtypes = [ctypes.c_void_p]
u.DdeUninitialize.argtypes = [w.DWORD]

callback = CB(lambda *a: None)
inst = w.DWORD(0)
assert u.DdeInitializeW(ctypes.byref(inst), callback, 0x10, 0) == 0
hsz = lambda s: u.DdeCreateStringHandleW(inst, s, 1200)
started = int(time.time())
proc = subprocess.Popen([os.path.join(folder, exe), '1', '1', 'X', s1, s2], cwd=folder)
conv = None
try:
    for _ in range(60):
        time.sleep(0.25)
        conv = u.DdeConnect(inst, hsz('vsplus01'), hsz('VISSIM'), None)
        if conv or proc.poll() is not None:
            break
    assert conv, 'no DDE conversation'

    def poke(item, triples):
        data = b''.join(struct.pack('<3i', *t) for t in triples) + struct.pack('<i', 999)
        assert u.DdeClientTransaction(data, len(data), conv, hsz(item), 0x80, 0x4090, 20000, None), item

    def request(item):
        h = u.DdeClientTransaction(None, 0, conv, hsz(item), 0x80, 0x20B0, 20000, None)
        assert h, item
        n = u.DdeGetData(h, None, 0, 0)
        buf = ctypes.create_string_buffer(n)
        u.DdeGetData(h, buf, n, 0)
        u.DdeFreeDataHandle(h)
        raw, out, i = buf.raw, [], 0
        while i + 12 <= len(raw) and struct.unpack_from('<i', raw, i)[0] != 999:
            out.append(struct.unpack_from('<3i', raw, i))
            i += 12
        return out

    poke('DateiLesen', scenario.SETUP)
    poke('Init', scenario.SETUP)
    picture = {sg: 2 for sg in scenario.GROUPS}
    record = []
    for sec in range(1, seconds + 1):
        poke('Rechnen', scenario.step(sec, picture))
        reply = request('Wunschbild')
        for c, i, v in scenario.wanted(reply):
            picture[i] = v
        record.append([list(t) for t in reply])
    json.dump({'started': started, 'seconds': seconds, 'record': record}, open(out_path, 'w'))
    print('recorded %d seconds, %d values' % (seconds, sum(len(r) for r in record)))
finally:
    if conv:
        u.DdeDisconnect(conv)
    time.sleep(0.5)
    if proc.poll() is None:
        proc.terminate()
    u.DdeUninitialize(inst)
