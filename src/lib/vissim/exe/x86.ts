// A small x86 (32-bit, user mode) interpreter – just what 32-bit programs
// built with GCC use: the integer instruction set and the x87 floating point
// unit. No segments, no privileged instructions, no SSE.
//
// Guest memory is one flat buffer indexed by guest address. Instructions are
// decoded once into closures and cached by address (the code does not modify
// itself). Addresses inside the "host range" are not code: reaching one hands
// control to the host (that is how imported functions are provided).
//
// Flags: CF and OF are kept as they are produced, ZF / SF / PF are derived
// from the last result when needed. AF is not modelled (only BCD arithmetic
// reads it).

type Op = () => void;

/** Where an operand lives: a register or memory at an address computed at run time. */
interface Rm {
	reg: number; // register number, or -1 for memory
	ea: (() => number) | null;
}

const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
	let b = i;
	b ^= b >> 4;
	b ^= b >> 2;
	b ^= b >> 1;
	PARITY[i] = (b & 1) ^ 1;
}

export class X86Error extends Error {}

/** An operand as source text: a register, or the expression of a memory address. */
interface RmText {
	reg: number;
	ea: string;
}

function regRead(i: number, size: number): string {
	if (size === 32) return `r[${i}]`;
	if (size === 16) return `(r[${i}]&65535)`;
	return i < 4 ? `(r[${i}]&255)` : `((r[${i - 4}]>>8)&255)`;
}

function regWrite(i: number, size: number, value: string): string {
	if (size === 32) return `r[${i}]=${value};`;
	if (size === 16) return `r[${i}]=(r[${i}]&-65536)|((${value})&65535);`;
	return i < 4 ? `r[${i}]=(r[${i}]&-256)|((${value})&255);` : `r[${i - 4}]=(r[${i - 4}]&-65281)|(((${value})&255)<<8);`;
}

export class X86 {
	readonly mem: Uint8Array;
	readonly dv: DataView;
	/** eax ecx edx ebx esp ebp esi edi */
	readonly r = new Int32Array(8);
	eip = 0;
	cf = 0;
	of = 0;
	df = 0;
	/** last result, sign-extended to 32 bits: source of ZF, SF, PF … */
	lr = 0;
	/** … unless the flags were loaded explicitly (sahf, popf) */
	explicit = false;
	private ezf = 0;
	private esf = 0;
	private epf = 0;
	running = false;
	/** instructions executed (for measurements) */
	count = 0;

	// x87: eight registers as a stack
	private readonly st = new Float64Array(8);
	private top = 0;
	private fcw = 0x37f;
	private fsw = 0; // condition codes C0 C1 C2 C3 (bits 8, 9, 10, 14)

	private readonly code: (Op | undefined)[];
	private p = 0; // decode position

	constructor(
		buffer: ArrayBuffer,
		private readonly codeBase: number,
		codeSize: number,
		private readonly hostLo: number,
		private readonly hostHi: number,
		private readonly host: (address: number) => void
	) {
		this.mem = new Uint8Array(buffer);
		this.dv = new DataView(buffer);
		this.code = new Array<Op | undefined>(codeSize);
	}

	// ------------------------------------------------------------------ memory
	m8(a: number): number {
		return this.mem[a];
	}
	m16(a: number): number {
		return this.dv.getUint16(a, true);
	}
	m32(a: number): number {
		return this.dv.getInt32(a, true);
	}
	w8(a: number, v: number): void {
		this.mem[a] = v;
	}
	w16(a: number, v: number): void {
		this.dv.setUint16(a, v, true);
	}
	w32(a: number, v: number): void {
		this.dv.setInt32(a, v, true);
	}

	push(v: number): void {
		const sp = (this.r[4] - 4) | 0;
		this.r[4] = sp;
		this.dv.setInt32(sp, v, true);
	}
	pop(): number {
		const sp = this.r[4];
		this.r[4] = (sp + 4) | 0;
		return this.dv.getInt32(sp, true);
	}

	// ------------------------------------------------------------------ flags
	zf(): number {
		return this.explicit ? this.ezf : this.lr === 0 ? 1 : 0;
	}
	sf(): number {
		return this.explicit ? this.esf : this.lr < 0 ? 1 : 0;
	}
	pf(): number {
		return this.explicit ? this.epf : PARITY[this.lr & 0xff];
	}
	private setLr(v: number): void {
		this.lr = v;
		this.explicit = false;
	}
	getFlags(): number {
		return this.cf | 2 | (this.pf() << 2) | (this.zf() << 6) | (this.sf() << 7) | (this.df << 10) | (this.of << 11) | 0x200;
	}
	setFlags(f: number): void {
		this.cf = f & 1;
		this.epf = (f >> 2) & 1;
		this.ezf = (f >> 6) & 1;
		this.esf = (f >> 7) & 1;
		this.df = (f >> 10) & 1;
		this.of = (f >> 11) & 1;
		this.explicit = true;
	}

	cond(cc: number): boolean {
		switch (cc) {
			case 0: return this.of === 1;
			case 1: return this.of === 0;
			case 2: return this.cf === 1;
			case 3: return this.cf === 0;
			case 4: return this.zf() === 1;
			case 5: return this.zf() === 0;
			case 6: return this.cf === 1 || this.zf() === 1;
			case 7: return this.cf === 0 && this.zf() === 0;
			case 8: return this.sf() === 1;
			case 9: return this.sf() === 0;
			case 10: return this.pf() === 1;
			case 11: return this.pf() === 0;
			case 12: return this.sf() !== this.of;
			case 13: return this.sf() === this.of;
			case 14: return this.zf() === 1 || this.sf() !== this.of;
			default: return this.zf() === 0 && this.sf() === this.of;
		}
	}

	// ------------------------------------------------------------------ arithmetic (size: 8, 16, 32)
	/** op: 0 add, 1 or, 2 adc, 3 sbb, 4 and, 5 sub, 6 xor, 7 cmp. Returns the result (masked to size). */
	alu(op: number, a: number, b: number, size: number): number {
		if (size === 32) {
			let res: number;
			switch (op) {
				case 0:
					res = (a + b) | 0;
					this.cf = res >>> 0 < a >>> 0 ? 1 : 0;
					this.of = ((a ^ res) & (b ^ res)) < 0 ? 1 : 0;
					break;
				case 2: {
					const s = (a >>> 0) + (b >>> 0) + this.cf;
					res = s | 0;
					this.cf = s > 0xffffffff ? 1 : 0;
					this.of = ((a ^ res) & (b ^ res)) < 0 ? 1 : 0;
					break;
				}
				case 3: {
					const s = (a >>> 0) - (b >>> 0) - this.cf;
					res = s | 0;
					this.cf = s < 0 ? 1 : 0;
					this.of = ((a ^ b) & (a ^ res)) < 0 ? 1 : 0;
					break;
				}
				case 5:
				case 7:
					res = (a - b) | 0;
					this.cf = a >>> 0 < b >>> 0 ? 1 : 0;
					this.of = ((a ^ b) & (a ^ res)) < 0 ? 1 : 0;
					break;
				case 1:
					res = a | b;
					this.cf = this.of = 0;
					break;
				case 4:
					res = a & b;
					this.cf = this.of = 0;
					break;
				default:
					res = a ^ b;
					this.cf = this.of = 0;
			}
			this.lr = res;
			this.explicit = false;
			return res;
		}
		const mask = size === 8 ? 0xff : 0xffff;
		const sign = size === 8 ? 0x80 : 0x8000;
		a &= mask;
		b &= mask;
		let res: number;
		switch (op) {
			case 0:
			case 2: {
				const s = a + b + (op === 2 ? this.cf : 0);
				res = s & mask;
				this.cf = s > mask ? 1 : 0;
				this.of = (a ^ res) & (b ^ res) & sign ? 1 : 0;
				break;
			}
			case 3:
			case 5:
			case 7: {
				const s = a - b - (op === 3 ? this.cf : 0);
				res = s & mask;
				this.cf = s < 0 ? 1 : 0;
				this.of = (a ^ b) & (a ^ res) & sign ? 1 : 0;
				break;
			}
			case 1:
				res = a | b;
				this.cf = this.of = 0;
				break;
			case 4:
				res = a & b;
				this.cf = this.of = 0;
				break;
			default:
				res = a ^ b;
				this.cf = this.of = 0;
		}
		this.lr = size === 8 ? (res << 24) >> 24 : (res << 16) >> 16;
		this.explicit = false;
		return res;
	}

