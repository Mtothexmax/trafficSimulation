// Runs a signal controller program (a 32-bit Windows exe) without Windows:
// the x86 interpreter executes its code, and every Windows / C library
// function it imports is provided here. Files live in memory. DDE is not a
// transport any more – the simulation's data goes straight to the function of
// the program that receives the DDE transactions.
//
// Verified against the real program: see experiments/exe-emulator (the Python
// prototype this is a port of) and program.test.ts.
import { parsePe, type PeFile } from './pe';
import { X86, type CpuState } from './x86';

export type Triple = [number, number, number];

const HOST = 0x00300000; // "addresses" of the imported functions
const HOST_SIZE = 0x10000;
const STOP = HOST + 0x10;
const CONT = HOST + 0x20;
const FIRST_STUB = HOST + 0x100;
const HEAP_SIZE = 64 << 20;
const STACK_SIZE = 4 << 20;
const XTYP_POKE = 0x4090;
const XTYP_REQUEST = 0x20b0;
const WM_CREATE = 1;
const END = 999;

/** imports that are variables, not functions: name → size */
const DATA_IMPORTS: Record<string, number> = { _iob: 96, __argc: 4, _acmdln: 4, __initenv: 4, _fmode: 4, __mb_cur_max: 4, __p___argv: 4 };

const REDIRECTED = Symbol('redirected');
type Result = number | void | typeof REDIRECTED;

interface OpenFile {
	name: string;
	pos: number;
	append: boolean;
	eof: boolean;
	unget: number;
}

export interface ProgramState {
	mem: Uint8Array;
	cpu: CpuState;
	fs: Map<string, Uint8Array>;
	free: Map<number, number[]>;
	files: Map<number, OpenFile>;
	hsz: Map<string, number>;
	ddeData: Map<number, Uint8Array>;
	ddeGuest: Map<number, number>;
	log: string[];
	n: number[];
}

export class ProgramExit extends Error {}

const enc = (s: string): Uint8Array => {
	const b = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
	return b;
};
const dec = (b: Uint8Array): string => {
	let s = '';
	for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
	return s;
};

export class ControllerProgram {
	readonly cpu: X86;
	readonly pe: PeFile;
	/** in-memory files by lower-case name */
	readonly fs = new Map<string, Uint8Array>();
	/** how often each imported function was called (see `calls`) */
	private callCounts = new Float64Array(0);
	readonly missing = new Set<string>();
	readonly log: string[] = [];
	/** the PC clock the program sees (seconds since 1970, UTC) and the local time offset (s) */
	clock: number;
	tz: number;
	destroyed = false;

	private readonly mem: Uint8Array;
	private readonly dv: DataView;
	private readonly heapStart: number;
	private readonly heapEnd: number;
	private brk: number;
	private readonly free = new Map<number, number[]>();
	/** the imported functions, by import number */
	private readonly stubs: { name: string; argBytes: number; fn: (() => Result) | undefined }[] = [];
	private readonly continuations: (() => void)[] = [];
	private readonly files = new Map<number, OpenFile>();
	private readonly iob: number;
	private readonly errno: number;
	private readonly tm: number;
	private readonly scratch: number;
	private readonly lconv: number;
	private readonly cmdline: number;
	private readonly hsz = new Map<string, number>();
	private readonly ddeData = new Map<number, Uint8Array>();
	private readonly ddeGuest = new Map<number, number>();
	private nextHandle = 0x5000;
	private ddeCallback = 0;
	private wndProc = 0;

	constructor(exe: Uint8Array, files: Record<string, Uint8Array>, commandLine: string, clock = 1795292652, tz = 3600) {
		this.clock = clock;
		this.tz = tz;
		for (const [name, data] of Object.entries(files)) this.fs.set(name.toLowerCase(), data.slice());
		const pe = (this.pe = parsePe(exe));
		const imageEnd = (pe.imageBase + pe.sizeOfImage + 0xffff) & ~0xffff;
		if (pe.imageBase < HOST + HOST_SIZE) throw new Error('Unerwartete Ladeadresse des Programms');
		this.heapStart = imageEnd;
		this.heapEnd = imageEnd + HEAP_SIZE;
		const total = this.heapEnd + STACK_SIZE;
		const buffer = new ArrayBuffer(total);
		this.mem = new Uint8Array(buffer);
		this.dv = new DataView(buffer);
		this.mem.set(pe.image, pe.imageBase);
		this.brk = this.heapStart + 16;
		this.cpu = new X86(buffer, pe.imageBase, pe.sizeOfImage, HOST, HOST + HOST_SIZE, (a) => this.onHost(a));
		this.cpu.r[4] = total - 0x1000;

		// imports: each import table slot gets the address of a host stub
		const argBytes = new Map<string, number>();
		for (const name of pe.symbols.keys()) {
			const m = /^__imp__(\w+?)@(\d+)$/.exec(name);
			if (m) argBytes.set(m[1], +m[2]);
		}
		const table = this.functions();
		const data = new Map<string, number>();
		for (const imp of pe.imports) {
			let address: number;
			if (imp.name in DATA_IMPORTS) {
				address = this.alloc(DATA_IMPORTS[imp.name]);
				this.mem.fill(0, address, address + DATA_IMPORTS[imp.name]);
				data.set(imp.name, address);
			} else {
				address = FIRST_STUB + this.stubs.length * 4;
				this.stubs.push({ name: imp.name, argBytes: argBytes.get(imp.name) ?? 0, fn: table[imp.name] });
			}
			this.dv.setUint32(imp.slot, address, true);
		}
		this.callCounts = new Float64Array(this.stubs.length);

		this.iob = data.get('_iob') ?? this.alloc(96);
		this.errno = this.alloc(4);
		this.tm = this.alloc(64);
		this.scratch = this.alloc(4096);
		this.lconv = this.alloc(64);
		this.dv.setUint32(this.lconv, this.cstr('.'), true);
		this.dv.setUint32(this.lconv + 4, this.cstr(''), true);
		this.dv.setUint32(this.lconv + 8, this.cstr(''), true);
		if (data.has('__mb_cur_max')) this.dv.setUint32(data.get('__mb_cur_max')!, 1, true);
		this.cmdline = this.cstr(commandLine);
		if (data.has('_acmdln')) this.dv.setUint32(data.get('_acmdln')!, this.cmdline, true);
	}

