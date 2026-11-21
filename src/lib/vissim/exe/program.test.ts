// Runs a real controller program in the emulator and compares every answer
// with a recording of the same program running natively on Windows
// (experiments/exe-emulator/record_real.py).
//
// The program itself is not part of this repository. Point the test at it:
//   VA_TEST_DIR=<folder> VA_TEST_EXE=<program.exe> VA_TEST_VSG=<supply.vsg> VA_TEST_VAG=<supply.vag> npx vitest run
// Without these variables the test is skipped.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePe } from './pe';
import { ControllerProgram, type Triple } from './program';

const env = process.env;
const dir = env.VA_TEST_DIR;
const exe = env.VA_TEST_EXE ?? '';
const supply = [env.VA_TEST_VSG ?? '', env.VA_TEST_VAG ?? ''];
const recordingPath = new URL('../../../../experiments/exe-emulator/recording.json', import.meta.url);
const available = !!dir && !!exe && supply.every(Boolean) && existsSync(join(dir, exe)) && existsSync(recordingPath);

// ---- the scenario of experiments/exe-emulator/scenario.py
const GROUPS = Array.from({ length: 11 }, (_, i) => i + 1);
const DETECTORS = Array.from({ length: 12 }, (_, i) => i + 1);
const SETUP: Triple[] = [[1001, 0, 110], [1011, 0, 1], ...GROUPS.map((sg): Triple => [2001, sg, 2])];
function step(sec: number, picture: Map<number, number>): Triple[] {
	const out: Triple[] = [[1002, 0, sec % 110], [1011, 0, 1]];
	for (const sg of GROUPS) out.push([2001, sg, picture.get(sg)!]);
	for (const d of DETECTORS) out.push([3001, d, Math.floor(sec / 150) % 2 === 1 && (sec + d * 17) % (30 + d * 3) < 12 ? 1 : 0]);
	return out;
}
/** FNV-1a over the values of a reply – the recording stores one hash per control step. */
function hash(reply: Triple[]): number {
	let h = 0x811c9dc5;
	for (const t of reply) {
		for (const v of t) {
			for (let s = 0; s < 32; s += 8) {
				h ^= (v >>> s) & 0xff;
				h = Math.imul(h, 0x01000193);
			}
		}
	}
	return h >>> 0;
}

describe.skipIf(!available)('controller program in the emulator', () => {
	it('answers exactly like the real program, step by step', () => {
		const recording = JSON.parse(readFileSync(recordingPath, 'utf8')) as { started: number; tz: number; hashes: number[]; pictures: [number, Triple[]][] };
		const files: Record<string, Uint8Array> = {};
		for (const name of supply) files[name] = new Uint8Array(readFileSync(join(dir!, name)));
		const program = new ControllerProgram(new Uint8Array(readFileSync(join(dir!, exe))), files, `1 1 X ${supply.join(' ')}`, recording.started, recording.tz);
		const t0 = performance.now();
		program.start();
		expect(program.poke('DateiLesen', SETUP)).toBe(true);
		expect(program.poke('Init', SETUP)).toBe(true);
		const tInit = performance.now() - t0;
		const picture = new Map(GROUPS.map((sg) => [sg, 2]));
		const pictures: [number, Triple[]][] = [];
		let firstDifference = 0;
		const t1 = performance.now();
		for (let sec = 1; sec <= recording.hashes.length; sec++) {
			expect(program.poke('Rechnen', step(sec, picture))).toBe(true);
			const reply = program.request('Wunschbild');
			const wanted = reply.filter((t) => t[0] === 2002 || t[0] === 2003);
			for (const [, sg, v] of wanted) picture.set(sg, v);
			if (wanted.length) pictures.push([sec, wanted]);
			if (!firstDifference && hash(reply) !== recording.hashes[sec - 1]) firstDifference = sec;
		}
		const perStep = (performance.now() - t1) / recording.hashes.length;
		console.log(`emulator: start + DateiLesen + Init ${(tInit / 1000).toFixed(1)} s, ${perStep.toFixed(1)} ms per control step, ${(program.cpu.count / 1e6).toFixed(0)} million instructions, not implemented: ${[...program.missing].join(', ') || 'none'}`);
		expect([...program.missing]).toEqual([]);
		expect(firstDifference).toBe(0);
		expect(pictures).toEqual(recording.pictures);
		expect(pictures.length).toBeGreaterThan(3);
	}, 300000);
});

describe('program file reader', () => {
	it('rejects files that are not 32-bit Windows programs', () => {
		expect(() => parsePe(new Uint8Array(600))).toThrow(/Windows-Programmdatei/);
		const mz = new Uint8Array(600);
		mz[0] = 0x4d;
		mz[1] = 0x5a;
		expect(() => parsePe(mz)).toThrow(/PE-Kopf/);
	});
});