	/** op: 0 rol, 1 ror, 2 rcl, 3 rcr, 4 shl, 5 shr, 6 sal, 7 sar */
	shift(op: number, a: number, count: number, size: number): number {
		count &= 31;
		const mask = size === 32 ? 0xffffffff : size === 16 ? 0xffff : 0xff;
		const ua = size === 32 ? a >>> 0 : a & mask;
		if (count === 0) return ua;
		let res: number;
		switch (op) {
			case 4:
			case 6:
				if (size === 32) {
					res = (ua << count) >>> 0;
					this.cf = (ua >>> (32 - count)) & 1;
				} else {
					const wide = ua << count;
					res = wide & mask;
					this.cf = (wide >> size) & 1;
				}
				this.of = ((res >>> (size - 1)) & 1) ^ this.cf;
				break;
			case 5:
				res = ua >>> count;
				this.cf = (ua >>> (count - 1)) & 1;
				this.of = (ua >>> (size - 1)) & 1;
				break;
			case 7: {
				const s = size === 32 ? a | 0 : size === 16 ? (a << 16) >> 16 : (a << 24) >> 24;
				res = (s >> count) & mask;
				if (size === 32) res >>>= 0;
				this.cf = (s >> (count - 1)) & 1;
				this.of = 0;
				break;
			}
			case 0: {
				const c = count % size;
				res = c ? ((ua << c) | (ua >>> (size - c))) & mask : ua;
				if (size === 32) res >>>= 0;
				this.cf = res & 1;
				this.of = ((res >>> (size - 1)) & 1) ^ this.cf;
				return res; // rotates leave ZF / SF / PF alone
			}
			case 1: {
				const c = count % size;
				res = c ? ((ua >>> c) | (ua << (size - c))) & mask : ua;
				if (size === 32) res >>>= 0;
				this.cf = (res >>> (size - 1)) & 1;
				this.of = ((res >>> (size - 1)) ^ (res >>> (size - 2))) & 1;
				return res;
			}
			default:
				throw new X86Error(`rotate through carry (${op}) is not implemented`);
		}
		this.lr = size === 32 ? res | 0 : size === 16 ? (res << 16) >> 16 : (res << 24) >> 24;
		this.explicit = false;
		return res;
	}

	// ------------------------------------------------------------------ registers by size
	private g8(i: number): number {
		return i < 4 ? this.r[i] & 0xff : (this.r[i - 4] >> 8) & 0xff;
	}
	private s8(i: number, v: number): void {
		if (i < 4) this.r[i] = (this.r[i] & ~0xff) | (v & 0xff);
		else this.r[i - 4] = (this.r[i - 4] & ~0xff00) | ((v & 0xff) << 8);
	}
	private s16(i: number, v: number): void {
		this.r[i] = (this.r[i] & ~0xffff) | (v & 0xffff);
	}

	// ------------------------------------------------------------------ decoding helpers
	private i8(): number {
		const v = (this.mem[this.p] << 24) >> 24;
		this.p++;
		return v;
	}
	private u8(): number {
		return this.mem[this.p++];
	}
	private i16(): number {
		const v = this.dv.getInt16(this.p, true);
		this.p += 2;
		return v;
	}
	private i32(): number {
		const v = this.dv.getInt32(this.p, true);
		this.p += 4;
		return v;
	}

	/** Decodes a ModRM byte (and SIB / displacement). Returns the reg field and the r/m operand. */
	private modrm(): { reg: number; rm: Rm } {
		const b = this.u8();
		const mod = b >> 6;
		const reg = (b >> 3) & 7;
		const rmField = b & 7;
		const r = this.r;
		if (mod === 3) return { reg, rm: { reg: rmField, ea: null } };
		let ea: () => number;
		if (rmField === 4) {
			const sib = this.u8();
			const scale = sib >> 6;
			const index = (sib >> 3) & 7;
			const base = sib & 7;
			let disp = 0;
			const noBase = base === 5 && mod === 0;
			if (noBase) disp = this.i32();
			else if (mod === 1) disp = this.i8();
			else if (mod === 2) disp = this.i32();
			if (index === 4) ea = noBase ? () => disp : disp === 0 ? () => r[base] : () => (r[base] + disp) | 0;
			else if (noBase) ea = () => ((r[index] << scale) + disp) | 0;
			else if (disp === 0) ea = () => (r[base] + (r[index] << scale)) | 0;
			else ea = () => (r[base] + (r[index] << scale) + disp) | 0;
		} else if (mod === 0) {
			if (rmField === 5) {
				const disp = this.i32();
				ea = () => disp;
			} else ea = () => r[rmField];
		} else {
			const disp = mod === 1 ? this.i8() : this.i32();
			ea = () => (r[rmField] + disp) | 0;
		}
		return { reg, rm: { reg: -1, ea } };
	}

	/** Reader of an operand of the given size (register values are zero-extended for 8 / 16 bit). */
	private getter(rm: Rm, size: number): () => number {
		const r = this.r;
		const dv = this.dv;
		const mem = this.mem;
		if (rm.reg >= 0) {
			const i = rm.reg;
			if (size === 32) return () => r[i];
			if (size === 16) return () => r[i] & 0xffff;
			return i < 4 ? () => r[i] & 0xff : () => (r[i - 4] >> 8) & 0xff;
		}
		const ea = rm.ea!;
		if (size === 32) return () => dv.getInt32(ea(), true);
		if (size === 16) return () => dv.getUint16(ea(), true);
		return () => mem[ea()];
	}

	private setter(rm: Rm, size: number): (v: number) => void {
		const r = this.r;
		const dv = this.dv;
		const mem = this.mem;
		if (rm.reg >= 0) {
			const i = rm.reg;
			if (size === 32) return (v) => void (r[i] = v);
			if (size === 16) return (v) => void (r[i] = (r[i] & ~0xffff) | (v & 0xffff));
			return i < 4 ? (v) => void (r[i] = (r[i] & ~0xff) | (v & 0xff)) : (v) => void (r[i - 4] = (r[i - 4] & ~0xff00) | ((v & 0xff) << 8));
		}
		const ea = rm.ea!;
		if (size === 32) return (v) => dv.setInt32(ea(), v, true);
		if (size === 16) return (v) => dv.setUint16(ea(), v, true);
		return (v) => void (mem[ea()] = v);
	}

	/** Read-modify-write on an operand: the address is computed once. */
	private modify(rm: Rm, size: number, f: (v: number) => number): Op {
		if (rm.reg >= 0) {
			const get = this.getter(rm, size);
			const set = this.setter(rm, size);
			return () => set(f(get()));
		}
		const ea = rm.ea!;
		const dv = this.dv;
		const mem = this.mem;
		if (size === 32)
			return () => {
				const a = ea();
				dv.setInt32(a, f(dv.getInt32(a, true)), true);
			};
		if (size === 16)
			return () => {
				const a = ea();
				dv.setUint16(a, f(dv.getUint16(a, true)), true);
			};
		return () => {
			const a = ea();
			mem[a] = f(mem[a]);
		};
	}

	// ------------------------------------------------------------------ x87
	private fpush(v: number): void {
		this.top = (this.top - 1) & 7;
		this.st[this.top] = v;
	}
	private fpop(): number {
		const v = this.st[this.top];
		this.top = (this.top + 1) & 7;
		return v;
	}
	private fget(i: number): number {
		return this.st[(this.top + i) & 7];
	}
	private fset(i: number, v: number): void {
		this.st[(this.top + i) & 7] = v;
	}
	private fcompare(a: number, b: number): void {
		// C3 C2 C0: unordered 111, a < b 001, a = b 100, a > b 000
		let cc = 0;
		if (Number.isNaN(a) || Number.isNaN(b)) cc = 0x4500;
		else if (a < b) cc = 0x100;
		else if (a === b) cc = 0x4000;
		this.fsw = (this.fsw & ~0x4700) | cc;
	}
	private fcomi(a: number, b: number): void {
		this.explicit = true;
		this.of = 0;
		this.esf = 0;
		if (Number.isNaN(a) || Number.isNaN(b)) this.ezf = this.epf = this.cf = 1;
		else {
			this.ezf = a === b ? 1 : 0;
			this.epf = 0;
			this.cf = a < b ? 1 : 0;
		}
	}
	/** Rounds like the FPU is set to (control word bits 10–11). */
	private fround(v: number): number {
		switch ((this.fcw >> 10) & 3) {
			case 1: return Math.floor(v);
			case 2: return Math.ceil(v);
			case 3: return Math.trunc(v);
			default: {
				// to nearest, ties to even
				const f = Math.floor(v);
				const d = v - f;
				if (d < 0.5) return f;
				if (d > 0.5) return f + 1;
				return f % 2 === 0 ? f : f + 1;
			}
		}
	}
	/** 80-bit extended precision at address a → number. */
	private fld80(a: number): number {
		const lo = this.dv.getUint32(a, true);
		const hi = this.dv.getUint32(a + 4, true);
		const se = this.dv.getUint16(a + 8, true);
		const sign = se & 0x8000 ? -1 : 1;
		const exp = se & 0x7fff;
		const mant = hi * 4294967296 + lo;
		if (exp === 0 && mant === 0) return sign * 0;
		if (exp === 0x7fff) return hi === 0x80000000 && lo === 0 ? sign * Infinity : NaN;
		return sign * mant * Math.pow(2, exp - 16383 - 63);
	}
	private fst80(a: number, v: number): void {
		let se = 0;
		let hi = 0;
		let lo = 0;
		if (Number.isNaN(v)) {
			se = 0x7fff;
			hi = 0xc0000000;
		} else if (v === 0) {
			se = Object.is(v, -0) ? 0x8000 : 0;
		} else if (!Number.isFinite(v)) {
			se = (v < 0 ? 0x8000 : 0) | 0x7fff;
			hi = 0x80000000;
		} else {
			const abs = Math.abs(v);
			let e = Math.floor(Math.log2(abs));
			let m = abs / Math.pow(2, e);
			if (m >= 2) {
				m /= 2;
				e++;
			} else if (m < 1) {
				m *= 2;
				e--;
			}
			se = (v < 0 ? 0x8000 : 0) | ((e + 16383) & 0x7fff);
			const scaled = m * 2147483648; // 2^31: integer part = high 32 bits
			hi = Math.floor(scaled);
			lo = Math.floor((scaled - hi) * 4294967296);
		}
		this.dv.setUint32(a, lo >>> 0, true);
		this.dv.setUint32(a + 4, hi >>> 0, true);
		this.dv.setUint16(a + 8, se, true);
	}