	/** How often each imported function was called. */
	get calls(): Map<string, number> {
		const out = new Map<string, number>();
		this.stubs.forEach((st, i) => {
			if (this.callCounts[i]) out.set(st.name, this.callCounts[i]);
		});
		return out;
	}

	// ------------------------------------------------------------------ guest memory
	private alloc(size: number): number {
		const block = (size + 8 + 15) & ~15;
		const reuse = this.free.get(block);
		if (reuse?.length) return reuse.pop()!;
		const address = this.brk;
		this.brk += block;
		if (this.brk > this.heapEnd) throw new Error('Der Speicher des Steuerungsprogramms ist erschöpft');
		this.dv.setUint32(address, block - 8, true);
		return address + 8;
	}
	private release(address: number): void {
		if (!address) return;
		const block = this.dv.getUint32(address - 8, true) + 8;
		const list = this.free.get(block);
		if (list) list.push(address);
		else this.free.set(block, [address]);
	}
	private r32(a: number): number {
		return this.dv.getUint32(a, true);
	}
	private w32(a: number, v: number): void {
		this.dv.setUint32(a, v >>> 0, true);
	}
	private strlen(a: number): number {
		const end = this.mem.indexOf(0, a);
		return (end < 0 ? this.mem.length : end) - a;
	}
	private rstr(a: number): string {
		return a ? dec(this.mem.subarray(a, a + this.strlen(a))) : '';
	}
	private wstr(a: number, s: string): void {
		this.mem.set(enc(s), a);
		this.mem[a + s.length] = 0;
	}
	private cstr(s: string): number {
		const a = this.alloc(s.length + 1);
		this.wstr(a, s);
		return a;
	}
	/** Argument i of the imported function being called. */
	private arg(i: number): number {
		return this.dv.getUint32(this.cpu.r[4] + 4 + 4 * i, true);
	}
	private sarg(i: number): number {
		return this.dv.getInt32(this.cpu.r[4] + 4 + 4 * i, true);
	}

	// ------------------------------------------------------------------ host calls
	private onHost(address: number): void {
		const cpu = this.cpu;
		if (address === STOP) {
			cpu.running = false;
			return;
		}
		if (address === CONT) {
			this.continuations.pop()!();
			return;
		}
		const index = (address - FIRST_STUB) >> 2;
		const stub = this.stubs[index];
		if (!stub || address < FIRST_STUB) throw new Error(`Sprung an eine unbekannte Adresse ${address.toString(16)}`);
		this.callCounts[index]++;
		let result: Result = 0;
		if (stub.fn) result = stub.fn();
		else if (!this.missing.has(stub.name)) {
			this.missing.add(stub.name);
			this.log.push(`nicht nachgebaut: ${stub.name} (liefert 0)`);
		}
		if (result === REDIRECTED) return;
		if (result !== undefined) cpu.r[0] = result;
		// return: stdcall functions remove their arguments
		cpu.eip = cpu.pop();
		cpu.r[4] += stub.argBytes;
	}

	/** From inside an imported function: first run guest function `target(args)`, then `then`. */
	private redirect(target: number, args: number[], then: (eax: number) => number, argBytes: number): typeof REDIRECTED {
		const cpu = this.cpu;
		const ret = cpu.pop();
		cpu.r[4] += argBytes;
		this.continuations.push(() => {
			cpu.r[0] = then(cpu.r[0]);
			cpu.eip = ret;
		});
		for (let i = args.length - 1; i >= 0; i--) cpu.push(args[i]);
		cpu.push(CONT);
		cpu.eip = target;
		return REDIRECTED;
	}

	/** Runs a guest function to completion and returns eax. */
	call(target: number, args: number[] = []): number {
		const cpu = this.cpu;
		const saved = Int32Array.from(cpu.r);
		const eip = cpu.eip;
		cpu.r[4] = (cpu.r[4] - 0x400) & ~0xf;
		for (let i = args.length - 1; i >= 0; i--) cpu.push(args[i]);
		cpu.push(STOP);
		cpu.eip = target;
		cpu.run();
		const result = cpu.r[0];
		cpu.r.set(saved);
		cpu.eip = eip;
		return result;
	}

