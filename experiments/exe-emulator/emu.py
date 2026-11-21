"""Feasibility test: run a signal controller program (a Windows exe) without Windows.

An x86 emulator (Unicorn) loads the PE file; every imported Windows / C
library function is replaced by a small stand-in written here; files live in
memory. DDE is not emulated as a transport: the simulation's data is handed
straight to the function of the exe that receives the DDE transactions.

The same design carries over to a browser: the emulator core as WebAssembly,
the stand-ins in JavaScript.

usage:  python emu.py <controller.exe> <supply1> <supply2> [seconds]
"""
import struct, sys, time as _time, os, re, fnmatch
import pefile
from unicorn import Uc, UC_ARCH_X86, UC_MODE_32, UC_HOOK_CODE, UC_HOOK_MEM_UNMAPPED, UcError
from unicorn.x86_const import *

STUBS = 0x70000000      # one `ret` per import, hooked
HEAP = 0x10000000
HEAP_SIZE = 96 << 20
STACK_TOP = 0x7FF00000
STACK_SIZE = 4 << 20
STOP = 0xFFFFFFF0 & 0x7000FFF0  # filled in below

XTYP_CONNECT, XTYP_POKE, XTYP_REQUEST = 0x1062, 0x4090, 0x20B0
WM_CREATE = 1


class Exit(Exception):
    pass