	private x87(opcode: number): Op {
		const start = this.p;
		const b = this.mem[this.p];
		if (b >= 0xc0) {
			this.p++;
			const i = b & 7;
			const g = (b >> 3) & 7;
			const arith = (op: number, a: number, c: number): number => (op === 0 ? a + c : op === 1 ? a * c : op === 4 ? a - c : op === 5 ? c - a : op === 6 ? a / c : c / a);
			switch (opcode) {
				case 0xd8: // op st0, st(i)
					if (g === 2) return () => this.fcompare(this.fget(0), this.fget(i));
					if (g === 3)
						return () => {
							this.fcompare(this.fget(0), this.fget(i));
							this.fpop();
						};
					return () => this.fset(0, arith(g, this.fget(0), this.fget(i)));
				case 0xd9:
					if (g === 0) return () => this.fpush(this.fget(i)); // fld st(i)
					if (g === 1)
						return () => {
							const t = this.fget(0);
							this.fset(0, this.fget(i));
							this.fset(i, t);
						};
					switch (b) {
						case 0xd0: return () => {}; // fnop
						case 0xe0: return () => this.fset(0, -this.fget(0));
						case 0xe1: return () => this.fset(0, Math.abs(this.fget(0)));
						case 0xe4: return () => this.fcompare(this.fget(0), 0);
						case 0xe5: return () => {
							// fxam: class of st0 in C3 C2 C0, sign in C1
							const v = this.fget(0);
							let cc = Number.isNaN(v) ? 0x100 : v === 0 ? 0x4000 : !Number.isFinite(v) ? 0x500 : 0x400;
							if (v < 0 || Object.is(v, -0)) cc |= 0x200;
							this.fsw = (this.fsw & ~0x4700) | cc;
						};
						case 0xe8: return () => this.fpush(1);
						case 0xe9: return () => this.fpush(Math.log2(10));
						case 0xea: return () => this.fpush(Math.LOG2E);
						case 0xeb: return () => this.fpush(Math.PI);
						case 0xec: return () => this.fpush(Math.log10(2));
						case 0xed: return () => this.fpush(Math.LN2);
						case 0xee: return () => this.fpush(0);
						case 0xf0: return () => this.fset(0, Math.pow(2, this.fget(0)) - 1);
						case 0xf1: return () => {
							const x = this.fpop();
							this.fset(0, this.fget(0) * Math.log2(x));
						};
						case 0xf8: return () => {
							// fprem: remainder, truncating division
							const a = this.fget(0);
							const c = this.fget(1);
							this.fset(0, a - c * Math.trunc(a / c));
							this.fsw &= ~0x400;
						};
						case 0xfa: return () => this.fset(0, Math.sqrt(this.fget(0)));
						case 0xfc: return () => this.fset(0, this.fround(this.fget(0)));
						case 0xfd: return () => this.fset(0, this.fget(0) * Math.pow(2, Math.trunc(this.fget(1))));
						case 0xfe: return () => this.fset(0, Math.sin(this.fget(0)));
						case 0xff: return () => this.fset(0, Math.cos(this.fget(0)));
					}
					break;
				case 0xda:
					if (b === 0xe9)
						return () => {
							this.fcompare(this.fget(0), this.fget(1));
							this.fpop();
							this.fpop();
						};
					if (g < 4) {
						const cc = [2, 4, 6, 10][g]; // fcmovb / e / be / u
						return () => {
							if (this.cond(cc)) this.fset(0, this.fget(i));
						};
					}
					break;
				case 0xdb:
					if (g < 4) {
						const cc = [3, 5, 7, 11][g]; // fcmovnb / ne / nbe / nu
						return () => {
							if (this.cond(cc)) this.fset(0, this.fget(i));
						};
					}
					if (b === 0xe2) return () => void (this.fsw &= 0x7f00); // fnclex
					if (b === 0xe3) return () => {
						this.fcw = 0x37f;
						this.fsw = 0;
						this.top = 0;
					};
					if (g === 5 || g === 6) return () => this.fcomi(this.fget(0), this.fget(i)); // fucomi / fcomi
					break;
				case 0xdc: // op st(i), st0 (sub / div reversed in the encoding)
					return () => this.fset(i, arith(g === 4 ? 5 : g === 5 ? 4 : g === 6 ? 7 : g === 7 ? 6 : g, this.fget(i), this.fget(0)));
				case 0xdd:
					if (g === 0) return () => {}; // ffree
					if (g === 2) return () => this.fset(i, this.fget(0)); // fst st(i)
					if (g === 3)
						return () => {
							this.fset(i, this.fget(0));
							this.fpop();
						};
					if (g === 4) return () => this.fcompare(this.fget(0), this.fget(i)); // fucom
					if (g === 5)
						return () => {
							this.fcompare(this.fget(0), this.fget(i));
							this.fpop();
						};
					break;
				case 0xde:
					if (b === 0xd9)
						return () => {
							this.fcompare(this.fget(0), this.fget(1));
							this.fpop();
							this.fpop();
						};
					return () => {
						this.fset(i, arith(g === 4 ? 5 : g === 5 ? 4 : g === 6 ? 7 : g === 7 ? 6 : g, this.fget(i), this.fget(0)));
						this.fpop();
					};
				case 0xdf:
					if (b === 0xe0) return () => this.s16(0, (this.fsw & ~0x3800) | (this.top << 11)); // fnstsw ax
					if (g === 5 || g === 6)
						return () => {
							this.fcomi(this.fget(0), this.fget(i));
							this.fpop();
						};
					break;
			}
			throw new X86Error(`x87 instruction ${opcode.toString(16)} ${b.toString(16)} at ${start.toString(16)} is not implemented`);
		}
		const { reg: g, rm } = this.modrm();
		const ea = rm.ea!;
		const dv = this.dv;
		const arith = (op: number, a: number, c: number): number => (op === 0 ? a + c : op === 1 ? a * c : op === 4 ? a - c : op === 5 ? c - a : op === 6 ? a / c : c / a);
		const withOperand = (read: (a: number) => number): Op => {
			if (g === 2) return () => this.fcompare(this.fget(0), read(ea()));
			if (g === 3)
				return () => {
					this.fcompare(this.fget(0), read(ea()));
					this.fpop();
				};
			return () => this.fset(0, arith(g, this.fget(0), read(ea())));
		};
		const toInt = (v: number, bits: number): number => {
			const x = this.fround(v);
			const limit = Math.pow(2, bits - 1);
			return Number.isNaN(x) || x >= limit || x < -limit ? -limit : x;
		};
		switch (opcode) {
			case 0xd8: return withOperand((a) => dv.getFloat32(a, true));
			case 0xdc: return withOperand((a) => dv.getFloat64(a, true));
			case 0xda: return withOperand((a) => dv.getInt32(a, true));
			case 0xde: return withOperand((a) => dv.getInt16(a, true));
			case 0xd9:
				switch (g) {
					case 0: return () => this.fpush(dv.getFloat32(ea(), true));
					case 2: return () => dv.setFloat32(ea(), this.fget(0), true);
					case 3: return () => dv.setFloat32(ea(), this.fpop(), true);
					case 5: return () => void (this.fcw = dv.getUint16(ea(), true));
					case 7: return () => dv.setUint16(ea(), this.fcw, true);
				}
				break;
			case 0xdb:
				switch (g) {
					case 0: return () => this.fpush(dv.getInt32(ea(), true));
					case 1: return () => dv.setInt32(ea(), Math.trunc(this.fpop()) | 0, true); // fisttp
					case 2: return () => dv.setInt32(ea(), toInt(this.fget(0), 32), true);
					case 3: return () => dv.setInt32(ea(), toInt(this.fpop(), 32), true);
					case 5: return () => this.fpush(this.fld80(ea()));
					case 7: return () => this.fst80(ea(), this.fpop());
				}
				break;
			case 0xdd:
				switch (g) {
					case 0: return () => this.fpush(dv.getFloat64(ea(), true));
					case 2: return () => dv.setFloat64(ea(), this.fget(0), true);
					case 3: return () => dv.setFloat64(ea(), this.fpop(), true);
					case 7: return () => dv.setUint16(ea(), (this.fsw & ~0x3800) | (this.top << 11), true);
				}
				break;
			case 0xdf:
				switch (g) {
					case 0: return () => this.fpush(dv.getInt16(ea(), true));
					case 2: return () => dv.setInt16(ea(), toInt(this.fget(0), 16), true);
					case 3: return () => dv.setInt16(ea(), toInt(this.fpop(), 16), true);
					case 5: return () => {
						const a = ea();
						this.fpush(dv.getInt32(a + 4, true) * 4294967296 + dv.getUint32(a, true));
					};
					case 7: return () => {
						const a = ea();
						const v = this.fround(this.fpop());
						const big = BigInt.asIntN(64, BigInt(Number.isFinite(v) ? v : 0));
						dv.setBigInt64(a, big, true);
					};
				}
				break;
		}
		throw new X86Error(`x87 instruction ${opcode.toString(16)} /${g} at ${start.toString(16)} is not implemented`);
	}