	private symbol(name: string): number {
		const a = this.pe.symbols.get(name);
		if (a === undefined) throw new Error(`Das Programm enthält die Funktion ${name} nicht – ist es ein Steuerungsprogramm mit Symboltabelle?`);
		return a;
	}

	/** Starts the program: runtime initialisation, then WinMain up to its message loop. */
	/** The whole state of the program as it is now. `restore` returns to it: a controller
	 * that was loaded and initialised once can start again without loading. */
	snapshot(): ProgramState {
		return {
			mem: this.mem.slice(),
			cpu: this.cpu.snapshot(),
			fs: new Map([...this.fs].map(([k, v]) => [k, v.slice()])),
			free: new Map([...this.free].map(([k, v]) => [k, [...v]])),
			files: new Map([...this.files].map(([k, v]) => [k, { ...v }])),
			hsz: new Map(this.hsz),
			ddeData: new Map([...this.ddeData].map(([k, v]) => [k, v.slice()])),
			ddeGuest: new Map(this.ddeGuest),
			log: [...this.log],
			n: [this.brk, this.nextHandle, this.ddeCallback, this.wndProc, this.destroyed ? 1 : 0]
		};
	}

	restore(s: ProgramState): void {
		this.mem.set(s.mem);
		this.cpu.restore(s.cpu);
		const fill = <K, V>(to: Map<K, V>, from: Map<K, V>, copy: (v: V) => V): void => {
			to.clear();
			for (const [k, v] of from) to.set(k, copy(v));
		};
		fill(this.fs, s.fs, (v) => v.slice());
		fill(this.free, s.free, (v) => [...v]);
		fill(this.files, s.files, (v) => ({ ...v }));
		fill(this.hsz, s.hsz, (v) => v);
		fill(this.ddeData, s.ddeData, (v) => v.slice());
		fill(this.ddeGuest, s.ddeGuest, (v) => v);
		this.log.length = 0;
		this.log.push(...s.log);
		this.continuations.length = 0;
		[this.brk, this.nextHandle, this.ddeCallback, this.wndProc] = s.n;
		this.destroyed = s.n[4] === 1;
	}

	start(): void {
		this.call(this.symbol('__pei386_runtime_relocator'));
		this.call(this.symbol('___main'));
		const cpu = this.cpu;
		cpu.r[4] -= 0x100;
		for (const v of [1, this.cmdline, 0, this.pe.imageBase]) cpu.push(v);
		cpu.push(STOP);
		cpu.eip = this.symbol('_WinMain@16');
		cpu.run(); // returns when the program waits for a message
		if (!this.ddeCallback) throw new Error('Das Programm hat keinen DDE-Dienst eingerichtet');
	}

	// ------------------------------------------------------------------ DDE, driven from here
	private handle(text: string): number {
		let h = this.hsz.get(text);
		if (!h) {
			h = this.nextHandle += 4;
			this.hsz.set(text, h);
		}
		return h;
	}

	private dde(kind: number, item: string, data?: Uint8Array): number {
		let hData = 0;
		if (data) {
			hData = this.nextHandle += 4;
			this.ddeData.set(hData, data);
		}
		return this.call(this.ddeCallback, [kind, 0x80, 0x1234, this.handle('VISSIM'), this.handle(item), hData, 0, 0]);
	}

	/** Hands data to the program ("DateiLesen", "Init", "Rechnen"). */
	poke(item: string, triples: Triple[]): boolean {
		const data = new Uint8Array(triples.length * 12 + 4);
		const dv = new DataView(data.buffer);
		triples.forEach((t, i) => {
			dv.setInt32(i * 12, t[0], true);
			dv.setInt32(i * 12 + 4, t[1], true);
			dv.setInt32(i * 12 + 8, t[2], true);
		});
		dv.setInt32(triples.length * 12, END, true);
		return this.dde(XTYP_POKE, item, data) === 0x8000;
	}

	/** Fetches the program's answer ("Wunschbild"). */
	request(item: string): Triple[] {
		const h = this.dde(XTYP_REQUEST, item);
		const raw = this.ddeData.get(h) ?? new Uint8Array(0);
		this.ddeData.delete(h);
		const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
		const out: Triple[] = [];
		for (let i = 0; i + 12 <= raw.length && dv.getInt32(i, true) !== END; i += 12) out.push([dv.getInt32(i, true), dv.getInt32(i + 4, true), dv.getInt32(i + 8, true)]);
		return out;
	}

