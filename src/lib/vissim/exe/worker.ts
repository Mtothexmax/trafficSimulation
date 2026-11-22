// Web Worker that runs a controller program in the emulator, so loading it
// (a few seconds) and the control steps do not block the page.
import { ControllerProgram, type ProgramState, type Triple } from './program';

export type WorkerRequest =
	| { type: 'start'; exe: ArrayBuffer; files: Record<string, ArrayBuffer>; commandLine: string; clock: number; tz: number; setup: Triple[] }
	/** back to the state right after loading and initialising */
	| { type: 'reset' }
	| { type: 'step'; id: number; triples: Triple[] };

export type WorkerReply = { type: 'ready'; loadMs: number; notes: string[] } | { type: 'reply'; id: number; triples: Triple[] } | { type: 'error'; id?: number; message: string };

let program: ControllerProgram | null = null;
/** the program right after loading and initialising, and what it had to say then */
let initial: ProgramState | null = null;
let notes: string[] = [];
const post = (m: WorkerReply): void => (self as unknown as { postMessage(m: WorkerReply): void }).postMessage(m);

self.onmessage = (e: MessageEvent<WorkerRequest>): void => {
	const m = e.data;
	try {
		if (m.type === 'start') {
			const t0 = performance.now();
			const files: Record<string, Uint8Array> = {};
			for (const [name, data] of Object.entries(m.files)) files[name] = new Uint8Array(data);
			program = new ControllerProgram(new Uint8Array(m.exe), files, m.commandLine, m.clock, m.tz);
			program.start();
			if (!program.poke('DateiLesen', m.setup)) throw new Error('Die Steuerung konnte ihre Versorgungsdateien nicht einlesen');
			if (program.destroyed) throw new Error(`Die Steuerung hat sich beim Einlesen beendet${program.log.length ? ': ' + program.log.join('; ') : ''}`);
			if (!program.poke('Init', m.setup)) throw new Error('Die Steuerung ließ sich nicht initialisieren');
			notes = [...program.log, ...[...program.missing].map((n) => `Funktion ${n} ist nicht nachgebaut`)];
			initial = program.snapshot();
			post({ type: 'ready', loadMs: performance.now() - t0, notes });
		} else if (m.type === 'reset') {
			if (!program || !initial) throw new Error('Die Steuerung läuft nicht');
			program.restore(initial);
			post({ type: 'ready', loadMs: 0, notes });
		} else if (m.type === 'step') {
			if (!program) throw new Error('Die Steuerung läuft nicht');
			if (!program.poke('Rechnen', m.triples)) throw new Error('Die Steuerung hat den Schritt nicht angenommen');
			post({ type: 'reply', id: m.id, triples: program.request('Wunschbild') });
		}
	} catch (err) {
		post({ type: 'error', id: m.type === 'step' ? m.id : undefined, message: err instanceof Error ? err.message : String(err) });
	}
};