	// ------------------------------------------------------------------ instruction decoder
	/** Compiles the straight-line run of instructions starting at pc into one
	 * function. The common instructions become JavaScript source (so the
	 * engine's own compiler can optimise the whole run); the rare ones are
	 * called as closures from the generated code. */
	private compile(pc: number): Op {
		const fallbacks: Op[] = [];
		let js = '';
		let at = pc;
		let n = 0;
		for (;;) {
			this.p = at;
			let size = 32;
			let rep = 0; // 0xf3 or 0xf2
			for (;;) {
				const pre = this.mem[this.p];
				if (pre === 0x66) size = 16;
				else if (pre === 0xf3 || pre === 0xf2) rep = pre;
				else if (pre === 0x2e || pre === 0x36 || pre === 0x3e || pre === 0x26 || pre === 0xf0) {
					/* segment overrides of the flat segments and lock: no effect here */
				} else break;
				this.p++;
			}
			const opcode = this.u8();
			const second = this.mem[this.p];
			const afterOpcode = this.p;
			const text = this.emit(opcode, size, at);
			if (text !== null) js += text;
			else {
				this.p = afterOpcode;
				fallbacks.push(this.decode(opcode, size, rep, at));
				js += `c.eip=${this.p};f[${fallbacks.length - 1}]();`;
			}
			n++;
			at = this.p;
			const ends =
				(opcode >= 0x70 && opcode < 0x80) || opcode === 0xe8 || opcode === 0xe9 || opcode === 0xeb || opcode === 0xe3 || opcode === 0xc2 || opcode === 0xc3 || opcode === 0xcc ||
				(opcode === 0xff && ((second >> 3) & 7) >= 2 && ((second >> 3) & 7) <= 5) || (opcode === 0x0f && second >= 0x80 && second < 0x90);
			if (ends) break;
			if (n >= 64) {
				js += `c.eip=${at};`;
				break;
			}
		}
		const fn = new Function('c', 'r', 'dv', 'mem', 'f', `c.count+=${n};${js}`) as (c: X86, r: Int32Array, dv: DataView, mem: Uint8Array, f: Op[]) => void;
		const r = this.r;
		const dv = this.dv;
		const mem = this.mem;
		return () => fn(this, r, dv, mem, fallbacks);
	}

	// ---- source text of operands
	private rd(rm: RmText, size: number): string {
		if (rm.reg >= 0) return regRead(rm.reg, size);
		return size === 32 ? `dv.getInt32(${rm.ea},true)` : size === 16 ? `dv.getUint16(${rm.ea},true)` : `mem[${rm.ea}]`;
	}
	private wr(rm: RmText, size: number, value: string): string {
		if (rm.reg >= 0) return regWrite(rm.reg, size, value);
		return size === 32 ? `dv.setInt32(${rm.ea},${value},true);` : size === 16 ? `dv.setUint16(${rm.ea},${value},true);` : `mem[${rm.ea}]=${value};`;
	}
	/** Read-modify-write: `f` gets the expression of the old value and returns the statement(s) that
	 * end with the new value in `v`. The address is computed once. */
	private rmw(rm: RmText, size: number, f: (old: string) => string): string {
		if (rm.reg >= 0) return `{${f(regRead(rm.reg, size))}${regWrite(rm.reg, size, 'v')}}`;
		const old = size === 32 ? 'dv.getInt32(a,true)' : size === 16 ? 'dv.getUint16(a,true)' : 'mem[a]';
		const store = size === 32 ? 'dv.setInt32(a,v,true);' : size === 16 ? 'dv.setUint16(a,v,true);' : 'mem[a]=v;';
		return `{const a=${rm.ea};${f(old)}${store}}`;
	}

	private modrmText(): { reg: number; rm: RmText } {
		const b = this.u8();
		const mod = b >> 6;
		const reg = (b >> 3) & 7;
		const rmField = b & 7;
		if (mod === 3) return { reg, rm: { reg: rmField, ea: '' } };
		const parts: string[] = [];
		let disp = 0;
		if (rmField === 4) {
			const sib = this.u8();
			const scale = sib >> 6;
			const index = (sib >> 3) & 7;
			const base = sib & 7;
			const noBase = base === 5 && mod === 0;
			if (!noBase) parts.push(`r[${base}]`);
			if (index !== 4) parts.push(scale ? `(r[${index}]<<${scale})` : `r[${index}]`);
			if (noBase) disp = this.i32();
			else if (mod === 1) disp = this.i8();
			else if (mod === 2) disp = this.i32();
		} else if (mod === 0) {
			if (rmField === 5) disp = this.i32();
			else parts.push(`r[${rmField}]`);
		} else {
			parts.push(`r[${rmField}]`);
			disp = mod === 1 ? this.i8() : this.i32();
		}
		if (disp !== 0 || !parts.length) parts.push(disp < 0 ? `(${disp})` : `${disp}`);
		return { reg, rm: { reg: -1, ea: parts.length === 1 ? parts[0] : `(${parts.join('+')}|0)` } };
	}

	/** Statements that compute `v` = a OP b with the flags (op as in `alu`). */
	private aluText(op: number, a: string, b: string, size: number): string {
		if (size === 32) {
			const flags = 'c.lr=v;c.explicit=false;';
			switch (op) {
				case 0: return `const t=${a},u=${b},v=(t+u)|0;c.cf=(v>>>0)<(t>>>0)?1:0;c.of=((t^v)&(u^v))<0?1:0;${flags}`;
				case 5:
				case 7: return `const t=${a},u=${b},v=(t-u)|0;c.cf=(t>>>0)<(u>>>0)?1:0;c.of=((t^u)&(t^v))<0?1:0;${flags}`;
				case 1: return `const v=${a}|${b};c.cf=c.of=0;${flags}`;
				case 4: return `const v=${a}&${b};c.cf=c.of=0;${flags}`;
				case 6: return `const v=${a}^${b};c.cf=c.of=0;${flags}`;
			}
		}
		return `const v=c.alu(${op},${a},${b},${size});`;
	}

	private condText(cc: number): string {
		switch (cc) {
			case 0: return 'c.of===1';
			case 1: return 'c.of===0';
			case 2: return 'c.cf===1';
			case 3: return 'c.cf===0';
			case 4: return '(c.explicit?c.zf()===1:c.lr===0)';
			case 5: return '(c.explicit?c.zf()===0:c.lr!==0)';
			case 6: return '(c.cf===1||c.zf()===1)';
			case 7: return '(c.cf===0&&c.zf()===0)';
			case 8: return 'c.sf()===1';
			case 9: return 'c.sf()===0';
			case 10: return 'c.pf()===1';
			case 11: return 'c.pf()===0';
			case 12: return 'c.sf()!==c.of';
			case 13: return 'c.sf()===c.of';
			case 14: return '(c.zf()===1||c.sf()!==c.of)';
			default: return '(c.zf()===0&&c.sf()===c.of)';
		}
	}