class Emulator:
    def __init__(self, exe_path, files, cmdline, verbose=False, clock=1795292652, tz=3600):
        self.verbose = verbose
        self.fs = {k.lower(): bytearray(v) for k, v in files.items()}  # in-memory files
        self.calls = {}          # import name → number of calls
        self.missing = set()
        self.log = []
        self.clock = clock       # the PC clock the program sees (seconds since 1970, UTC)
        self.tz = tz             # local time = UTC + tz seconds
        pe = pefile.PE(exe_path)
        self.pe = pe
        self.base = pe.OPTIONAL_HEADER.ImageBase
        uc = self.uc = Uc(UC_ARCH_X86, UC_MODE_32)
        image = pe.get_memory_mapped_image()
        size = (pe.OPTIONAL_HEADER.SizeOfImage + 0xFFFF) & ~0xFFFF
        uc.mem_map(self.base, size)
        uc.mem_write(self.base, bytes(image))
        uc.mem_map(HEAP, HEAP_SIZE)
        self.brk = HEAP + 16
        self.free = {}           # block size → freed blocks
        uc.mem_map(STACK_TOP - STACK_SIZE, STACK_SIZE)
        uc.mem_map(STUBS, 0x10000)
        uc.mem_write(STUBS, b'\xC3' * 0x10000)
        uc.mem_map(0x7FFD0000, 0x10000)  # TEB stand-in for fs:
        uc.mem_write(0x7FFD0018, struct.pack('<I', 0x7FFD0000))
        uc.reg_write(UC_X86_REG_ESP, STACK_TOP - 0x1000)

        self.symbols = self._symbols()
        # ---- imports: IAT entry → stub address; stdcall argument bytes from the symbol names
        self.stub_of = {}        # stub address → (name, argbytes or None for cdecl / data)
        self.data = {}
        argbytes = {}
        for name in self.symbols:
            m = re.match(r'__imp__(\w+?)@(\d+)$', name)
            if m:
                argbytes[m.group(1)] = int(m.group(2))
        n = 0
        for entry in pe.DIRECTORY_ENTRY_IMPORT:
            for imp in entry.imports:
                name = imp.name.decode()
                addr = STUBS + 0x100 + n * 4
                n += 1
                if name in DATA_IMPORTS:
                    addr = self.alloc(DATA_IMPORTS[name])
                    self.data[name] = addr
                else:
                    self.stub_of[addr] = (name, argbytes.get(name))
                uc.mem_write(imp.address, struct.pack('<I', addr))
        self.STOP = STUBS + 0x10
        self.CONT = STUBS + 0x20
        self.continuations = []
        uc.hook_add(UC_HOOK_CODE, self._on_stub, begin=STUBS, end=STUBS + 0x10000)
        uc.hook_add(UC_HOOK_MEM_UNMAPPED, self._on_unmapped)

        # ---- C runtime data
        self.iob = self.data.get('_iob', self.alloc(96))
        self.files = {}          # FILE* → open file
        self.errno = self.alloc(4)
        self.tm = self.alloc(64)
        self.static = self.alloc(4096)
        self.lconv = self.alloc(64)
        self.w32(self.lconv, self.cstr('.'))
        self.w32(self.lconv + 4, self.cstr(''))
        self.w32(self.lconv + 8, self.cstr(''))
        if '__mb_cur_max' in self.data:
            self.w32(self.data['__mb_cur_max'], 1)
        self.cmdline = self.cstr(cmdline)
        if '_acmdln' in self.data:
            self.w32(self.data['_acmdln'], self.cmdline)
        # ---- DDE stand-in
        self.hsz = {}            # string → handle
        self.hsz_text = {}
        self.dde_callback = 0
        self.dde_data = {}       # handle → bytearray
        self.dde_guest = {}      # handle → guest buffer of an accessed handle
        self.next_handle = 0x5000
        self.wndproc = 0
        self.hwnd = 0
        self.destroyed = False
        self.saved = None

    # ------------------------------------------------------------------ memory helpers
    def _symbols(self):
        pe, out = self.pe, {}
        data = bytes(pe.__data__[:])
        off, n = pe.FILE_HEADER.PointerToSymbolTable, pe.FILE_HEADER.NumberOfSymbols
        strtab = off + n * 18
        i = 0
        while i < n:
            e = data[off + i * 18: off + i * 18 + 18]
            if e[:4] == b'\0\0\0\0':
                o = struct.unpack('<I', e[4:8])[0]
                name = data[strtab + o: data.index(b'\0', strtab + o)].decode('latin1')
            else:
                name = e[:8].rstrip(b'\0').decode('latin1')
            val, sec, typ, cls, aux = struct.unpack('<IhHBB', e[8:18])
            if sec > 0:
                out.setdefault(name, self.base + pe.sections[sec - 1].VirtualAddress + val)
            i += 1 + aux
        return out

    def alloc(self, size):
        size = (size + 8 + 15) & ~15
        free = self.free.get(size)
        if free:
            return free.pop()
        addr = self.brk
        self.brk += size
        if self.brk > HEAP + HEAP_SIZE:
            raise MemoryError('guest heap exhausted')
        self.uc.mem_write(addr, struct.pack('<I', size - 8))
        return addr + 8

    def r32(self, a):
        return struct.unpack('<I', self.uc.mem_read(a, 4))[0]

    def w32(self, a, v):
        self.uc.mem_write(a, struct.pack('<I', v & 0xFFFFFFFF))

    def rstr(self, a, limit=4096):
        if not a:
            return ''
        out = bytearray()
        while len(out) < limit:
            chunk = self.uc.mem_read(a + len(out), 64)
            i = chunk.find(b'\0')
            if i >= 0:
                out += chunk[:i]
                break
            out += chunk
        return out.decode('latin1')

    def wstr(self, a, s):
        self.uc.mem_write(a, s.encode('latin1', 'replace') + b'\0')

    def cstr(self, s):
        a = self.alloc(len(s) + 1)
        self.wstr(a, s)
        return a

    def arg(self, i):
        return self.r32(self.uc.reg_read(UC_X86_REG_ESP) + 4 + 4 * i)

    # ------------------------------------------------------------------ stubs
    def _on_unmapped(self, uc, access, address, size, value, user):
        eip = uc.reg_read(UC_X86_REG_EIP)
        self.log.append('unmapped memory access at %#x from %#x' % (address, eip))
        return False

    def _on_stub(self, uc, address, size, user):
        if address == self.STOP:
            uc.emu_stop()
            return
        if address == self.CONT:
            self.continuations.pop()()
            return
        entry = self.stub_of.get(address)
        if not entry:
            self.log.append('jump to unknown stub %#x' % address)
            uc.emu_stop()
            return
        name, argbytes = entry
        self.calls[name] = self.calls.get(name, 0) + 1
        fn = getattr(self, 'f_' + name, None)
        if fn is None:
            if name not in self.missing:
                self.missing.add(name)
                self.log.append('not implemented: %s (returns 0)' % name)
            result = 0
        else:
            result = fn()
        if result is REDIRECTED:
            return
        if result is not None:
            uc.reg_write(UC_X86_REG_EAX, result & 0xFFFFFFFF)
        if argbytes:
            # stdcall: the callee removes its arguments – move the return address up
            esp = uc.reg_read(UC_X86_REG_ESP)
            ret = self.r32(esp)
            self.w32(esp + argbytes, ret)
            uc.reg_write(UC_X86_REG_ESP, esp + argbytes)

    def redirect(self, target, args, then, argbytes):
        """From inside a stub: run guest function `target(args)` (stdcall), then `then(eax)`,
        which returns the stub's own result. `argbytes`: the stub's own stdcall argument size."""
        uc = self.uc
        esp = uc.reg_read(UC_X86_REG_ESP)
        ret = self.r32(esp)
        esp += 4 + argbytes  # drop the stub's frame

        def cont():
            # stack: the `ret` of CONT is about to run; give it the original return address
            e = uc.reg_read(UC_X86_REG_ESP)
            result = then(uc.reg_read(UC_X86_REG_EAX))
            uc.reg_write(UC_X86_REG_EAX, result & 0xFFFFFFFF)
            self.w32(e - 4, ret)
            uc.reg_write(UC_X86_REG_ESP, e - 4)

        self.continuations.append(cont)
        frame = [target, self.CONT] + list(args)
        esp -= 4 * len(frame)
        uc.mem_write(esp, struct.pack('<%dI' % len(frame), *[a & 0xFFFFFFFF for a in frame]))
        uc.reg_write(UC_X86_REG_ESP, esp)  # the stub's `ret` jumps to `target`
        return REDIRECTED

    def call(self, target, args=()):
        """Runs a guest function to completion from the host and returns eax."""
        uc = self.uc
        saved = {r: uc.reg_read(r) for r in REGS}
        esp = (uc.reg_read(UC_X86_REG_ESP) - 0x400) & ~0xF
        frame = [self.STOP] + list(args)
        esp -= 4 * len(frame)
        uc.mem_write(esp, struct.pack('<%dI' % len(frame), *[a & 0xFFFFFFFF for a in frame]))
        uc.reg_write(UC_X86_REG_ESP, esp)
        try:
            uc.emu_start(target, 0)
        except UcError as e:
            raise RuntimeError('emulation failed at %#x: %s; %s' % (uc.reg_read(UC_X86_REG_EIP), e, self.log[-3:]))
        result = uc.reg_read(UC_X86_REG_EAX)
        for r, v in saved.items():
            uc.reg_write(r, v)
        return result

    # ------------------------------------------------------------------ program start
    def start(self):
        s = self.symbols
        self.call(s['__pei386_runtime_relocator'])
        self.call(s['___main'])
        uc = self.uc
        # WinMain(hInstance, hPrev, lpCmdLine, nShow) – runs until it waits for a message
        esp = uc.reg_read(UC_X86_REG_ESP) - 0x100
        frame = [self.STOP, self.base, 0, self.cmdline, 1]
        esp -= 4 * len(frame)
        uc.mem_write(esp, struct.pack('<5I', *frame))
        uc.reg_write(UC_X86_REG_ESP, esp)
        try:
            uc.emu_start(s['_WinMain@16'], 0)
        except UcError as e:
            raise RuntimeError('emulation failed at %#x: %s; %s' % (uc.reg_read(UC_X86_REG_EIP), e, self.log[-3:]))
        # now parked inside GetMessageA

    # ------------------------------------------------------------------ DDE, driven from the host
    def handle(self, text):
        if text not in self.hsz:
            self.next_handle += 4
            self.hsz[text] = self.next_handle
            self.hsz_text[self.next_handle] = text
        return self.hsz[text]

    def dde(self, kind, topic, item, data=None):
        hdata = 0
        if data is not None:
            self.next_handle += 4
            hdata = self.next_handle
            self.dde_data[hdata] = bytearray(data)
        result = self.call(self.dde_callback, [kind, 0x80, 0x1234, self.handle(topic), self.handle(item), hdata, 0, 0])
        return result

    def poke(self, item, triples):
        data = b''.join(struct.pack('<3i', *t) for t in triples) + struct.pack('<i', 999)
        return self.dde(XTYP_POKE, 'VISSIM', item, data) == 0x8000

    def request(self, item):
        h = self.dde(XTYP_REQUEST, 'VISSIM', item)
        raw = bytes(self.dde_data.pop(h, b''))
        out, i = [], 0
        while i + 4 <= len(raw) and struct.unpack_from('<i', raw, i)[0] != 999 and i + 12 <= len(raw):
            out.append(struct.unpack_from('<3i', raw, i))
            i += 12
        return out

    # ================================================================== USER32 / GDI32
    def f_RegisterClassA(self):
        self.wndproc = self.r32(self.arg(0) + 4)
        return 1

    def f_CreateWindowExA(self):
        self.hwnd = 0x900
        # the window procedure sets the program up on WM_CREATE
        return self.redirect(self.wndproc, [self.hwnd, WM_CREATE, 0, 0], lambda eax: self.hwnd, 48)

    def f_GetMessageA(self):
        self.uc.emu_stop()  # the program is idle: back to the host
        return 0

    def f_DestroyWindow(self):
        self.destroyed = True
        return 1

    def f_MessageBoxA(self):
        self.log.append('MessageBox: %s' % self.rstr(self.arg(1)))
        return 1

    def f_GetWindowLongA(self): return self.base
    def f_ShowWindow(self): return 1
    def f_UpdateWindow(self): return 1
    def f_LoadCursorA(self): return 1
    def f_LoadImageA(self): return 1
    def f_GetStockObject(self): return 1
    def f_GetSystemMenu(self): return 1
    def f_AppendMenuA(self): return 1
    def f_DefWindowProcA(self): return 0
    def f_FindWindowA(self): return 0
    def f_PostQuitMessage(self): return 0
    def f_TranslateMessage(self): return 0
    def f_DispatchMessageA(self): return 0
    def f_DialogBoxParamA(self): return 0
    def f_EndDialog(self): return 1

    def f_DdeInitializeA(self):
        self.w32(self.arg(0), 1)
        self.dde_callback = self.arg(1)
        return 0

    def f_DdeCreateStringHandleA(self): return self.handle(self.rstr(self.arg(1)))
    def f_DdeFreeStringHandle(self): return 1
    def f_DdeNameService(self): return 1
    def f_DdeUninitialize(self): return 1
    def f_DdeCmpStringHandles(self): return 0 if self.arg(0) == self.arg(1) else 1

    def f_DdeAccessData(self):
        h = self.arg(0)
        data = self.dde_data.get(h, bytearray())
        buf = self.alloc(len(data) + 16)
        self.uc.mem_write(buf, bytes(data))
        self.dde_guest[h] = buf
        if self.arg(1):
            self.w32(self.arg(1), len(data))
        return buf

    def f_DdeUnaccessData(self):
        self.release(self.dde_guest.pop(self.arg(0), 0))
        return 1

    def f_DdeFreeDataHandle(self):
        self.dde_data.pop(self.arg(0), None)
        return 1

    def f_DdeCreateDataHandle(self):
        self.next_handle += 4
        src, cb = self.arg(1), self.arg(2)
        self.dde_data[self.next_handle] = bytearray(self.uc.mem_read(src, cb)) if src else bytearray()
        return self.next_handle

    def f_DdeAddData(self):
        h, src, cb, off = self.arg(0), self.arg(1), self.arg(2), self.arg(3)
        data = self.dde_data.setdefault(h, bytearray())
        if len(data) < off + cb:
            data.extend(b'\0' * (off + cb - len(data)))
        data[off:off + cb] = self.uc.mem_read(src, cb)
        return h

    # ================================================================== KERNEL32
    def f_GetModuleHandleA(self): return self.base
    def f_GetModuleHandleW(self): return self.base
    def f_GetStartupInfoA(self):
        self.uc.mem_write(self.arg(0), b'\0' * 68)
        return 0
    def f_GetCurrentProcess(self): return 0xFFFFFFFF
    def f_GetCurrentProcessId(self): return 4242
    def f_GetCurrentThreadId(self): return 4243
    def f_GetLastError(self): return 0
    def f_SetUnhandledExceptionFilter(self): return 0
    def f_UnhandledExceptionFilter(self): return 0
    def f_InitializeCriticalSection(self): return 0
    def f_EnterCriticalSection(self): return 0
    def f_LeaveCriticalSection(self): return 0
    def f_DeleteCriticalSection(self): return 0
    def f_TlsGetValue(self): return 0
    def f_Sleep(self): return 0
    def f_LoadLibraryA(self):
        self.log.append('LoadLibrary %s -> not available' % self.rstr(self.arg(0)))
        return 0
    def f_GetProcAddress(self): return 0
    def f_FreeLibrary(self): return 1
    def f_FindFirstChangeNotificationA(self): return 0x700
    def f_FindCloseChangeNotification(self): return 1
    def f_WaitForSingleObject(self): return 0x102  # WAIT_TIMEOUT: nothing changed
    def f_IsDBCSLeadByteEx(self): return 0
    def f_VirtualProtect(self):
        if self.arg(3):
            self.w32(self.arg(3), 4)
        return 1

    def f_VirtualQuery(self):
        addr, buf = self.arg(0), self.arg(1)
        page = addr & ~0xFFF
        self.uc.mem_write(buf, struct.pack('<7I', page, self.base, 0x40, 0x1000, 0x1000, 0x40, 0x1000000))
        return 28

    def f_TerminateProcess(self):
        raise Exit('TerminateProcess')

    def f_GetCurrentDirectoryA(self):
        self.wstr(self.arg(1), 'C:\\run')
        return 6

    def f_GetWindowsDirectoryA(self):
        self.wstr(self.arg(0), 'C:\\Windows')
        return 10

    def f_GetTickCount(self): return (self.clock * 1000) & 0xFFFFFFFF

    def f_QueryPerformanceCounter(self):
        self.uc.mem_write(self.arg(0), struct.pack('<Q', self.clock * 1000000))
        return 1

    def f_GetSystemTimeAsFileTime(self):
        self.uc.mem_write(self.arg(0), struct.pack('<Q', (self.clock + 11644473600) * 10000000))
        return 0

    def f_SystemTimeToTzSpecificLocalTime(self):
        import calendar
        y, mo, dow, d, h, mi, sec, ms = struct.unpack('<8H', self.uc.mem_read(self.arg(1), 16))
        g = _time.gmtime(calendar.timegm((y, mo, d, h, mi, sec)) + self.tz)
        self.uc.mem_write(self.arg(2), struct.pack('<8H', g.tm_year, g.tm_mon, (g.tm_wday + 1) % 7, g.tm_mday, g.tm_hour, g.tm_min, g.tm_sec, ms))
        return 1

    def f_MultiByteToWideChar(self):
        src, n, dst, cap = self.arg(2), self.arg(3), self.arg(4), self.arg(5)
        s = self.rstr(src) + '\0' if n == 0xFFFFFFFF else bytes(self.uc.mem_read(src, n)).decode('latin1')
        if cap:
            self.uc.mem_write(dst, s[:cap].encode('utf-16-le'))
        return len(s)

    def f_WideCharToMultiByte(self):
        src, n, dst, cap = self.arg(2), self.arg(3), self.arg(4), self.arg(5)
        if n == 0xFFFFFFFF:
            raw = bytearray()
            while True:
                c = bytes(self.uc.mem_read(src + len(raw), 2))
                raw += c
                if c == b'\0\0':
                    break
            s = raw.decode('utf-16-le')
        else:
            s = bytes(self.uc.mem_read(src, n * 2)).decode('utf-16-le')
        if cap:
            self.uc.mem_write(dst, s[:cap].encode('latin1', 'replace'))
        return len(s)

    # ---- ini files
    def _ini(self, path):
        return self.fs.get(self._name(path), bytearray()).decode('latin1').splitlines()

    def _ini_get(self, path, section, key):
        inside = False
        for line in self._ini(path):
            t = line.strip()
            if t.startswith('['):
                inside = t[1:t.find(']')].lower() == section.lower()
            elif inside and '=' in t and t.split('=', 1)[0].strip().lower() == key.lower():
                return t.split('=', 1)[1].strip()
        return None

    def f_GetPrivateProfileStringA(self):
        section, key, default, buf, cap, path = (self.rstr(self.arg(0)), self.rstr(self.arg(1)), self.rstr(self.arg(2)), self.arg(3), self.arg(4), self.rstr(self.arg(5)))
        value = self._ini_get(path, section, key)
        value = (default if value is None else value)[:max(0, cap - 1)]
        self.wstr(buf, value)
        return len(value)

    def f_GetPrivateProfileIntA(self):
        value = self._ini_get(self.rstr(self.arg(3)), self.rstr(self.arg(0)), self.rstr(self.arg(1)))
        m = re.match(r'\s*-?\d+', value or '')
        return int(m.group()) if m else self.arg(2)

    def f_WritePrivateProfileStringA(self):
        section, key, value, path = self.rstr(self.arg(0)), self.rstr(self.arg(1)), self.rstr(self.arg(2)), self.rstr(self.arg(3))
        lines = self._ini(path)
        out, inside, done = [], False, False
        for line in lines:
            t = line.strip()
            if t.startswith('['):
                if inside and not done:
                    out.append('%s=%s' % (key, value))
                    done = True
                inside = t[1:t.find(']')].lower() == section.lower()
            elif inside and not done and '=' in t and t.split('=', 1)[0].strip().lower() == key.lower():
                line = '%s=%s' % (key, value)
                done = True
            out.append(line)
        if not done:
            if not inside:
                out.append('[%s]' % section)
            out.append('%s=%s' % (key, value))
        self.fs[self._name(path)] = bytearray(('\r\n'.join(out) + '\r\n').encode('latin1', 'replace'))
        return 1

    # ================================================================== msvcrt
    def _name(self, path):
        return path.replace('/', '\\').split('\\')[-1].lower()

    def f_malloc(self): return self.alloc(max(1, self.arg(0)))

    def f_calloc(self):
        n = max(1, self.arg(0) * self.arg(1))
        a = self.alloc(n)
        self.uc.mem_write(a, b'\0' * n)
        return a

    def f_realloc(self):
        old, n = self.arg(0), max(1, self.arg(1))
        a = self.alloc(n)
        if old:
            have = self.r32(old - 8)
            self.uc.mem_write(a, bytes(self.uc.mem_read(old, min(have, n))))
            self.release(old)
        return a

    def release(self, addr):
        if addr:
            self.free.setdefault(self.r32(addr - 8) + 8, []).append(addr)

    def f_free(self):
        self.release(self.arg(0))
        return 0
    def f_memcpy(self):
        self.uc.mem_write(self.arg(0), bytes(self.uc.mem_read(self.arg(1), self.arg(2))))
        return self.arg(0)
    def f_memset(self):
        self.uc.mem_write(self.arg(0), bytes([self.arg(1) & 0xFF]) * self.arg(2))
        return self.arg(0)
    def f_memcmp(self):
        a, b = bytes(self.uc.mem_read(self.arg(0), self.arg(2))), bytes(self.uc.mem_read(self.arg(1), self.arg(2)))
        return (a > b) - (a < b)
    def f_strlen(self): return len(self.rstr(self.arg(0), 1 << 20))
    def f_wcslen(self):
        n = 0
        while bytes(self.uc.mem_read(self.arg(0) + 2 * n, 2)) != b'\0\0':
            n += 1
        return n
    def f_strcpy(self):
        self.wstr(self.arg(0), self.rstr(self.arg(1), 1 << 20))
        return self.arg(0)
    def f_strcat(self):
        d = self.arg(0)
        self.wstr(d + len(self.rstr(d, 1 << 20)), self.rstr(self.arg(1), 1 << 20))
        return d
    def f_strncpy(self):
        d, s, n = self.arg(0), self.rstr(self.arg(1), 1 << 20).encode('latin1'), self.arg(2)
        self.uc.mem_write(d, (s[:n] + b'\0' * n)[:n])
        return d
    def f_strcmp(self):
        a, b = self.rstr(self.arg(0), 1 << 20), self.rstr(self.arg(1), 1 << 20)
        return (a > b) - (a < b)
    def f_strncmp(self):
        n = self.arg(2)
        a, b = self.rstr(self.arg(0), 1 << 20)[:n], self.rstr(self.arg(1), 1 << 20)[:n]
        return (a > b) - (a < b)
    def f__strnicmp(self):
        n = self.arg(2)
        a, b = self.rstr(self.arg(0))[:n].lower(), self.rstr(self.arg(1))[:n].lower()
        return (a > b) - (a < b)
    def f_strchr(self):
        s, c = self.rstr(self.arg(0), 1 << 20), self.arg(1) & 0xFF
        if c == 0:
            return self.arg(0) + len(s)
        i = s.find(chr(c))
        return self.arg(0) + i if i >= 0 else 0
    def f_strstr(self):
        i = self.rstr(self.arg(0), 1 << 20).find(self.rstr(self.arg(1)))
        return self.arg(0) + i if i >= 0 else 0
    def f_strspn(self):
        s, accept = self.rstr(self.arg(0)), self.rstr(self.arg(1))
        n = 0
        while n < len(s) and s[n] in accept:
            n += 1
        return n
    def f__strupr(self):
        self.wstr(self.arg(0), self.rstr(self.arg(0)).upper())
        return self.arg(0)
    def f__strnset(self):
        s = self.rstr(self.arg(0))
        n = min(len(s), self.arg(2))
        self.uc.mem_write(self.arg(0), bytes([self.arg(1) & 0xFF]) * n)
        return self.arg(0)
    def f_toupper(self): return ord(chr(self.arg(0) & 0xFF).upper())
    def f_tolower(self): return ord(chr(self.arg(0) & 0xFF).lower())
    def f_isspace(self): return int(chr(self.arg(0) & 0xFF) in ' \t\n\r\v\f')
    def f_isupper(self): return int(chr(self.arg(0) & 0xFF).isupper())
    def f_islower(self): return int(chr(self.arg(0) & 0xFF).islower())
    def f_isprint(self): return int(32 <= (self.arg(0) & 0xFF) < 127)
    def f_isxdigit(self): return int(chr(self.arg(0) & 0xFF) in '0123456789abcdefABCDEF')

    def _strtol(self, signed):
        s, endp, base = self.rstr(self.arg(0)), self.arg(1), self.arg(2)
        m = re.match(r'\s*([+-]?)(0[xX])?([0-9a-zA-Z]*)', s)
        sign, prefix, digits = m.group(1), m.group(2), m.group(3)
        if base == 0:
            base = 16 if prefix else (8 if digits.startswith('0') and len(digits) > 1 else 10)
        elif prefix and base != 16:
            digits, prefix = '0', None
        n = 0
        valid = '0123456789abcdefghijklmnopqrstuvwxyz'[:base]
        used = 0
        for ch in digits:
            if ch.lower() not in valid:
                break
            n = n * base + valid.index(ch.lower())
            used += 1
        if endp:
            consumed = (m.end(1) + (len(prefix) if prefix else 0) + used) if used else 0
            self.w32(endp, self.arg(0) + consumed)
        if sign == '-':
            n = -n
        return max(-0x80000000, min(0x7FFFFFFF, n)) if signed else n & 0xFFFFFFFF

    def f_strtol(self): return self._strtol(True)
    def f_strtoul(self): return self._strtol(False)
    def f_atoi(self):
        m = re.match(r'\s*[+-]?\d+', self.rstr(self.arg(0)))
        return int(m.group()) if m else 0
    f_atol = f_atoi
    def f__itoa(self):
        v, buf, base = self.arg(0), self.arg(1), self.arg(2)
        if base == 10 and v & 0x80000000:
            s = str(v - (1 << 32))
        else:
            digits = '0123456789abcdefghijklmnopqrstuvwxyz'
            s = ''
            while True:
                s = digits[v % base] + s
                v //= base
                if not v:
                    break
        self.wstr(buf, s)
        return buf
    f__ltoa = f__itoa

    # ---- formatted output (the msvcrt imports; most formatting is done by the exe's own code)
    def _format(self, fmt, argp):
        out, i = [], 0
        def next_arg():
            nonlocal argp
            v = self.r32(argp)
            argp += 4
            return v
        while i < len(fmt):
            c = fmt[i]
            if c != '%':
                out.append(c)
                i += 1
                continue
            m = re.match(r'%([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d+))?(hh|h|ll|l|L|I64)?([diuxXcsfgeEGp%])', fmt[i:])
            if not m:
                out.append(c)
                i += 1
                continue
            i += m.end()
            flags, width, prec, length, conv = m.groups()
            if conv == '%':
                out.append('%')
                continue
            if width == '*':
                width = str(next_arg())
            if prec == '*':
                prec = str(next_arg())
            spec = '%' + flags + (width or '') + ('.' + prec if prec is not None else '')
            if conv in 'di':
                v = next_arg()
                if length == 'll' or length == 'I64':
                    v |= next_arg() << 32
                    v -= (1 << 64) if v >> 63 else 0
                else:
                    v -= (1 << 32) if v >> 31 else 0
                out.append((spec + 'd') % v)
            elif conv in 'uxX':
                v = next_arg()
                if length == 'll' or length == 'I64':
                    v |= next_arg() << 32
                out.append((spec + ('d' if conv == 'u' else conv)) % v)
            elif conv == 'c':
                out.append((spec + 'c') % chr(next_arg() & 0xFF))
            elif conv == 's':
                out.append((spec + 's') % self.rstr(next_arg(), 1 << 16))
            elif conv == 'p':
                out.append('%08X' % next_arg())
            else:
                lo, hi = next_arg(), next_arg()
                out.append((spec + conv) % struct.unpack('<d', struct.pack('<II', lo, hi))[0])
        return ''.join(out)

    def f_sprintf(self):
        s = self._format(self.rstr(self.arg(1), 1 << 16), self.uc.reg_read(UC_X86_REG_ESP) + 12)
        self.wstr(self.arg(0), s)
        return len(s)

    def f_fprintf(self):
        s = self._format(self.rstr(self.arg(1), 1 << 16), self.uc.reg_read(UC_X86_REG_ESP) + 12)
        return self._write(self.arg(0), s.encode('latin1', 'replace'))

    def f_vfprintf(self):
        s = self._format(self.rstr(self.arg(1), 1 << 16), self.arg(2))
        return self._write(self.arg(0), s.encode('latin1', 'replace'))

    # ---- files
    def _write(self, fp, data):
        f = self.files.get(fp)
        if f is None:
            if self.iob <= fp < self.iob + 96 and self.verbose:
                sys.stderr.write(data.decode('latin1'))
            return len(data)
        buf = f['data']
        if f['append']:
            f['pos'] = len(buf)
        end = f['pos'] + len(data)
        if len(buf) < end:
            buf.extend(b'\0' * (end - len(buf)))
        buf[f['pos']:end] = data
        f['pos'] = end
        return len(data)

    def f_fopen(self):
        name, mode = self._name(self.rstr(self.arg(0))), self.rstr(self.arg(1))
        exists = name in self.fs
        if 'r' in mode and not exists:
            return 0
        if 'w' in mode or not exists:
            self.fs[name] = bytearray()
        fp = self.alloc(32)
        self.files[fp] = {'name': name, 'data': self.fs[name], 'pos': 0, 'append': 'a' in mode, 'eof': False, 'unget': None}
        return fp

    def f_fclose(self):
        if self.files.pop(self.arg(0), None) is not None:
            self.release(self.arg(0))
        return 0

    def f_fflush(self): return 0
    def f_feof(self):
        f = self.files.get(self.arg(0))
        return int(bool(f and f['eof']))
    def f_ftell(self):
        f = self.files.get(self.arg(0))
        return f['pos'] if f else 0xFFFFFFFF
    def f_fseek(self):
        f = self.files.get(self.arg(0))
        if not f:
            return 0xFFFFFFFF
        off = self.arg(1)
        off -= (1 << 32) if off >> 31 else 0
        f['pos'] = max(0, [0, f['pos'], len(f['data'])][self.arg(2)] + off)
        f['eof'] = False
        return 0
    def f_fread(self):
        buf, size, n, fp = self.arg(0), self.arg(1), self.arg(2), self.arg(3)
        f = self.files.get(fp)
        if not f or not size:
            return 0
        data = bytes(f['data'][f['pos']:f['pos'] + size * n])
        items = len(data) // size
        self.uc.mem_write(buf, data[:items * size])
        f['pos'] += items * size
        if items < n:
            f['eof'] = True
        return items
    def f_fwrite(self):
        size, n = self.arg(1), self.arg(2)
        self._write(self.arg(3), bytes(self.uc.mem_read(self.arg(0), size * n)))
        return n
    def f_fputs(self):
        self._write(self.arg(1), self.rstr(self.arg(0), 1 << 16).encode('latin1', 'replace'))
        return 0
    def f_fputc(self):
        self._write(self.arg(1), bytes([self.arg(0) & 0xFF]))
        return self.arg(0) & 0xFF
    def f_getc(self):
        f = self.files.get(self.arg(0))
        if not f:
            return 0xFFFFFFFF
        if f['unget'] is not None:
            c, f['unget'] = f['unget'], None
            return c
        if f['pos'] >= len(f['data']):
            f['eof'] = True
            return 0xFFFFFFFF
        c = f['data'][f['pos']]
        f['pos'] += 1
        return c
    def f_ungetc(self):
        f = self.files.get(self.arg(1))
        if f:
            f['unget'] = self.arg(0) & 0xFF
            f['eof'] = False
        return self.arg(0)
    def f_fgets(self):
        buf, cap, fp = self.arg(0), self.arg(1), self.arg(2)
        f = self.files.get(fp)
        if not f or f['pos'] >= len(f['data']):
            if f:
                f['eof'] = True
            return 0
        data = f['data']
        end = data.find(b'\n', f['pos'])
        end = len(data) if end < 0 else end + 1
        end = min(end, f['pos'] + cap - 1)
        line = bytes(data[f['pos']:end])
        # text mode: CR LF → LF
        text = line.replace(b'\r\n', b'\n')
        self.uc.mem_write(buf, text + b'\0')
        f['pos'] = end
        return buf
    def f__access(self): return 0 if self._name(self.rstr(self.arg(0))) in self.fs else 0xFFFFFFFF
    def f_remove(self): return 0 if self.fs.pop(self._name(self.rstr(self.arg(0))), None) is not None else 0xFFFFFFFF
    def f_rename(self):
        a, b = self._name(self.rstr(self.arg(0))), self._name(self.rstr(self.arg(1)))
        if a not in self.fs:
            return 0xFFFFFFFF
        self.fs[b] = self.fs.pop(a)
        return 0
    def f__findfirst(self):
        pattern = self._name(self.rstr(self.arg(0)))
        for name, data in self.fs.items():
            if fnmatch.fnmatch(name, pattern):
                self.uc.mem_write(self.arg(1), struct.pack('<5I', 0x20, self.clock, self.clock, self.clock, len(data)) + name.encode('latin1') + b'\0')
                return 0x800
        return 0xFFFFFFFF
    def f__close(self): return 0
    def f__splitpath(self):
        path = self.rstr(self.arg(0))
        m = re.match(r'^([A-Za-z]:)?(.*[\\/])?([^\\/]*?)(\.[^.\\/]*)?$', path)
        for i, part in enumerate(m.groups()):
            if self.arg(1 + i):
                self.wstr(self.arg(1 + i), part or '')
        return 0
    def f__makepath(self):
        drive, d, name, ext = (self.rstr(self.arg(i)) for i in range(1, 5))
        if d and d[-1] not in '\\/':
            d += '\\'
        if ext and not ext.startswith('.'):
            ext = '.' + ext
        self.wstr(self.arg(0), (drive[:1] + ':' if drive else '') + d + name + ext)
        return 0

    # ---- time, environment, the rest
    def f_time(self):
        if self.arg(0):
            self.w32(self.arg(0), self.clock)
        return self.clock
    def _tm(self, t):
        g = _time.gmtime(t)
        self.uc.mem_write(self.tm, struct.pack('<9i', g.tm_sec, g.tm_min, g.tm_hour, g.tm_mday, g.tm_mon - 1, g.tm_year - 1900, (g.tm_wday + 1) % 7, g.tm_yday - 1, 0))
        return self.tm
    def f_localtime(self): return self._tm(self.r32(self.arg(0)) + self.tz)
    def f_gmtime(self): return self._tm(self.r32(self.arg(0)))
    def f_mktime(self):
        sec, mn, hour, mday, mon, year = struct.unpack('<6i', self.uc.mem_read(self.arg(0), 24))
        import calendar
        return (calendar.timegm((year + 1900, mon + 1, mday, hour, mn, sec)) - self.tz) & 0xFFFFFFFF
    def f_getenv(self): return 0
    def f_setlocale(self): return self.static
    def f_localeconv(self): return self.lconv
    def f_signal(self): return 0
    def f__errno(self): return self.errno
    def f_strerror(self):
        self.wstr(self.static + 64, 'error')
        return self.static + 64
    def f__getpid(self): return 4242
    def f__lock(self): return 0
    def f__unlock(self): return 0
    def f__onexit(self): return self.arg(0)
    def f___dllonexit(self): return self.arg(0)
    def f__amsg_exit(self): raise Exit('_amsg_exit')
    def f_abort(self): raise Exit('abort')
    def f_exit(self): raise Exit('exit(%d)' % self.arg(0))
    def f__cexit(self): return 0


