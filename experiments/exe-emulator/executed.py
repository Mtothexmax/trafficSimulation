"""Which x86 instructions does the controller really execute? (to size a purpose-built interpreter)"""
import os, sys, collections, json
from unicorn import UC_HOOK_BLOCK
from capstone import Cs, CS_ARCH_X86, CS_MODE_32
import emu as E
import scenario

exe, s1, s2, seconds, out = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]
files = {os.path.basename(p): open(p, 'rb').read() for p in (s1, s2)}
em = E.Emulator(exe, files, '1 1 X ' + ' '.join(files))
blocks = {}


def on_block(uc, address, size, user):
    if address not in blocks:
        blocks[address] = size


em.uc.hook_add(UC_HOOK_BLOCK, on_block, begin=em.base, end=em.base + 0x200000)
em.start()
em.poke('DateiLesen', scenario.SETUP)
em.poke('Init', scenario.SETUP)
picture = {sg: 2 for sg in scenario.GROUPS}
for sec in range(1, seconds + 1):
    em.poke('Rechnen', scenario.step(sec, picture))
    for c, i, v in scenario.wanted(em.request('Wunschbild')):
        picture[i] = v

md = Cs(CS_ARCH_X86, CS_MODE_32)
md.detail = True
mnemonics = collections.Counter()
forms = collections.Counter()
first_bytes = collections.Counter()
total = 0
for address, size in blocks.items():
    code = bytes(em.uc.mem_read(address, size))
    for ins in md.disasm(code, address):
        total += 1
        mnemonics[ins.mnemonic] += 1
        kinds = []
        for op in ins.operands:
            kinds.append({1: 'r', 2: 'i', 3: 'm'}.get(op.type, '?') + str(op.size * 8))
        forms[ins.mnemonic + ' ' + ','.join(kinds)] += 1
        b = bytes(ins.bytes)
        i = 0
        while b[i] in (0x66, 0x67, 0xF2, 0xF3, 0x2E, 0x36, 0x3E, 0x26, 0x64, 0x65, 0xF0):
            i += 1
        key = '%02x' % b[i] if b[i] != 0x0F else '0f %02x' % b[i + 1]
        if b[i] in (0x80, 0x81, 0x83, 0xC0, 0xC1, 0xD0, 0xD1, 0xD2, 0xD3, 0xF6, 0xF7, 0xFE, 0xFF, 0xC6, 0xC7, 0x8F) or 0xD8 <= b[i] <= 0xDF:
            key += ' /%d' % ((b[i + 1] >> 3) & 7)
            if 0xD8 <= b[i] <= 0xDF and b[i + 1] >= 0xC0:
                key = '%02x %02x' % (b[i], b[i + 1])
        first_bytes[key + (' p66' if 0x66 in b[:i] else '') + (' rep' if (0xF3 in b[:i] or 0xF2 in b[:i]) else '') + (' fs' if 0x64 in b[:i] else '')] += 1
json.dump({'blocks': len(blocks), 'instructions': total, 'mnemonics': mnemonics, 'forms': forms, 'opcodes': first_bytes}, open(out, 'w'), indent=1)
print('unique blocks %d, unique instructions %d, mnemonics %d, opcode forms %d' % (len(blocks), total, len(mnemonics), len(first_bytes)))
print(' '.join('%s:%d' % kv for kv in sorted(mnemonics.items())))