	/** JavaScript source of one instruction, or null when it is left to the closure decoder.
	 * `this.p` stands behind the opcode byte and is advanced over the operands. */
	private emit(opcode: number, size: number, pc: number): string | null {
		const push = (value: string): string => `{const s=(r[4]-4)|0;r[4]=s;dv.setInt32(s,${value},true);}`;
		// ---- ALU: op r/m, r | op r, r/m | op al/eax, imm
		if (opcode < 0x40 && (opcode & 7) < 6) {
			const op = opcode >> 3;
			const form = opcode & 7;
			const sz = form & 1 ? size : 8;
			if (form < 4) {
				const { reg, rm } = this.modrmText();
				const regRm: RmText = { reg, ea: '' };
				const dst = form < 2 ? rm : regRm;
				const src = this.rd(form < 2 ? regRm : rm, sz);
				if (op === 7) return `{${this.aluText(7, this.rd(dst, sz), src, sz)}}`;
				return this.rmw(dst, sz, (old) => this.aluText(op, old, src, sz));
			}
			const imm = sz === 8 ? this.u8() : sz === 16 ? this.i16() : this.i32();
			if (op === 7) return `{${this.aluText(7, regRead(0, sz), `${imm}`, sz)}}`;
			return this.rmw({ reg: 0, ea: '' }, sz, (old) => this.aluText(op, old, `${imm}`, sz));
		}
		if (opcode >= 0x40 && opcode < 0x50) {
			if (size !== 32) return null;
			const i = opcode & 7;
			return opcode < 0x48
				? `{const v=(r[${i}]+1)|0;r[${i}]=v;c.of=v===-2147483648?1:0;c.lr=v;c.explicit=false;}`
				: `{const v=(r[${i}]-1)|0;r[${i}]=v;c.of=v===2147483647?1:0;c.lr=v;c.explicit=false;}`;
		}
		if (opcode >= 0x50 && opcode < 0x58) return `{const t=r[${opcode & 7}],s=(r[4]-4)|0;r[4]=s;dv.setInt32(s,t,true);}`;
		if (opcode >= 0x58 && opcode < 0x60) return `{const s=r[4];r[4]=(s+4)|0;r[${opcode & 7}]=dv.getInt32(s,true);}`;
		if (opcode >= 0x70 && opcode < 0x80) {
			const rel = this.i8();
			return `c.eip=${this.condText(opcode & 15)}?${(this.p + rel) | 0}:${this.p};`;
		}
		if (opcode >= 0xb0 && opcode < 0xb8) return regWrite(opcode & 7, 8, `${this.u8()}`);
		if (opcode >= 0xb8 && opcode < 0xc0) return size === 16 ? regWrite(opcode & 7, 16, `${this.i16()}`) : `r[${opcode & 7}]=${this.i32()};`;

		switch (opcode) {
			case 0x0f: {
				const second = this.u8();
				if (second >= 0x80 && second < 0x90) {
					const rel = this.i32();
					return `c.eip=${this.condText(second & 15)}?${(this.p + rel) | 0}:${this.p};`;
				}
				if (second >= 0x90 && second < 0xa0) {
					const { rm } = this.modrmText();
					return this.wr(rm, 8, `(${this.condText(second & 15)}?1:0)`);
				}
				if (second >= 0x40 && second < 0x50) {
					const { reg, rm } = this.modrmText();
					return `{const t=${this.rd(rm, size)};if(${this.condText(second & 15)}){${regWrite(reg, size, 't')}}}`;
				}
				if (second === 0xb6 || second === 0xb7 || second === 0xbe || second === 0xbf) {
					const from = second & 1 ? 16 : 8;
					const { reg, rm } = this.modrmText();
					const value = this.rd(rm, from);
					return regWrite(reg, size, second < 0xbe ? value : from === 8 ? `((${value}<<24)>>24)` : `((${value}<<16)>>16)`);
				}
				if (second === 0xaf && size === 32) {
					const { reg, rm } = this.modrmText();
					return `r[${reg}]=Math.imul(r[${reg}],${this.rd(rm, 32)});c.cf=c.of=0;`;
				}
				return null;
			}
			case 0x68: return push(`${this.i32()}`);
			case 0x6a: return push(`${this.i8()}`);
			case 0x69:
			case 0x6b: {
				if (size !== 32) return null;
				const { reg, rm } = this.modrmText();
				const src = this.rd(rm, 32);
				const imm = opcode === 0x6b ? this.i8() : this.i32();
				return `r[${reg}]=Math.imul(${src},${imm});c.cf=c.of=0;`;
			}
			case 0x80:
			case 0x81:
			case 0x83: {
				const sz = opcode === 0x80 ? 8 : size;
				const { reg: op, rm } = this.modrmText();
				const imm = opcode === 0x81 ? (sz === 16 ? this.i16() : this.i32()) : this.i8();
				if (op === 7) return `{${this.aluText(7, this.rd(rm, sz), `${imm}`, sz)}}`;
				return this.rmw(rm, sz, (old) => this.aluText(op, old, `${imm}`, sz));
			}
			case 0x84:
			case 0x85: {
				const sz = opcode === 0x84 ? 8 : size;
				const { reg, rm } = this.modrmText();
				return `{${this.aluText(4, this.rd(rm, sz), regRead(reg, sz), sz)}}`;
			}
			case 0x88:
			case 0x89: {
				const sz = opcode === 0x88 ? 8 : size;
				const { reg, rm } = this.modrmText();
				return this.wr(rm, sz, regRead(reg, sz));
			}
			case 0x8a:
			case 0x8b: {
				const sz = opcode === 0x8a ? 8 : size;
				const { reg, rm } = this.modrmText();
				return regWrite(reg, sz, this.rd(rm, sz));
			}
			case 0x8d: {
				const { reg, rm } = this.modrmText();
				if (rm.reg >= 0) return null;
				return `r[${reg}]=${rm.ea};`;
			}
			case 0x90: return '';
			case 0x98: return size === 32 ? 'r[0]=(r[0]<<16)>>16;' : null;
			case 0x99: return size === 32 ? 'r[2]=r[0]>>31;' : null;
			case 0xa1: {
				if (size !== 32) return null;
				return `r[0]=dv.getInt32(${this.i32()},true);`;
			}
			case 0xa3: {
				if (size !== 32) return null;
				return `dv.setInt32(${this.i32()},r[0],true);`;
			}
			case 0xc0:
			case 0xc1:
			case 0xd0:
			case 0xd1:
			case 0xd2:
			case 0xd3: {
				const sz = opcode & 1 ? size : 8;
				const { reg: op, rm } = this.modrmText();
				const count = opcode < 0xd0 ? `${this.u8()}` : opcode < 0xd2 ? '1' : 'r[1]';
				return this.rmw(rm, sz, (old) => `const v=c.shift(${op},${old},${count},${sz});`);
			}
			case 0xc2: {
				const n = this.i16() & 0xffff;
				return `{const s=r[4];r[4]=(s+${4 + n})|0;c.eip=dv.getInt32(s,true);}`;
			}
			case 0xc3: return '{const s=r[4];r[4]=(s+4)|0;c.eip=dv.getInt32(s,true);}';
			case 0xc6:
			case 0xc7: {
				const sz = opcode === 0xc6 ? 8 : size;
				const { rm } = this.modrmText();
				const imm = sz === 8 ? this.u8() : sz === 16 ? this.i16() : this.i32();
				return this.wr(rm, sz, `${imm}`);
			}
			case 0xc9: return '{const s=r[5];r[5]=dv.getInt32(s,true);r[4]=(s+4)|0;}';
			case 0xe8: {
				const rel = this.i32();
				return `{const s=(r[4]-4)|0;r[4]=s;dv.setInt32(s,${this.p},true);c.eip=${(this.p + rel) | 0};}`;
			}
			case 0xe9: {
				const rel = this.i32();
				return `c.eip=${(this.p + rel) | 0};`;
			}
			case 0xeb: {
				const rel = this.i8();
				return `c.eip=${(this.p + rel) | 0};`;
			}
			case 0xf6:
			case 0xf7: {
				const sz = opcode === 0xf6 ? 8 : size;
				const kind = (this.mem[this.p] >> 3) & 7;
				if (kind > 3) return null; // mul, imul, div, idiv
				const { rm } = this.modrmText();
				if (kind < 2) {
					const imm = sz === 8 ? this.u8() : sz === 16 ? this.i16() : this.i32();
					return `{${this.aluText(4, this.rd(rm, sz), `${imm}`, sz)}}`;
				}
				if (kind === 2) return this.rmw(rm, sz, (old) => `const v=~${old};`);
				return this.rmw(rm, sz, (old) => this.aluText(5, '0', old, sz));
			}
			case 0xfe:
			case 0xff: {
				const sz = opcode === 0xfe ? 8 : size;
				const { reg: op, rm } = this.modrmText();
				if (op < 2) return this.rmw(rm, sz, (old) => `const k=c.cf,v=c.alu(${op === 0 ? 0 : 5},${old},1,${sz});c.cf=k;`);
				if (sz !== 32) return null;
				if (op === 2) return `{const t=${this.rd(rm, 32)},s=(r[4]-4)|0;r[4]=s;dv.setInt32(s,${this.p},true);c.eip=t;}`;
				if (op === 4) return `c.eip=${this.rd(rm, 32)};`;
				if (op === 6) return push(this.rd(rm, 32));
				return null;
			}
		}
		void pc;
		return null;
	}

	private unsupported(pc: number, what: string): never {
		let bytes = '';
		for (let i = 0; i < 8; i++) bytes += this.mem[pc + i].toString(16).padStart(2, '0') + ' ';
		throw new X86Error(`${what} at ${pc.toString(16)}: ${bytes}`);
	}