	// ------------------------------------------------------------------ files and ini files
	private fileName(path: string): string {
		return path.replace(/\//g, '\\').split('\\').pop()!.toLowerCase();
	}
	private iniLines(path: string): string[] {
		const data = this.fs.get(this.fileName(path));
		return data ? dec(data).split(/\r?\n/) : [];
	}
	private iniGet(path: string, section: string, key: string): string | null {
		let inside = false;
		for (const line of this.iniLines(path)) {
			const t = line.trim();
			if (t.startsWith('[')) inside = t.slice(1, t.indexOf(']')).toLowerCase() === section.toLowerCase();
			else if (inside) {
				const eq = t.indexOf('=');
				if (eq > 0 && t.slice(0, eq).trim().toLowerCase() === key.toLowerCase()) return t.slice(eq + 1).trim();
			}
		}
		return null;
	}
	private iniSet(path: string, section: string, key: string, value: string): void {
		const out: string[] = [];
		let inside = false;
		let done = false;
		for (let line of this.iniLines(path)) {
			const t = line.trim();
			if (t.startsWith('[')) {
				if (inside && !done) {
					out.push(`${key}=${value}`);
					done = true;
				}
				inside = t.slice(1, t.indexOf(']')).toLowerCase() === section.toLowerCase();
			} else if (inside && !done) {
				const eq = t.indexOf('=');
				if (eq > 0 && t.slice(0, eq).trim().toLowerCase() === key.toLowerCase()) {
					line = `${key}=${value}`;
					done = true;
				}
			}
			out.push(line);
		}
		while (out.length && out[out.length - 1] === '') out.pop();
		if (!done) {
			if (!inside) out.push(`[${section}]`);
			out.push(`${key}=${value}`);
		}
		this.fs.set(this.fileName(path), enc(out.join('\r\n') + '\r\n'));
	}

	private write(fp: number, data: Uint8Array): number {
		const f = this.files.get(fp);
		if (!f) return data.length; // stdout / stderr: dropped
		let buf = this.fs.get(f.name) ?? new Uint8Array(0);
		if (f.append) f.pos = buf.length;
		const end = f.pos + data.length;
		if (end > buf.length) {
			const grown = new Uint8Array(end);
			grown.set(buf);
			buf = grown;
			this.fs.set(f.name, buf);
		}
		buf.set(data, f.pos);
		f.pos = end;
		return data.length;
	}

	// ------------------------------------------------------------------ printf
	private format(fmt: string, argp: number): string {
		let out = '';
		const next = (): number => {
			const v = this.r32(argp);
			argp += 4;
			return v;
		};
		const re = /%([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d+))?(hh|h|ll|l|L|I64)?([diuxXcsfgeEGp%])/y;
		for (let i = 0; i < fmt.length; ) {
			if (fmt[i] !== '%') {
				out += fmt[i++];
				continue;
			}
			re.lastIndex = i;
			const m = re.exec(fmt);
			if (!m) {
				out += fmt[i++];
				continue;
			}
			i = re.lastIndex;
			const flags = m[1];
			const conv = m[5];
			if (conv === '%') {
				out += '%';
				continue;
			}
			const width = m[2] === '*' ? next() : m[2] ? +m[2] : 0;
			const prec = m[3] === '*' ? next() : m[3] !== undefined ? +m[3] : -1;
			let body: string;
			let numeric = true;
			if (conv === 'd' || conv === 'i') {
				let v: number | bigint = next() | 0;
				if (m[4] === 'll' || m[4] === 'I64') v = BigInt.asIntN(64, BigInt(v >>> 0) | (BigInt(next()) << 32n));
				const negative = v < 0;
				body = (negative ? -v : v).toString();
				if (prec >= 0) body = body.padStart(prec, '0');
				body = (negative ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '') + body;
			} else if (conv === 'u' || conv === 'x' || conv === 'X') {
				let v: number | bigint = next();
				if (m[4] === 'll' || m[4] === 'I64') v = BigInt(v) | (BigInt(next()) << 32n);
				body = v.toString(conv === 'u' ? 10 : 16);
				if (conv === 'X') body = body.toUpperCase();
				if (prec >= 0) body = body.padStart(prec, '0');
			} else if (conv === 'c') {
				body = String.fromCharCode(next() & 0xff);
				numeric = false;
			} else if (conv === 's') {
				body = this.rstr(next());
				if (prec >= 0) body = body.slice(0, prec);
				numeric = false;
			} else if (conv === 'p') {
				body = next().toString(16).toUpperCase().padStart(8, '0');
			} else {
				const lo = next();
				const hi = next();
				const v = new Float64Array(new Uint32Array([lo, hi]).buffer)[0];
				body = conv === 'f' ? v.toFixed(prec < 0 ? 6 : prec) : conv.toLowerCase() === 'e' ? v.toExponential(prec < 0 ? 6 : prec) : String(v);
				if (flags.includes('+') && v >= 0) body = '+' + body;
			}
			if (body.length < width) {
				if (flags.includes('-')) body = body.padEnd(width);
				else if (flags.includes('0') && numeric && prec < 0) {
					const sign = /^[-+ ]/.test(body) ? body[0] : '';
					body = sign + body.slice(sign.length).padStart(width - sign.length, '0');
				} else body = body.padStart(width);
			}
			out += body;
		}
		return out;
	}

	private strtol(signed: boolean): number {
		const mem = this.mem;
		const start = this.arg(0);
		const endp = this.arg(1);
		let base = this.arg(2);
		let i = start;
		while (mem[i] === 32 || (mem[i] >= 9 && mem[i] <= 13)) i++;
		let negative = false;
		if (mem[i] === 43 || mem[i] === 45) negative = mem[i++] === 45;
		const digitAt = (a: number): number => {
			const c = mem[a];
			return c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 122 ? c - 87 : c >= 65 && c <= 90 ? c - 55 : 99;
		};
		// "0x" belongs to the number only for base 16 and when a hex digit follows
		if (mem[i] === 48 && (mem[i + 1] | 32) === 120 && (base === 0 || base === 16) && digitAt(i + 2) < 16) {
			i += 2;
			base = 16;
		} else if (base === 0) base = mem[i] === 48 ? 8 : 10;
		const from = i;
		let n = 0;
		for (;;) {
			const d = digitAt(i);
			if (d >= base) break;
			n = n * base + d;
			i++;
		}
		if (endp) this.w32(endp, i > from ? i : start);
		if (negative) n = -n;
		if (signed) return Math.max(-2147483648, Math.min(2147483647, n)) | 0;
		return n > 4294967295 ? -1 : n | 0;
	}

	private tmAt(t: number): number {
		const d = new Date(t * 1000);
		const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
		const v = [d.getUTCSeconds(), d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate(), d.getUTCMonth(), d.getUTCFullYear() - 1900, d.getUTCDay(), Math.floor((d.getTime() - yearStart) / 86400000), 0];
		v.forEach((x, i) => this.dv.setInt32(this.tm + i * 4, x, true));
		return this.tm;
	}

	// ------------------------------------------------------------------ the imported functions
	private functions(): Record<string, () => Result> {
		const cmp = (a: string, b: string): number => (a > b ? 1 : a < b ? -1 : 0);
		const chr = (i: number): string => String.fromCharCode(this.arg(i) & 0xff);
		const f: Record<string, () => Result> = {
			// ---- USER32 / GDI32
			RegisterClassA: () => {
				this.wndProc = this.r32(this.arg(0) + 4);
				return 1;
			},
			// the window procedure sets the program up on WM_CREATE
			CreateWindowExA: () => this.redirect(this.wndProc, [0x900, WM_CREATE, 0, 0], () => 0x900, 48),
			GetMessageA: () => {
				this.cpu.running = false; // the program is idle: back to the caller
				return 0;
			},
			DestroyWindow: () => {
				this.destroyed = true;
				return 1;
			},
			MessageBoxA: () => {
				this.log.push(`Meldung der Steuerung: ${this.rstr(this.arg(1))}`);
				return 1;
			},
			GetWindowLongA: () => this.pe.imageBase,
			ShowWindow: () => 1, UpdateWindow: () => 1, LoadCursorA: () => 1, LoadImageA: () => 1, GetStockObject: () => 1, GetSystemMenu: () => 1, AppendMenuA: () => 1,
			DefWindowProcA: () => 0, FindWindowA: () => 0, PostQuitMessage: () => 0, TranslateMessage: () => 0, DispatchMessageA: () => 0, DialogBoxParamA: () => 0, EndDialog: () => 1,
			DdeInitializeA: () => {
				this.w32(this.arg(0), 1);
				this.ddeCallback = this.arg(1);
				return 0;
			},
			DdeCreateStringHandleA: () => this.handle(this.rstr(this.arg(1))),
			DdeFreeStringHandle: () => 1, DdeNameService: () => 1, DdeUninitialize: () => 1,
			DdeCmpStringHandles: () => (this.arg(0) === this.arg(1) ? 0 : 1),
			DdeAccessData: () => {
				const h = this.arg(0);
				const data = this.ddeData.get(h) ?? new Uint8Array(0);
				const buf = this.alloc(data.length + 16);
				this.mem.set(data, buf);
				this.ddeGuest.set(h, buf);
				if (this.arg(1)) this.w32(this.arg(1), data.length);
				return buf;
			},
			DdeUnaccessData: () => {
				this.release(this.ddeGuest.get(this.arg(0)) ?? 0);
				this.ddeGuest.delete(this.arg(0));
				return 1;
			},
			DdeFreeDataHandle: () => {
				this.ddeData.delete(this.arg(0));
				return 1;
			},
			DdeCreateDataHandle: () => {
				const h = (this.nextHandle += 4);
				const src = this.arg(1);
				this.ddeData.set(h, src ? this.mem.slice(src, src + this.arg(2)) : new Uint8Array(0));
				return h;
			},
			DdeAddData: () => {
				const h = this.arg(0);
				const src = this.arg(1);
				const n = this.arg(2);
				const off = this.arg(3);
				let data = this.ddeData.get(h) ?? new Uint8Array(0);
				if (data.length < off + n) {
					// grow geometrically: the program adds its answer four bytes at a time
					const grown = new Uint8Array(Math.max(off + n, data.length * 2, 4096));
					grown.set(data);
					data = grown;
				}
				data.set(this.mem.subarray(src, src + n), off);
				this.ddeData.set(h, data);
				return h;
			},

			// ---- KERNEL32
			GetModuleHandleA: () => this.pe.imageBase, GetModuleHandleW: () => this.pe.imageBase,
			GetStartupInfoA: () => {
				this.mem.fill(0, this.arg(0), this.arg(0) + 68);
				return 0;
			},
			GetCurrentProcess: () => -1, GetCurrentProcessId: () => 4242, GetCurrentThreadId: () => 4243, GetLastError: () => 0,
			SetUnhandledExceptionFilter: () => 0, UnhandledExceptionFilter: () => 0,
			InitializeCriticalSection: () => 0, EnterCriticalSection: () => 0, LeaveCriticalSection: () => 0, DeleteCriticalSection: () => 0,
			TlsGetValue: () => 0, Sleep: () => 0,
			LoadLibraryA: () => {
				this.log.push(`Bibliothek ${this.rstr(this.arg(0))} gibt es hier nicht`);
				return 0;
			},
			GetProcAddress: () => 0, FreeLibrary: () => 1,
			FindFirstChangeNotificationA: () => 0x700, FindCloseChangeNotification: () => 1,
			WaitForSingleObject: () => 0x102, // timeout: nothing changed
			IsDBCSLeadByteEx: () => 0,
			VirtualProtect: () => {
				if (this.arg(3)) this.w32(this.arg(3), 4);
				return 1;
			},
			VirtualQuery: () => {
				const buf = this.arg(1);
				[this.arg(0) & ~0xfff, this.pe.imageBase, 0x40, 0x1000, 0x1000, 0x40, 0x1000000].forEach((v, i) => this.w32(buf + i * 4, v));
				return 28;
			},
			TerminateProcess: () => {
				throw new ProgramExit('Das Steuerungsprogramm hat sich beendet');
			},
			GetCurrentDirectoryA: () => {
				this.wstr(this.arg(1), 'C:\\run');
				return 6;
			},
			GetWindowsDirectoryA: () => {
				this.wstr(this.arg(0), 'C:\\Windows');
				return 10;
			},
			GetTickCount: () => (this.clock * 1000) | 0,
			QueryPerformanceCounter: () => {
				this.dv.setBigUint64(this.arg(0), BigInt(this.clock) * 1000000n, true);
				return 1;
			},
			GetSystemTimeAsFileTime: () => {
				this.dv.setBigUint64(this.arg(0), (BigInt(this.clock) + 11644473600n) * 10000000n, true);
				return 0;
			},
			SystemTimeToTzSpecificLocalTime: () => {
				const src = this.arg(1);
				const g = (i: number): number => this.dv.getUint16(src + i * 2, true);
				const d = new Date(Date.UTC(g(0), g(1) - 1, g(3), g(4), g(5), g(6)) + this.tz * 1000);
				[d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDay(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), g(7)].forEach((v, i) => this.dv.setUint16(this.arg(2) + i * 2, v, true));
				return 1;
			},
			MultiByteToWideChar: () => {
				const src = this.arg(2);
				const n = this.sarg(3);
				const text = n < 0 ? this.rstr(src) + '\0' : dec(this.mem.subarray(src, src + n));
				const cap = this.arg(5);
				for (let i = 0; i < Math.min(cap, text.length); i++) this.dv.setUint16(this.arg(4) + i * 2, text.charCodeAt(i), true);
				return text.length;
			},
			WideCharToMultiByte: () => {
				const src = this.arg(2);
				let n = this.sarg(3);
				if (n < 0) {
					n = 0;
					while (this.dv.getUint16(src + n * 2, true) !== 0) n++;
					n++;
				}
				const cap = this.arg(5);
				for (let i = 0; i < Math.min(cap, n); i++) this.mem[this.arg(4) + i] = this.dv.getUint16(src + i * 2, true) & 0xff;
				return n;
			},
			GetPrivateProfileStringA: () => {
				const cap = this.arg(4);
				const value = (this.iniGet(this.rstr(this.arg(5)), this.rstr(this.arg(0)), this.rstr(this.arg(1))) ?? this.rstr(this.arg(2))).slice(0, Math.max(0, cap - 1));
				this.wstr(this.arg(3), value);
				return value.length;
			},
			GetPrivateProfileIntA: () => {
				const m = /^\s*-?\d+/.exec(this.iniGet(this.rstr(this.arg(3)), this.rstr(this.arg(0)), this.rstr(this.arg(1))) ?? '');
				return m ? +m[0] | 0 : this.sarg(2);
			},
			WritePrivateProfileStringA: () => {
				this.iniSet(this.rstr(this.arg(3)), this.rstr(this.arg(0)), this.rstr(this.arg(1)), this.rstr(this.arg(2)));
				return 1;
			},

			// ---- msvcrt: memory and strings
			malloc: () => this.alloc(Math.max(1, this.arg(0))),
			calloc: () => {
				const n = Math.max(1, this.arg(0) * this.arg(1));
				const a = this.alloc(n);
				this.mem.fill(0, a, a + n);
				return a;
			},
			realloc: () => {
				const old = this.arg(0);
				const n = Math.max(1, this.arg(1));
				const a = this.alloc(n);
				if (old) {
					this.mem.copyWithin(a, old, old + Math.min(this.r32(old - 8), n));
					this.release(old);
				}
				return a;
			},
			free: () => {
				this.release(this.arg(0));
				return 0;
			},
			memcpy: () => {
				this.mem.copyWithin(this.arg(0), this.arg(1), this.arg(1) + this.arg(2));
				return this.arg(0);
			},
			memset: () => {
				this.mem.fill(this.arg(1) & 0xff, this.arg(0), this.arg(0) + this.arg(2));
				return this.arg(0);
			},
			memcmp: () => {
				const a = this.arg(0);
				const b = this.arg(1);
				for (let i = 0; i < this.arg(2); i++) {
					const d = this.mem[a + i] - this.mem[b + i];
					if (d) return d < 0 ? -1 : 1;
				}
				return 0;
			},
			strlen: () => this.strlen(this.arg(0)),
			wcslen: () => {
				let n = 0;
				while (this.dv.getUint16(this.arg(0) + n * 2, true) !== 0) n++;
				return n;
			},
			strcpy: () => {
				const src = this.arg(1);
				this.mem.copyWithin(this.arg(0), src, src + this.strlen(src) + 1);
				return this.arg(0);
			},
			strcat: () => {
				const d = this.arg(0);
				const src = this.arg(1);
				this.mem.copyWithin(d + this.strlen(d), src, src + this.strlen(src) + 1);
				return d;
			},
			strncpy: () => {
				const d = this.arg(0);
				const src = this.arg(1);
				const n = this.arg(2);
				const len = Math.min(n, this.strlen(src));
				this.mem.copyWithin(d, src, src + len);
				this.mem.fill(0, d + len, d + n);
				return d;
			},
			strcmp: () => cmp(this.rstr(this.arg(0)), this.rstr(this.arg(1))),
			strncmp: () => cmp(this.rstr(this.arg(0)).slice(0, this.arg(2)), this.rstr(this.arg(1)).slice(0, this.arg(2))),
			_strnicmp: () => cmp(this.rstr(this.arg(0)).slice(0, this.arg(2)).toLowerCase(), this.rstr(this.arg(1)).slice(0, this.arg(2)).toLowerCase()),
			strchr: () => {
				const a = this.arg(0);
				const c = this.arg(1) & 0xff;
				const len = this.strlen(a);
				if (c === 0) return a + len;
				const i = this.mem.subarray(a, a + len).indexOf(c);
				return i < 0 ? 0 : a + i;
			},
			strstr: () => {
				const i = this.rstr(this.arg(0)).indexOf(this.rstr(this.arg(1)));
				return i < 0 ? 0 : this.arg(0) + i;
			},
			strspn: () => {
				const s = this.rstr(this.arg(0));
				const accept = this.rstr(this.arg(1));
				let n = 0;
				while (n < s.length && accept.includes(s[n])) n++;
				return n;
			},
			_strupr: () => {
				this.wstr(this.arg(0), this.rstr(this.arg(0)).toUpperCase());
				return this.arg(0);
			},
			_strnset: () => {
				const n = Math.min(this.strlen(this.arg(0)), this.arg(2));
				this.mem.fill(this.arg(1) & 0xff, this.arg(0), this.arg(0) + n);
				return this.arg(0);
			},
			toupper: () => chr(0).toUpperCase().charCodeAt(0),
			tolower: () => chr(0).toLowerCase().charCodeAt(0),
			isspace: () => {
				const c = this.arg(0) & 0xff;
				return c === 32 || (c >= 9 && c <= 13) ? 1 : 0;
			},
			isupper: () => (/[A-Z]/.test(chr(0)) ? 1 : 0),
			islower: () => (/[a-z]/.test(chr(0)) ? 1 : 0),
			isprint: () => {
				const c = this.arg(0) & 0xff;
				return c >= 32 && c < 127 ? 1 : 0;
			},
			isxdigit: () => {
				const c = this.arg(0) & 0xff;
				return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102) ? 1 : 0;
			},
			strtol: () => this.strtol(true),
			strtoul: () => this.strtol(false),
			atoi: () => {
				const m = /^\s*[+-]?\d+/.exec(this.rstr(this.arg(0)));
				return m ? +m[0] | 0 : 0;
			},
			_itoa: () => {
				const base = this.arg(2);
				this.wstr(this.arg(1), base === 10 ? String(this.sarg(0)) : this.arg(0).toString(base));
				return this.arg(1);
			},

			// ---- msvcrt: formatted output (most formatting is done by the program's own code)
			sprintf: () => {
				const s = this.format(this.rstr(this.arg(1)), this.cpu.r[4] + 12);
				this.wstr(this.arg(0), s);
				return s.length;
			},
			fprintf: () => this.write(this.arg(0), enc(this.format(this.rstr(this.arg(1)), this.cpu.r[4] + 12))),
			vfprintf: () => this.write(this.arg(0), enc(this.format(this.rstr(this.arg(1)), this.arg(2)))),

			// ---- msvcrt: files
			fopen: () => {
				const name = this.fileName(this.rstr(this.arg(0)));
				const mode = this.rstr(this.arg(1));
				const exists = this.fs.has(name);
				if (mode.includes('r') && !exists) return 0;
				if (mode.includes('w') || !exists) this.fs.set(name, new Uint8Array(0));
				const fp = this.alloc(32);
				this.files.set(fp, { name, pos: 0, append: mode.includes('a'), eof: false, unget: -1 });
				return fp;
			},
			fclose: () => {
				if (this.files.delete(this.arg(0))) this.release(this.arg(0));
				return 0;
			},
			fflush: () => 0,
			feof: () => (this.files.get(this.arg(0))?.eof ? 1 : 0),
			ftell: () => this.files.get(this.arg(0))?.pos ?? -1,
			fseek: () => {
				const file = this.files.get(this.arg(0));
				if (!file) return -1;
				const size = this.fs.get(file.name)?.length ?? 0;
				file.pos = Math.max(0, [0, file.pos, size][this.arg(2)] + this.sarg(1));
				file.eof = false;
				return 0;
			},
			fread: () => {
				const file = this.files.get(this.arg(3));
				const size = this.arg(1);
				const n = this.arg(2);
				if (!file || !size) return 0;
				const data = this.fs.get(file.name) ?? new Uint8Array(0);
				const items = Math.min(n, Math.floor((data.length - file.pos) / size));
				this.mem.set(data.subarray(file.pos, file.pos + items * size), this.arg(0));
				file.pos += items * size;
				if (items < n) file.eof = true;
				return items;
			},
			fwrite: () => {
				const n = this.arg(1) * this.arg(2);
				this.write(this.arg(3), this.mem.slice(this.arg(0), this.arg(0) + n));
				return this.arg(2);
			},
			fputs: () => {
				this.write(this.arg(1), this.mem.slice(this.arg(0), this.arg(0) + this.strlen(this.arg(0))));
				return 0;
			},
			fputc: () => {
				this.write(this.arg(1), Uint8Array.of(this.arg(0) & 0xff));
				return this.arg(0) & 0xff;
			},
			getc: () => {
				const file = this.files.get(this.arg(0));
				if (!file) return -1;
				if (file.unget >= 0) {
					const c = file.unget;
					file.unget = -1;
					return c;
				}
				const data = this.fs.get(file.name)!;
				if (file.pos >= data.length) {
					file.eof = true;
					return -1;
				}
				return data[file.pos++];
			},
			ungetc: () => {
				const file = this.files.get(this.arg(1));
				if (file) {
					file.unget = this.arg(0) & 0xff;
					file.eof = false;
				}
				return this.arg(0);
			},
			fgets: () => {
				const file = this.files.get(this.arg(2));
				const data = file ? this.fs.get(file.name)! : undefined;
				if (!file || !data || file.pos >= data.length) {
					if (file) file.eof = true;
					return 0;
				}
				let end = data.indexOf(10, file.pos);
				end = end < 0 ? data.length : end + 1;
				end = Math.min(end, file.pos + this.arg(1) - 1);
				// text mode: CR LF becomes LF
				let n = 0;
				const buf = this.arg(0);
				for (let i = file.pos; i < end; i++) {
					if (data[i] === 13 && data[i + 1] === 10) continue;
					this.mem[buf + n++] = data[i];
				}
				this.mem[buf + n] = 0;
				file.pos = end;
				return buf;
			},
			_access: () => (this.fs.has(this.fileName(this.rstr(this.arg(0)))) ? 0 : -1),
			remove: () => (this.fs.delete(this.fileName(this.rstr(this.arg(0)))) ? 0 : -1),
			rename: () => {
				const from = this.fileName(this.rstr(this.arg(0)));
				const data = this.fs.get(from);
				if (!data) return -1;
				this.fs.delete(from);
				this.fs.set(this.fileName(this.rstr(this.arg(1))), data);
				return 0;
			},
			_findfirst: () => {
				const pattern = this.fileName(this.rstr(this.arg(0)));
				const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
				for (const [name, data] of this.fs) {
					if (!re.test(name)) continue;
					const out = this.arg(1);
					[0x20, this.clock, this.clock, this.clock, data.length].forEach((v, i) => this.w32(out + i * 4, v));
					this.wstr(out + 20, name);
					return 0x800;
				}
				return -1;
			},
			_close: () => 0,
			_splitpath: () => {
				const m = /^([A-Za-z]:)?(.*[\\/])?([^\\/]*?)(\.[^.\\/]*)?$/.exec(this.rstr(this.arg(0)))!;
				for (let i = 0; i < 4; i++) if (this.arg(1 + i)) this.wstr(this.arg(1 + i), m[i + 1] ?? '');
				return 0;
			},
			_makepath: () => {
				const drive = this.rstr(this.arg(1));
				let dir = this.rstr(this.arg(2));
				const name = this.rstr(this.arg(3));
				let ext = this.rstr(this.arg(4));
				if (dir && !/[\\/]$/.test(dir)) dir += '\\';
				if (ext && !ext.startsWith('.')) ext = '.' + ext;
				this.wstr(this.arg(0), (drive ? drive[0] + ':' : '') + dir + name + ext);
				return 0;
			},

			// ---- msvcrt: time and the rest
			time: () => {
				if (this.arg(0)) this.w32(this.arg(0), this.clock);
				return this.clock | 0;
			},
			localtime: () => this.tmAt(this.r32(this.arg(0)) + this.tz),
			gmtime: () => this.tmAt(this.r32(this.arg(0))),
			mktime: () => {
				const g = (i: number): number => this.dv.getInt32(this.arg(0) + i * 4, true);
				return (Date.UTC(g(5) + 1900, g(4), g(3), g(2), g(1), g(0)) / 1000 - this.tz) | 0;
			},
			getenv: () => 0,
			setlocale: () => this.scratch,
			localeconv: () => this.lconv,
			signal: () => 0,
			_errno: () => this.errno,
			strerror: () => {
				this.wstr(this.scratch + 64, 'error');
				return this.scratch + 64;
			},
			_getpid: () => 4242, _lock: () => 0, _unlock: () => 0, _cexit: () => 0,
			_onexit: () => this.arg(0), __dllonexit: () => this.arg(0),
			_amsg_exit: () => {
				throw new ProgramExit('Das Steuerungsprogramm hat sich mit einem Laufzeitfehler beendet');
			},
			abort: () => {
				throw new ProgramExit('Das Steuerungsprogramm hat abgebrochen');
			},
			exit: () => {
				throw new ProgramExit(`Das Steuerungsprogramm hat sich beendet (Code ${this.sarg(0)})`);
			}
		};
		f.atol = f.atoi;
		f._ltoa = f._itoa;
		return f;
	}
}
