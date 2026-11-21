// How the simulation reaches an external signal controller program: the
// program the user uploaded runs emulated in a Web Worker.
import type { Triple } from './va';
import type { WorkerReply, WorkerRequest } from './exe/worker';

export interface VaTransport {
	/** what is controlling, for the panel */
	readonly label: string;
	/** Starts the controller and initialises it. Resolves with notes worth showing. */
	start(setup: Triple[]): Promise<string[]>;
	/** One control step. */
	step(triples: Triple[]): Promise<Triple[]>;
	stop(): void;
}

export interface UploadedProgram {
	exe: { name: string; data: ArrayBuffer };
	/** supply files (.vsg, .vag) in the order the program expects them */
	supply: { name: string; data: ArrayBuffer }[];
	/** settings files that may lie beside them (.ini, .wtt) */
	extra: { name: string; data: ArrayBuffer }[];
}

/** Sorts the files a user picked into program, supply and settings files. */
export async function readUpload(files: File[]): Promise<UploadedProgram> {
	const ext = (f: File): string => f.name.slice(f.name.lastIndexOf('.') + 1).toLowerCase();
	const exe = files.filter((f) => ext(f) === 'exe');
	if (exe.length !== 1) throw new Error(exe.length ? 'Bitte nur ein Steuerungsprogramm (*.exe) wählen.' : 'Es fehlt das Steuerungsprogramm (*.exe).');
	const vsg = files.filter((f) => ext(f) === 'vsg');
	const vag = files.filter((f) => ext(f) === 'vag');
	if (vsg.length !== 1 || vag.length > 1) throw new Error('Bitte genau eine Versorgungsdatei *.vsg und höchstens eine *.vag wählen.');
	const load = async (f: File): Promise<{ name: string; data: ArrayBuffer }> => ({ name: f.name.replace(/\s+/g, '_'), data: await f.arrayBuffer() });
	return {
		exe: await load(exe[0]),
		supply: await Promise.all([...vsg, ...vag].map(load)),
		extra: await Promise.all(files.filter((f) => ext(f) === 'ini' || ext(f) === 'wtt').map(load))
	};
}

export class EmulatorTransport implements VaTransport {
	readonly label: string;
	private worker: Worker | null = null;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (t: Triple[]) => void; reject: (e: Error) => void }>();

	constructor(
		private readonly program: UploadedProgram,
		private readonly nr: number
	) {
		this.label = `${program.exe.name} (im Browser emuliert)`;
	}

	start(setup: Triple[]): Promise<string[]> {
		this.stop();
		const worker = (this.worker = new Worker(new URL('./exe/worker.ts', import.meta.url), { type: 'module' }));
		return new Promise<string[]>((resolve, reject) => {
			worker.onmessage = (e: MessageEvent<WorkerReply>) => {
				const m = e.data;
				if (m.type === 'ready') resolve([`Steuerung geladen in ${(m.loadMs / 1000).toFixed(1)} s`, ...m.notes]);
				else if (m.type === 'reply') {
					this.pending.get(m.id)?.resolve(m.triples);
					this.pending.delete(m.id);
				} else if (m.id !== undefined) {
					this.pending.get(m.id)?.reject(new Error(m.message));
					this.pending.delete(m.id);
				} else reject(new Error(m.message));
			};
			worker.onerror = (e) => {
				const error = new Error(e.message || 'Der Emulator ist abgestürzt');
				reject(error);
				for (const p of this.pending.values()) p.reject(error);
				this.pending.clear();
			};
			const files: Record<string, ArrayBuffer> = {};
			// the worker gets copies: the upload stays usable for a restart
			for (const f of [...this.program.supply, ...this.program.extra]) files[f.name] = f.data.slice(0);
			const request: WorkerRequest = {
				type: 'start',
				exe: this.program.exe.data.slice(0),
				files,
				commandLine: `${this.nr} ${this.nr} X ${this.program.supply.map((f) => f.name).join(' ')}`,
				clock: Math.floor(Date.now() / 1000),
				tz: -new Date().getTimezoneOffset() * 60,
				setup
			};
			worker.postMessage(request, [request.exe, ...Object.values(files)]);
		});
	}

	step(triples: Triple[]): Promise<Triple[]> {
		const worker = this.worker;
		if (!worker) return Promise.reject(new Error('Die Steuerung läuft nicht'));
		const id = this.nextId++;
		return new Promise<Triple[]>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			worker.postMessage({ type: 'step', id, triples } satisfies WorkerRequest);
		});
	}

	stop(): void {
		this.worker?.terminate();
		this.worker = null;
		for (const p of this.pending.values()) p.reject(new Error('Die Steuerung wurde beendet'));
		this.pending.clear();
	}
}