	private decode(opcode: number, size: number, rep: number, pc: number): Op {
		const r = this.r;
		const dv = this.dv;
		const mem = this.mem;

		// ---- ALU: op r/m, r | op r, r/m | op al/eax, imm
		if (opcode < 0x40 && (opcode & 7) < 6) {
			const op = opcode >> 3;
			const form = opcode & 7;
			const sz = form & 1 ? size : 8;
			if (form < 4) {
				const { reg, rm } = this.modrm();
				const regRm: Rm = { reg, ea: null };
				const dst = form < 2 ? rm : regRm;
				const src = this.getter(form < 2 ? regRm : rm, sz);
				if (op === 7) {
					const a = this.getter(dst, sz);
					return () => void this.alu(7, a(), src(), sz);
				}
				return this.modify(dst, sz, (v) => this.alu(op, v, src(), sz));
			}
			const imm = sz === 8 ? this.u8() : sz === 16 ? this.i16() : this.i32();
			if (op === 7) return sz === 32 ? () => void this.alu(7, r[0], imm, 32) : () => void this.alu(7, r[0], imm, sz);
			return this.modify({ reg: 0, ea: null }, sz, (v) => this.alu(op, v, imm, sz));
		}

		// ---- inc / dec / push / pop register
		if (opcode >= 0x40 && opcode < 0x50) {
			const i = opcode & 7;
			const delta = opcode < 0x48 ? 1 : -1;
			if (size === 32)
				return () => {
					const a = r[i];
					const res = (a + delta) | 0;
					r[i] = res;
					this.of = delta === 1 ? (res === -2147483648 ? 1 : 0) : res === 2147483647 ? 1 : 0;
					this.lr = res;
					this.explicit = false;
				};
			return () => {
				const cf = this.cf;
				this.s16(i, this.alu(delta === 1 ? 0 : 5, r[i], 1, 16));
				this.cf = cf;
			};
		}
		if (opcode >= 0x50 && opcode < 0x58) {
			const i = opcode & 7;
			return () => {
				const v = r[i];
				const sp = (r[4] - 4) | 0;
				r[4] = sp;
				dv.setInt32(sp, v, true);
			};
		}
		if (opcode >= 0x58 && opcode < 0x60) {
			const i = opcode & 7;
			return () => {
				const sp = r[4];
				r[4] = (sp + 4) | 0;
				r[i] = dv.getInt32(sp, true);
			};
		}
		// ---- jcc short
		if (opcode >= 0x70 && opcode < 0x80) {
			const cc = opcode & 15;
			const rel = this.i8();
			const target = (this.p + rel) | 0;
			return this.branch(cc, target);
		}
		// ---- mov reg, imm
		if (opcode >= 0xb0 && opcode < 0xb8) {
			const i = opcode & 7;
			const imm = this.u8();
			return () => this.s8(i, imm);
		}
		if (opcode >= 0xb8 && opcode < 0xc0) {
			const i = opcode & 7;
			if (size === 16) {
				const imm = this.i16();
				return () => this.s16(i, imm);
			}
			const imm = this.i32();
			return () => void (r[i] = imm);
		}
		// ---- xchg eax, reg
		if (opcode > 0x90 && opcode < 0x98) {
			const i = opcode & 7;
			return () => {
				const t = r[0];
				r[0] = r[i];
				r[i] = t;
			};
		}
		if (opcode >= 0xd8 && opcode <= 0xdf) return this.x87(opcode);

		switch (opcode) {
			case 0x0f:
				return this.decode0f(this.u8(), size, pc);
			case 0x68: {
				const imm = this.i32();
				return () => this.push(imm);
			}
			case 0x6a: {
				const imm = this.i8();
				return () => this.push(imm);
			}
			case 0x69:
			case 0x6b: {
				const { reg, rm } = this.modrm();
				const src = this.getter(rm, size);
				const imm = opcode === 0x6b ? this.i8() : size === 16 ? this.i16() : this.i32();
				if (size === 16) return () => this.s16(reg, Math.imul((src() << 16) >> 16, imm));
				return () => {
					r[reg] = Math.imul(src(), imm);
					this.cf = this.of = 0;
				};
			}
			case 0x80:
			case 0x81:
			case 0x83: {
				const sz = opcode === 0x80 ? 8 : size;
				const { reg: op, rm } = this.modrm();
				const imm = opcode === 0x81 ? (sz === 16 ? this.i16() : this.i32()) : this.i8();
				if (op === 7) {
					const a = this.getter(rm, sz);
					return () => void this.alu(7, a(), imm, sz);
				}
				return this.modify(rm, sz, (v) => this.alu(op, v, imm, sz));
			}
			case 0x84:
			case 0x85: {
				const sz = opcode === 0x84 ? 8 : size;
				const { reg, rm } = this.modrm();
				const a = this.getter(rm, sz);
				const b = this.getter({ reg, ea: null }, sz);
				return () => void this.alu(4, a(), b(), sz);
			}
			case 0x86:
			case 0x87: {
				const sz = opcode === 0x86 ? 8 : size;
				const { reg, rm } = this.modrm();
				const getR = this.getter({ reg, ea: null }, sz);
				const setR = this.setter({ reg, ea: null }, sz);
				return this.modify(rm, sz, (v) => {
					const t = getR();
					setR(v);
					return t;
				});
			}
			case 0x88:
			case 0x89: {
				const sz = opcode === 0x88 ? 8 : size;
				const { reg, rm } = this.modrm();
				if (sz === 32) {
					if (rm.reg >= 0) {
						const d = rm.reg;
						return () => void (r[d] = r[reg]);
					}
					const ea = rm.ea!;
					return () => dv.setInt32(ea(), r[reg], true);
				}
				const get = this.getter({ reg, ea: null }, sz);
				const set = this.setter(rm, sz);
				return () => set(get());
			}
			case 0x8a:
			case 0x8b: {
				const sz = opcode === 0x8a ? 8 : size;
				const { reg, rm } = this.modrm();
				if (sz === 32) {
					if (rm.reg >= 0) {
						const s = rm.reg;
						return () => void (r[reg] = r[s]);
					}
					const ea = rm.ea!;
					return () => void (r[reg] = dv.getInt32(ea(), true));
				}
				const get = this.getter(rm, sz);
				const set = this.setter({ reg, ea: null }, sz);
				return () => set(get());
			}
			case 0x8d: {
				const { reg, rm } = this.modrm();
				const ea = rm.ea ?? this.unsupported(pc, 'lea with a register operand');
				return () => void (r[reg] = ea());
			}
			case 0x8f: {
				const { rm } = this.modrm();
				const set = this.setter(rm, 32);
				return () => set(this.pop());
			}
			case 0x90:
				return () => {};
			case 0x98:
				return size === 16 ? () => this.s16(0, (r[0] << 24) >> 24) : () => void (r[0] = (r[0] << 16) >> 16);
			case 0x99:
				return size === 16 ? () => this.s16(2, r[0] & 0x8000 ? 0xffff : 0) : () => void (r[2] = r[0] >> 31);
			case 0x9c:
				return () => this.push(this.getFlags());
			case 0x9d:
				return () => this.setFlags(this.pop());
			case 0x9e: // sahf
				return () => {
					const ah = (r[0] >> 8) & 0xff;
					const of = this.of;
					const df = this.df;
					this.setFlags(ah);
					this.of = of;
					this.df = df;
				};
			case 0x9f:
				return () => this.s8(4, this.getFlags() & 0xff);
			case 0xa0: {
				const a = this.i32();
				return () => this.s8(0, mem[a]);
			}
			case 0xa1: {
				const a = this.i32();
				return size === 16 ? () => this.s16(0, dv.getUint16(a, true)) : () => void (r[0] = dv.getInt32(a, true));
			}
			case 0xa2: {
				const a = this.i32();
				return () => void (mem[a] = r[0]);
			}
			case 0xa3: {
				const a = this.i32();
				return size === 16 ? () => dv.setUint16(a, r[0], true) : () => dv.setInt32(a, r[0], true);
			}
			case 0xa4:
			case 0xa5:
			case 0xa6:
			case 0xa7:
			case 0xaa:
			case 0xab:
			case 0xac:
			case 0xad:
			case 0xae:
			case 0xaf:
				return this.stringOp(opcode, opcode & 1 ? size : 8, rep);
			case 0xa8: {
				const imm = this.u8();
				return () => void this.alu(4, r[0], imm, 8);
			}
			case 0xa9: {
				const imm = size === 16 ? this.i16() : this.i32();
				return () => void this.alu(4, r[0], imm, size);
			}
			case 0xc0:
			case 0xc1:
			case 0xd0:
			case 0xd1:
			case 0xd2:
			case 0xd3: {
				const sz = opcode & 1 ? size : 8;
				const { reg: op, rm } = this.modrm();
				if (opcode < 0xd0) {
					const count = this.u8();
					return this.modify(rm, sz, (v) => this.shift(op, v, count, sz));
				}
				if (opcode < 0xd2) return this.modify(rm, sz, (v) => this.shift(op, v, 1, sz));
				return this.modify(rm, sz, (v) => this.shift(op, v, r[1], sz));
			}
			case 0xc2: {
				const n = this.i16() & 0xffff;
				return () => {
					this.eip = this.pop();
					r[4] = (r[4] + n) | 0;
				};
			}
			case 0xc3:
				return () => {
					const sp = r[4];
					r[4] = (sp + 4) | 0;
					this.eip = dv.getInt32(sp, true);
				};
			case 0xc6:
			case 0xc7: {
				const sz = opcode === 0xc6 ? 8 : size;
				const { rm } = this.modrm();
				const imm = sz === 8 ? this.u8() : sz === 16 ? this.i16() : this.i32();
				const set = this.setter(rm, sz);
				return () => set(imm);
			}
			case 0xc9: // leave
				return () => {
					r[4] = r[5];
					r[5] = this.pop();
				};
			case 0xcc:
				return () => {
					throw new X86Error(`breakpoint (int3) at ${pc.toString(16)}`);
				};
			case 0xe8: {
				const rel = this.i32();
				const target = (this.p + rel) | 0;
				const ret = this.p;
				return () => {
					const sp = (r[4] - 4) | 0;
					r[4] = sp;
					dv.setInt32(sp, ret, true);
					this.eip = target;
				};
			}
			case 0xe9: {
				const rel = this.i32();
				const target = (this.p + rel) | 0;
				return () => void (this.eip = target);
			}
			case 0xeb: {
				const rel = this.i8();
				const target = (this.p + rel) | 0;
				return () => void (this.eip = target);
			}
			case 0xe3: {
				const rel = this.i8();
				const target = (this.p + rel) | 0;
				return () => {
					if (r[1] === 0) this.eip = target;
				};
			}
			case 0xf6:
			case 0xf7:
				return this.group3(opcode === 0xf6 ? 8 : size, pc);
			case 0xfc:
				return () => void (this.df = 0);
			case 0xfd:
				return () => void (this.df = 1);
			case 0xfe:
			case 0xff: {
				const sz = opcode === 0xfe ? 8 : size;
				const { reg: op, rm } = this.modrm();
				if (op < 2) {
					const delta = op === 0 ? 1 : -1;
					return this.modify(rm, sz, (v) => {
						const cf = this.cf;
						const res = this.alu(delta === 1 ? 0 : 5, v, 1, sz);
						this.cf = cf;
						return res;
					});
				}
				const get = this.getter(rm, 32);
				const ret = this.p;
				if (op === 2)
					return () => {
						const target = get();
						this.push(ret);
						this.eip = target;
					};
				if (op === 4) return () => void (this.eip = get());
				if (op === 6) return () => this.push(get());
				return this.unsupported(pc, `group 5 /${op}`);
			}
		}
		return this.unsupported(pc, `instruction ${opcode.toString(16)} is not implemented`);
	}