REDIRECTED = object()
REGS = [UC_X86_REG_EAX, UC_X86_REG_EBX, UC_X86_REG_ECX, UC_X86_REG_EDX, UC_X86_REG_ESI, UC_X86_REG_EDI, UC_X86_REG_EBP, UC_X86_REG_ESP, UC_X86_REG_EIP, UC_X86_REG_EFLAGS]
# imports that are variables, not functions: name → size
DATA_IMPORTS = {'_iob': 96, '__argc': 4, '_acmdln': 4, '__initenv': 4, '_fmode': 4, '__mb_cur_max': 4, '__p___argv': 4}


def run(exe, supply, seconds, quiet=False, clock=None):
    """Starts the controller and lets it run `seconds` control steps of the scenario;
    returns the emulator, the signal pictures it asked for and timings."""
    import scenario
    files = {os.path.basename(path): open(path, 'rb').read() for path in supply}
    names = [os.path.basename(p) for p in supply[:2]]
    emu = Emulator(exe, files, '1 1 X ' + ' '.join(names), **({'clock': clock, 'tz': -_time.timezone} if clock else {}))
    t0 = _time.time()
    emu.start()
    t_start = _time.time() - t0
    assert emu.poke('DateiLesen', scenario.SETUP), 'DateiLesen'
    assert emu.poke('Init', scenario.SETUP), 'Init'
    t_init = _time.time() - t0 - t_start
    picture = {sg: 2 for sg in scenario.GROUPS}
    record = []
    t1 = _time.time()
    for sec in range(1, seconds + 1):
        assert emu.poke('Rechnen', scenario.step(sec, picture)), 'Rechnen at %d' % sec
        reply = emu.request('Wunschbild')
        want = scenario.wanted(reply)
        for c, i, v in want:
            picture[i] = v
        record.append([list(t) for t in reply])
        if want:
            if not quiet:
                print('t=%3d %s' % (sec, ' '.join('%s%d=%d' % ('S' if c == 2002 else 'O', i, v) for c, i, v in want)), flush=True)
    per_step = (_time.time() - t1) / max(1, seconds)
    return emu, record, {'start': t_start, 'init': t_init, 'per_step': per_step}


if __name__ == '__main__':
    exe, s1, s2 = sys.argv[1:4]
    seconds = int(sys.argv[4]) if len(sys.argv) > 4 else 150
    extra = [p for p in sys.argv[5:]]
    emu, changes, timing = run(exe, [s1, s2] + extra, seconds)
    print('start %.2f s, DateiLesen+Init %.2f s, %.1f ms per control step' % (timing['start'], timing['init'], timing['per_step'] * 1000))
    print('imports used: %d of %d' % (len(emu.calls), len(emu.stub_of)))
    print('not implemented but called:', sorted(emu.missing) or 'none')
    for line in emu.log[:20]:
        print('log:', line)
    print('files written:', sorted(n for n in emu.fs if n not in {os.path.basename(p).lower() for p in [s1, s2] + extra}))