	private branch(cc: number, target: number): Op {
		// the common conditions without the generic switch
		switch (cc) {
			case 4:
				return () => {
					if (this.explicit ? this.ezf === 1 : this.lr === 0) this.eip = target;
				};
			case 5:
				return () => {
					if (this.explicit ? this.ezf === 0 : this.lr !== 0) this.eip = target;
				};
			case 2:
				return () => {
					if (this.cf === 1) this.eip = target;
				};
			case 3:
				return () => {
					if (this.cf === 0) this.eip = target;
				};
			default:
				return () => {
					if (this.cond(cc)) this.eip = target;
				};
		}
	}

	private decode0f(opcode: number, size: number, pc: number): Op {
		const r = this.r;
		if (opcode >= 0x80 && opcode < 0x90) {
			const rel = this.i32();
			return this.branch(opcode & 15, (this.p + rel) | 0);
		}
		if (opcode >= 0x90 && opcode < 0xa0) {
			const cc = opcode & 15;
			const { rm } = this.modrm();
			const set = this.setter(rm, 8);
			return () => set(this.cond(cc) ? 1 : 0);
		}
		if (opcode >= 0x40 && opcode < 0x50) {
			const cc = opcode & 15;
			const { reg, rm } = this.modrm();
			const get = this.getter(rm, size);
			const set = this.setter({ reg, ea: null }, size);
			return () => {
				const v = get(); // the operand is read even when the move does not happen
				if (this.cond(cc)) set(v);
			};
		}
		switch (opcode) {
			case 0x1f: // multi-byte nop
				this.modrm();
				return () => {};
			case 0xa2: // cpuid: a plain 486-class CPU without extensions
				return () => {
					const leaf = r[0];
					r[0] = leaf === 0 ? 1 : 0x480;
					r[3] = leaf === 0 ? 0x756e6547 : 0;
					r[2] = leaf === 0 ? 0x49656e69 : 0;
					r[1] = leaf === 0 ? 0x6c65746e : 0;
					if (leaf !== 0) r[2] = 1; // edx: FPU present
				};
			case 0xaf: {
				const { reg, rm } = this.modrm();
				const get = this.getter(rm, size);
				if (size === 16) return () => this.s16(reg, Math.imul((r[reg] << 16) >> 16, (get() << 16) >> 16));
				return () => {
					r[reg] = Math.imul(r[reg], get());
					this.cf = this.of = 0;
				};
			}
			case 0xb6:
			case 0xb7:
			case 0xbe:
			case 0xbf: {
				const from = opcode & 1 ? 16 : 8;
				const signed = opcode >= 0xbe;
				const { reg, rm } = this.modrm();
				const get = this.getter(rm, from);
				const set = this.setter({ reg, ea: null }, size);
				if (!signed) return () => set(get());
				return from === 8 ? () => set((get() << 24) >> 24) : () => set((get() << 16) >> 16);
			}
			case 0xa4:
			case 0xa5:
			case 0xac:
			case 0xad: {
				// shld / shrd by imm8 or cl
				const { reg, rm } = this.modrm();
				const fixed = opcode === 0xa4 || opcode === 0xac ? this.u8() : -1;
				const left = opcode < 0xa8;
				if (size !== 32) return this.unsupported(pc, '16-bit double shift');
				return this.modify(rm, 32, (v) => {
					const count = (fixed >= 0 ? fixed : r[1]) & 31;
					if (count === 0) return v;
					const res = left ? (v << count) | (r[reg] >>> (32 - count)) : (v >>> count) | (r[reg] << (32 - count));
					this.cf = left ? (v >>> (32 - count)) & 1 : (v >>> (count - 1)) & 1;
					this.of = ((res ^ v) >>> 31) & 1;
					this.setLr(res | 0);
					return res;
				});
			}
			case 0xa3:
			case 0xab:
			case 0xb3:
			case 0xbb: {
				// bt / bts / btr / btc r/m32, r32 (register operand only: no bit strings in memory)
				const { reg, rm } = this.modrm();
				const kind = opcode === 0xa3 ? 0 : opcode === 0xab ? 1 : opcode === 0xb3 ? 2 : 3;
				if (rm.reg < 0 && kind === 0) {
					const ea = rm.ea!;
					return () => {
						const bit = r[reg];
						this.cf = (this.dv.getInt32((ea() + ((bit >> 5) << 2)) | 0, true) >>> (bit & 31)) & 1;
					};
				}
				if (rm.reg < 0) return this.unsupported(pc, 'bit test and modify in memory');
				return this.modify(rm, 32, (v) => {
					const mask = 1 << (r[reg] & 31);
					this.cf = v & mask ? 1 : 0;
					return kind === 0 ? v : kind === 1 ? v | mask : kind === 2 ? v & ~mask : v ^ mask;
				});
			}
			case 0xba: {
				const { reg: kind, rm } = this.modrm();
				const bit = this.u8() & 31;
				const mask = 1 << bit;
				return this.modify(rm, 32, (v) => {
					this.cf = v & mask ? 1 : 0;
					return kind === 4 ? v : kind === 5 ? v | mask : kind === 6 ? v & ~mask : v ^ mask;
				});
			}
			case 0xbc:
			case 0xbd: {
				const { reg, rm } = this.modrm();
				const get = this.getter(rm, 32);
				return () => {
					const v = get();
					this.setLr(v);
					if (v !== 0) r[reg] = opcode === 0xbc ? 31 - Math.clz32(v & -v) : 31 - Math.clz32(v);
				};
			}
			case 0xc8: case 0xc9: case 0xca: case 0xcb: case 0xcc: case 0xcd: case 0xce: case 0xcf: {
				const i = opcode & 7;
				return () => {
					const v = r[i];
					r[i] = ((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >> 8) & 0xff00) | ((v >> 24) & 0xff);
				};
			}
			case 0x31: // rdtsc
				return () => {
					r[0] = this.count | 0;
					r[2] = 0;
				};
		}
		return this.unsupported(pc, `instruction 0f ${opcode.toString(16)} is not implemented`);
	}

	/** f6 / f7: test, not, neg, mul, imul, div, idiv */
	private group3(size: number, pc: number): Op {
		const r = this.r;
		const { reg: op, rm } = this.modrm();
		const get = this.getter(rm, size);
		switch (op) {
			case 0:
			case 1: {
				const imm = size === 8 ? this.u8() : size === 16 ? this.i16() : this.i32();
				return () => void this.alu(4, get(), imm, size);
			}
			case 2:
				return this.modify(rm, size, (v) => ~v);
			case 3:
				return this.modify(rm, size, (v) => {
					const res = this.alu(5, 0, v, size);
					return res;
				});
			case 4: // mul
				if (size === 8) return () => this.s16(0, (r[0] & 0xff) * get());
				if (size === 16)
					return () => {
						const p = (r[0] & 0xffff) * get();
						this.s16(0, p);
						this.s16(2, p >>> 16);
						this.cf = this.of = p >>> 16 ? 1 : 0;
					};
				return () => {
					const a = r[0] >>> 0;
					const b = get() >>> 0;
					const lo = Math.imul(a, b);
					// high half from 16-bit pieces
					const a0 = a & 0xffff, a1 = a >>> 16, b0 = b & 0xffff, b1 = b >>> 16;
					const mid = a1 * b0 + ((a0 * b0) >>> 16);
					const mid2 = a0 * b1 + (mid & 0xffff);
					const hi = a1 * b1 + Math.floor(mid / 65536) + Math.floor(mid2 / 65536);
					r[0] = lo;
					r[2] = hi | 0;
					this.cf = this.of = hi !== 0 ? 1 : 0;
				};
			case 5: // imul
				if (size === 8) return () => this.s16(0, ((r[0] << 24) >> 24) * ((get() << 24) >> 24));
				if (size === 16)
					return () => {
						const p = ((r[0] << 16) >> 16) * ((get() << 16) >> 16);
						this.s16(0, p);
						this.s16(2, p >> 16);
					};
				return () => {
					const p = BigInt(r[0]) * BigInt(get());
					r[0] = Number(BigInt.asIntN(32, p));
					r[2] = Number(BigInt.asIntN(32, p >> 32n));
					this.cf = this.of = r[2] === r[0] >> 31 ? 0 : 1;
				};
			case 6: // div
				if (size === 8)
					return () => {
						const d = get();
						if (d === 0) throw new X86Error(`division by zero at ${pc.toString(16)}`);
						const n = r[0] & 0xffff;
						this.s16(0, (Math.floor(n / d) & 0xff) | ((n % d) << 8));
					};
				if (size === 16)
					return () => {
						const d = get();
						if (d === 0) throw new X86Error(`division by zero at ${pc.toString(16)}`);
						const n = ((r[2] & 0xffff) * 65536 + (r[0] & 0xffff)) >>> 0;
						this.s16(0, Math.floor(n / d));
						this.s16(2, n % d);
					};
				return () => {
					const d = get() >>> 0;
					if (d === 0) throw new X86Error(`division by zero at ${pc.toString(16)}`);
					if (r[2] === 0) {
						const n = r[0] >>> 0;
						r[0] = Math.floor(n / d) | 0;
						r[2] = n % d | 0;
					} else {
						const n = (BigInt(r[2] >>> 0) << 32n) | BigInt(r[0] >>> 0);
						r[0] = Number(BigInt.asIntN(32, n / BigInt(d)));
						r[2] = Number(BigInt.asIntN(32, n % BigInt(d)));
					}
				};
			default: // idiv
				if (size === 8)
					return () => {
						const d = (get() << 24) >> 24;
						if (d === 0) throw new X86Error(`division by zero at ${pc.toString(16)}`);
						const n = (r[0] << 16) >> 16;
						this.s16(0, (Math.trunc(n / d) & 0xff) | ((n % d & 0xff) << 8));
					};
				if (size === 16)
					return () => {
						const d = (get() << 16) >> 16;
						if (d === 0) throw new X86Error(`division by zero at ${pc.toString(16)}`);
						const n = ((r[2] & 0xffff) << 16) | (r[0] & 0xffff);
						this.s16(0, Math.trunc(n / d));
						this.s16(2, n % d);
					};
				return () => {
					const d = get();
					if (d === 0) throw new X86Error(`division by zero at ${pc.toString(16)}`);
					if (r[2] === r[0] >> 31) {
						const n = r[0];
						r[0] = Math.trunc(n / d) | 0;
						r[2] = n % d | 0;
					} else {
						const n = (BigInt(r[2]) << 32n) | BigInt(r[0] >>> 0);
						r[0] = Number(BigInt.asIntN(32, n / BigInt(d)));
						r[2] = Number(BigInt.asIntN(32, n % BigInt(d)));
					}
				};
		}
	}

	/** movs, cmps, stos, lods, scas – with rep / repe / repne */
	private stringOp(opcode: number, size: number, rep: number): Op {
		const r = this.r;
		const mem = this.mem;
		const dv = this.dv;
		const bytes = size >> 3;
		const read = (a: number): number => (size === 8 ? mem[a] : size === 16 ? dv.getUint16(a, true) : dv.getInt32(a, true));
		const write = (a: number, v: number): void => {
			if (size === 8) mem[a] = v;
			else if (size === 16) dv.setUint16(a, v, true);
			else dv.setInt32(a, v, true);
		};
		const kind = opcode & 0xfe;
		const one = (): void => {
			const step = this.df ? -bytes : bytes;
			switch (kind) {
				case 0xa4:
					write(r[7], read(r[6]));
					r[6] = (r[6] + step) | 0;
					r[7] = (r[7] + step) | 0;
					break;
				case 0xa6:
					this.alu(7, read(r[6]), read(r[7]), size);
					r[6] = (r[6] + step) | 0;
					r[7] = (r[7] + step) | 0;
					break;
				case 0xaa:
					write(r[7], r[0]);
					r[7] = (r[7] + step) | 0;
					break;
				case 0xac:
					if (size === 8) this.s8(0, read(r[6]));
					else if (size === 16) this.s16(0, read(r[6]));
					else r[0] = read(r[6]);
					r[6] = (r[6] + step) | 0;
					break;
				default: // scas
					this.alu(7, size === 8 ? r[0] & 0xff : size === 16 ? r[0] & 0xffff : r[0], read(r[7]), size);
					r[7] = (r[7] + step) | 0;
			}
		};
		if (!rep) return one;
		const compares = kind === 0xa6 || kind === 0xae;
		const slow = (): void => {
			while (r[1] !== 0) {
				one();
				r[1] = (r[1] - 1) | 0;
				if (compares && (rep === 0xf3 ? this.lr !== 0 : this.lr === 0)) break;
			}
		};
		// The repeated forms are how compilers inline memcpy, memset and strlen:
		// do them as block operations where the direction is forward.
		if (kind === 0xa4)
			return () => {
				const n = (r[1] >>> 0) * bytes;
				// an overlapping copy to a higher address replicates data: keep the element loop
				if (this.df || (r[7] > r[6] && r[7] < r[6] + n)) return slow();
				mem.copyWithin(r[7], r[6], r[6] + n);
				r[6] = (r[6] + n) | 0;
				r[7] = (r[7] + n) | 0;
				r[1] = 0;
			};
		if (kind === 0xaa)
			return () => {
				if (this.df) return slow();
				const n = r[1] >>> 0;
				const at = r[7];
				const v = r[0];
				if (size === 8) mem.fill(v & 0xff, at, at + n);
				else if (size === 32 && (v & 0xff) === ((v >> 8) & 0xff) && (v & 0xffff) === (v >>> 16)) mem.fill(v & 0xff, at, at + n * 4);
				else for (let i = 0; i < n; i++) write(at + i * bytes, v);
				r[7] = (at + n * bytes) | 0;
				r[1] = 0;
			};
		if (kind === 0xae && size === 8)
			return () => {
				if (this.df) return slow();
				const n = r[1] >>> 0;
				if (n === 0) return;
				const at = r[7];
				const al = r[0] & 0xff;
				let k = 0;
				if (rep === 0xf2) {
					// repne scasb: search for al
					const found = mem.indexOf(al, at);
					k = found >= 0 && found - at < n ? found - at + 1 : n;
				} else {
					while (k < n && mem[at + k] === al) k++;
					if (k < n) k++;
				}
				r[7] = (at + k) | 0;
				r[1] = (n - k) | 0;
				this.alu(7, al, mem[at + k - 1], 8);
			};
		return slow;
	}

	// ------------------------------------------------------------------ running
	/** Runs from the current eip until `running` is cleared (by the host). */
	run(): void {
		const code = this.code;
		const base = this.codeBase;
		const lo = this.hostLo;
		const hi = this.hostHi;
		this.running = true;
		while (this.running) {
			const pc = this.eip;
			if (pc >= lo && pc < hi) {
				this.host(pc);
				continue;
			}
			let op = code[pc - base];
			if (op === undefined) {
				if (pc < base || pc - base >= code.length) throw new X86Error(`jump outside the program: ${(pc >>> 0).toString(16)}`);
				op = this.compile(pc);
				code[pc - base] = op;
			}
			op();
		}
	}
}
