<script lang="ts">
	import 'material-symbols/outlined.css';
	import { onMount } from 'svelte';
	import { parseInpx } from '../lib/vissim/inpx';
	import { parseSig, type SigFile, type SignalState } from '../lib/vissim/sig';
	import { buildRuntime, type Runtime } from '../lib/vissim/net';
	import { DEFAULT_PEDESTRIANS_PER_HOUR, Simulation } from '../lib/vissim/sim';
	import { draw, fitView, SIGNAL_COLORS, type View } from '../lib/vissim/render';
	import { Scene3D } from '../lib/vissim/scene3d';
	import { VaBridge } from '../lib/vissim/va';
	import { readSignalProgramsOf, type SupplyProgram } from '../lib/vissim/supply';
	import { defaultStartAt, EmulatorTransport, readUpload, type UploadedProgram, type VaTransport } from '../lib/vissim/transport';
	import { asset } from '$app/paths';
	import { recall, remember } from '../lib/vissim/store';
	import InflowCharts, { type InflowSample } from '../lib/components/InflowCharts.svelte';

	/** URL of a file from static/, under whatever sub path the site is served. */
	const staticFile = (path: string): string => asset(path as Parameters<typeof asset>[0]);

	/** simulation speeds; MAX: as fast as this computer manages */
	const MAX = Infinity;
	const SPEEDS = [1, 2, 5, 10, 30, MAX];
	/** time per burst of simulation steps at MAX (ms): the rest of a frame is left for drawing */
	const MAX_BUDGET_MS = 11;
	const STATE_LABEL: Record<SignalState, string> = { red: 'Rot', redamber: 'Rot-Gelb', green: 'Grün', amber: 'Gelb', amberflash: 'Gelb blinkend', off: 'Aus' };

	// The network and the simulation are plain objects (not reactive): the
	// canvas is redrawn every frame, the panel reads the snapshot in `ui`.
	// svelte-ignore non_reactive_update
	let rt: Runtime | null = null;
	// svelte-ignore non_reactive_update
	let sim: Simulation | null = null;
	let sigs: SigFile[] = [];
	let view: View = { cx: 0, cy: 0, scale: 1 };

	let canvas = $state<HTMLCanvasElement>();
	let host3d = $state<HTMLDivElement>();
	let mode = $state<'3d' | '2d'>('3d');
	let scene: Scene3D | null = null;

	// ---- traffic-actuated control by an external controller program
	let va: VaBridge | null = null;
	let vaBusy = false;
	let vaActive = $state(false);
	let vaConnecting = $state(false);
	let vaError = $state('');
	let vaCycleSecond = $state(0);
	/** how the controller program is reached (emulated in a Web Worker) */
	let transport: VaTransport | null = null;
	let vaLabel = $state('');
	let vaNotes = $state<string[]>([]);
	/** signal controllers without a program: their signal heads are ignored */
	let noProgram = $state(false);
	let upload: UploadedProgram | null = null;
	let uploadNames = $state('');
	/** the signal program the controller is to run, and the date and time its clock shows */
	let vaProgNo = $state(1);
	/** the signal programs the uploaded supply file defines (none: not readable, free entry) */
	let vaPrograms = $state<SupplyProgram[]>([]);
	let vaStartAt = $state('');
	/** what the network file gives for the two */
	let vaDefaults = $state({ progNo: 1, startAt: '' });
	/** the signal program files as opened, kept for the reload */
	let sigTextsOpen: string[] = [];
	/** restoring the files of the last visit: do not write them back while doing so */
	let restoring = false;
	let fileName = $state('');
	let error = $state('');
	let running = $state(false);
	let speed = $state(1);
	let dragOver = $state(false);
	/** is there a sample network next to the app (static/samples, not part of the repository)? */
	let hasSample = $state(false);
	let notes = $state<string[]>([]);
	let info = $state({ links: 0, connectors: 0, heads: 0, detectors: 0, zones: 0, version: '' });
	/** the inflow figures over time, for the charts (one sample every few simulated seconds) */
	let history = $state.raw<InflowSample[]>([]);
	let historyOf: Simulation | null = null;
	let showInflows = $state(false);
	/** pedestrians per hour on every footpath (the network files give no demand for them) */
	let pedestriansPerHour = $state(DEFAULT_PEDESTRIANS_PER_HOUR);
	let footpaths = $state(0);
	let ui = $state({
		time: 0,
		period: 0,
		vehicles: 0,
		pedestrians: 0,
		collisions: 0,
		diffused: 0,
		finished: false,
		groups: [] as { key: number; name: string; state: SignalState }[],
		inputs: [] as { no: number; link: number; volume: number; entered: number; waiting: number; left: number; delay: number }[],
		detectors: [] as { no: number; name: string; occupied: boolean; count: number }[]
	});

	function snapshot(): void {
		if (!rt || !sim) return;
		ui = {
			time: sim.time,
			period: rt.net.simulation.period,
			vehicles: sim.vehicles.filter((v) => v.category !== 'PEDESTRIAN').length,
			pedestrians: sim.vehicles.filter((v) => v.category === 'PEDESTRIAN').length,
			collisions: sim.collisions,
			diffused: sim.diffused,
			finished: sim.finished,
			groups: rt.net.controllers.flatMap((c) => c.groups.map((g) => ({ key: Simulation.signalKey(c.no, g.no), name: g.name || `SG ${g.no}`, state: sim!.signals.get(Simulation.signalKey(c.no, g.no)) ?? 'off' }))),
			inputs: sim.inputStats.map((s) => ({ no: s.input.no, link: s.input.link, volume: s.input.volume, entered: s.entered, waiting: s.waiting, left: s.left, delay: s.left ? s.delay / s.left : 0 })),
			detectors: rt.detectors.filter((d) => d.type === 'STANDARD').map((d) => ({ no: d.no, name: d.name || `D ${d.no}`, ...sim!.detectorStates.get(d.no)! }))
		};
		// a new simulation starts a new history
		if (historyOf !== sim) {
			historyOf = sim;
			history = [];
		}
		const last = history[history.length - 1];
		if (!last || sim.time - last.time >= 5) {
			let next = [...history, { time: sim.time, rows: ui.inputs }];
			if (next.length > 1500) next = next.filter((_, i) => i % 2 === 0 || i === next.length - 1);
			history = next;
		}
	}

	function vaFail(e: unknown): void {
		vaError = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
		vaActive = false;
		va = null;
		running = false;
		transport?.stop();
		transport = null;
	}

	/** Takes the files of a controller program picked by the user. */
	async function vaUpload(files: FileList | null): Promise<void> {
		vaError = '';
		try {
			vaShow(await readUpload([...(files ?? [])]));
			vaRemember(false);
		} catch (e) {
			upload = null;
			uploadNames = '';
			vaPrograms = [];
			vaError = e instanceof Error ? e.message : String(e);
		}
	}

	/** Takes over an uploaded controller program: file names and its signal programs. */
	function vaShow(program: UploadedProgram): void {
		upload = program;
		uploadNames = [program.exe, ...program.supply, ...program.extra].map((f) => f.name).join(', ');
		const vsg = program.supply.find((f) => /\.vsg$/i.test(f.name));
		vaPrograms = vsg ? readSignalProgramsOf(vsg.data) : [];
		if (vaPrograms.length && !vaPrograms.some((p) => p.no === vaProgNo)) vaProgNo = vaPrograms[0].no;
	}

	function vaRemember(active: boolean): void {
		if (upload) void remember.controller({ program: upload, active, progNo: vaProgNo, startAt: vaStartAt });
	}

	function vaConnectEmulated(): void {
		const controller = rt?.net.controllers[0];
		if (!Number.isInteger(vaProgNo) || vaProgNo < 1) vaProgNo = vaDefaults.progNo;
		if (!vaStartAt) vaStartAt = vaDefaults.startAt;
		if (controller && upload) void vaConnect(new EmulatorTransport(upload, controller.no, vaStartAt));
	}

	/** A setting of the controller changed: it applies from the start, so a running
	 * controller starts again. */
	function vaChange(set: () => void): void {
		set();
		if (vaActive) vaConnectEmulated();
		else vaRemember(false);
	}

	/** Starts the controller program (again) and a fresh simulation under its control. */
	async function vaConnect(using: VaTransport | null = transport): Promise<void> {
		if (!rt || vaConnecting || !using) return;
		const controller = rt.net.controllers[0];
		if (!controller) {
			vaError = 'Das Netz hat keine Lichtsignalanlage.';
			return;
		}
		vaConnecting = true;
		vaError = '';
		running = false;
		// The simulation that ran so far is over: nothing of it may reach the controller
		// that is starting, and its open exchange ends without counting as a failure.
		va = null;
		vaBusy = false;
		if (transport && transport !== using) transport.stop();
		transport = using;
		const next = new Simulation(rt, sigs, { pedestriansPerHour });
		const bridge = new VaBridge(next, controller, vaProgNo);
		try {
			sim = next;
			snapshot();
			vaNotes = await using.start(bridge.setup());
			va = bridge;
			vaBusy = false;
			vaActive = true;
			vaLabel = using.label;
			vaRemember(true);
			restartNotes();
			snapshot();
		} catch (e) {
			vaFail(e);
			restart();
		} finally {
			vaConnecting = false;
		}
	}

	function vaDisconnect(): void {
		va = null;
		vaActive = false;
		running = false;
		transport?.stop();
		transport = null;
		vaRemember(false);
		restart();
	}

	/** Simulates as much as fits into a short time slice (speed MAX). Under external
	 * control it runs up to the next exchange with the controller, which carries on
	 * from its answer. */
	function burst(): void {
		if (!sim || !running) return;
		const until = performance.now() + MAX_BUDGET_MS;
		while (!sim.finished) {
			if (va && sim.time >= va.nextExchange - 1e-9) {
				vaExchange();
				return;
			}
			sim.step();
			if (performance.now() >= until) return;
		}
		running = false;
	}

	/** One exchange with the controller; the simulation waits for the answer. */
	function vaExchange(): void {
		const bridge = va;
		if (!bridge || vaBusy || !transport) return;
		vaBusy = true;
		transport.step(bridge.input()).then(
			(reply) => {
				if (va !== bridge) return;
				bridge.apply(reply);
				vaCycleSecond = bridge.cycleSecond;
				vaBusy = false;
				// at full speed do not wait for the next frame: carry on right away
				if (running && speed === MAX) burst();
			},
			(e) => {
				if (va === bridge) vaFail(e);
			}
		);
	}

	function restartNotes(): void {
		if (!rt || !sim) return;
		const list = [...rt.warnings];
		for (const sc of sim.uncontrolled) {
			const c = rt.net.controllers.find((x) => x.no === sc);
			list.push(`Signalsteuerung ${sc}${c?.name ? ` (${c.name})` : ''}: kein Festzeitprogramm geladen – ihre Signalgeber werden ignoriert. Die passende .sig-Datei mit öffnen.`);
		}
		for (const s of rt.net.skipped) list.push(`Nicht simuliert: ${s.section} (${s.count} Objekte)`);
		notes = list;
		noProgram = sim.uncontrolled.length > 0;
	}

	function restart(): void {
		if (!rt) return;
		if (vaActive) {
			void vaConnect();
			return;
		}
		va = null;
		sim = new Simulation(rt, sigs, { pedestriansPerHour });
		restartNotes();
		snapshot();
	}

	function load(inpx: string | null, sigTexts: string[], name: string): void {
		error = '';
		try {
			const parsedSigs = sigTexts.map(parseSig);
			if (inpx !== null) {
				rt = buildRuntime(parseInpx(inpx));
				sigs = parsedSigs;
				sigTextsOpen = [...sigTexts];
				fileName = name;
				if (!restoring) void remember.network({ name, inpx, sigs: sigTextsOpen });
				if (vaActive) {
					va = null;
					vaActive = false;
					transport?.stop();
					transport = null;
				}
				vaDefaults = { progNo: rt.net.controllers[0]?.progNo ?? 1, startAt: defaultStartAt(rt.net.simulation.startTime) };
				vaProgNo = vaDefaults.progNo;
				vaStartAt = vaDefaults.startAt;
				footpaths = rt.pedestrianLinks.length;
				const all = [...rt.links.values()];
				info = { links: all.filter((l) => !l.connector).length, connectors: all.filter((l) => l.connector).length, heads: rt.net.signalHeads.length, detectors: rt.detectors.length, zones: rt.zones.length, version: rt.net.version };
				if (canvas) view = fitView(rt, canvas.clientWidth || 800, canvas.clientHeight || 600);
				scene?.setNetwork(rt);
			} else if (rt) {
				// signal programs for the network that is already open
				sigs = [...sigs.filter((s) => !parsedSigs.some((p) => p.sc === s.sc)), ...parsedSigs];
				sigTextsOpen = [...sigTextsOpen, ...sigTexts];
				void recall.network().then((n) => n && remember.network({ ...n, sigs: sigTextsOpen }));
			} else throw new Error('Zuerst eine Netzdatei (.inpx) öffnen.');
			running = false;
			restart();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function openFiles(files: FileList | File[] | null | undefined): Promise<void> {
		const all = [...(files ?? [])];
		if (!all.length) return;
		const net = all.find((f) => /\.inpx$/i.test(f.name));
		const sigFiles = all.filter((f) => /\.sig$/i.test(f.name));
		if (!net && !sigFiles.length) {
			error = 'Bitte eine Vissim-Netzdatei (.inpx) wählen, dazu die Signalprogramme (.sig).';
			return;
		}
		load(net ? await net.text() : null, await Promise.all(sigFiles.map((f) => f.text())), net?.name ?? fileName);
	}

	async function openSample(): Promise<void> {
		try {
			const [inpx, sig] = await Promise.all(['samples/beispiel.inpx', 'samples/beispiel.sig'].map((u) => fetch(staticFile(u)).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${u}: ${r.status}`))))));
			load(inpx, [sig], 'beispiel.inpx');
		} catch (e) {
			error = `Beispiel konnte nicht geladen werden: ${e instanceof Error ? e.message : e}`;
		}
	}

	function fit(): void {
		if (mode === '3d') scene?.fit();
		else if (rt && canvas) view = fitView(rt, canvas.clientWidth, canvas.clientHeight);
	}

	function setMode(m: '3d' | '2d'): void {
		mode = m;
		// the 2D canvas has no size while it is hidden: fit it when it first shows
		if (m === '2d' && rt) requestAnimationFrame(() => rt && canvas && view.scale === 1 && (view = fitView(rt, canvas.clientWidth, canvas.clientHeight)));
	}

	// ---- pan and zoom
	let drag: { x: number; y: number } | null = null;
	function onWheel(e: WheelEvent): void {
		if (!canvas) return;
		e.preventDefault();
		const r = canvas.getBoundingClientRect();
		const mx = e.clientX - r.left - r.width / 2;
		const my = e.clientY - r.top - r.height / 2;
		const k = Math.exp(-e.deltaY * 0.0015);
		const scale = Math.min(200, Math.max(0.05, view.scale * k));
		// keep the point under the cursor where it is
		view = { cx: view.cx + mx / view.scale - mx / scale, cy: view.cy - my / view.scale + my / scale, scale };
	}
	function onPointerDown(e: PointerEvent): void {
		drag = { x: e.clientX, y: e.clientY };
		canvas?.setPointerCapture(e.pointerId);
	}
	function onPointerMove(e: PointerEvent): void {
		if (!drag) return;
		view = { ...view, cx: view.cx - (e.clientX - drag.x) / view.scale, cy: view.cy + (e.clientY - drag.y) / view.scale };
		drag = { x: e.clientX, y: e.clientY };
	}

	/** Brings back the network and the controller program of the last visit. */
	async function restore(): Promise<void> {
		const [network, controller] = await Promise.all([recall.network(), recall.controller()]);
		if (fileName) return; // something was opened in the meantime
		if (network) {
			restoring = true;
			try {
				load(network.inpx, network.sigs, network.name);
			} finally {
				restoring = false;
			}
		}
		if (controller) {
			if (controller.progNo) vaProgNo = controller.progNo;
			vaShow(controller.program);
			if (controller.startAt) vaStartAt = controller.startAt;
			if (controller.active && rt) vaConnectEmulated();
		}
	}

	onMount(() => {
		void restore();
		fetch(staticFile('samples/beispiel.inpx'), { method: 'HEAD' }).then((r) => (hasSample = r.ok && !(r.headers.get('content-type') ?? '').includes('text/html')), () => {});
		let raf = 0;
		let last = performance.now();
		let debt = 0; // simulation time still to run
		let lastSnapshot = 0;
		const frame = (now: number): void => {
			raf = requestAnimationFrame(frame);
			if (mode === '3d' && host3d && !scene) {
				scene = new Scene3D(host3d);
				scene.setNetwork(rt);
			}
			const c = canvas;
			if (!c) return;
			const dpr = window.devicePixelRatio || 1;
			const w = c.clientWidth;
			const h = c.clientHeight;
			if (mode === '2d' && w && h && (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr))) {
				c.width = Math.round(w * dpr);
				c.height = Math.round(h * dpr);
			}
			const elapsed = Math.min(0.1, (now - last) / 1000);
			last = now;
			if (vaConnecting) debt = 0;
			else if (sim && running && speed === MAX) {
				debt = 0;
				if (!vaBusy) burst();
			} else if (sim && running) {
				debt += elapsed * speed;
				let steps = 0;
				while (debt >= sim.dt && steps < 400 && !sim.finished) {
					// under external control the simulation runs second by second: at each
					// full second it hands over its data and waits for the controller
					if (va && sim.time >= va.nextExchange - 1e-9) {
						vaExchange();
						debt = 0;
						break;
					}
					sim.step();
					debt -= sim.dt;
					steps++;
				}
				if (sim.finished) {
					running = false;
					debt = 0;
				}
				if (steps >= 400) debt = 0; // cannot keep up: do not pile up
			} else debt = 0;
			if (mode === '3d') scene?.render(sim);
			else {
				const ctx = c.getContext('2d')!;
				ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
				draw(ctx, w, h, view, rt, sim);
			}
			if (now - lastSnapshot > 200) {
				lastSnapshot = now;
				snapshot();
			}
		};
		raf = requestAnimationFrame(frame);
		if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__vissim = { get sim() { return sim; }, get rt() { return rt; }, setView: (v: View) => (view = v),
			// runs the simulation for `seconds` without the frame loop, exchanging with the controller like it does
			pump: async (seconds: number) => {
				const end = (sim?.time ?? 0) + seconds;
				while (sim && sim.time < end - 1e-9) {
					if (va && transport && sim.time >= va.nextExchange - 1e-9) {
						va.apply(await transport.step(va.input()));
						vaCycleSecond = va.cycleSecond;
					} else sim.step();
				}
				snapshot();
			}, get scene() { return scene; }, step: (n = 1) => { for (let i = 0; i < n && sim; i++) sim.step(); snapshot(); } };
		return () => {
			cancelAnimationFrame(raf);
			scene?.dispose();
			scene = null;
			transport?.stop();
		};
	});

	const clock = (t: number): string => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
	const btn = 'inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-sm hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-transparent';
</script>

{#snippet vaSettings()}
	<div class="mt-2 grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5 text-xs text-slate-300">
		<label for="va-prog" title="Das Signalprogramm, das die Steuerung fahren soll. Vorgabe aus der Netzdatei.">Signalprogramm</label>
		{#if vaPrograms.length}
			<select id="va-prog" class="rounded border border-slate-600 bg-slate-900 px-1.5 py-0.5" value={vaProgNo} onchange={(e) => vaChange(() => (vaProgNo = +e.currentTarget.value))}>
				{#each vaPrograms as p (p.no)}<option value={p.no}>{p.no}{p.name ? ` – ${p.name}` : ''}{p.no === vaDefaults.progNo ? ' (Netzdatei)' : ''}</option>{/each}
			</select>
		{:else}
		<input id="va-prog" class="w-16 rounded border border-slate-600 bg-slate-900 px-1.5 py-0.5 text-right tabular-nums" type="number" min="1" max="99" step="1" value={vaProgNo} onchange={(e) => vaChange(() => (vaProgNo = Math.max(1, Math.round(+e.currentTarget.value) || vaDefaults.progNo)))} />
		{/if}
		<label for="va-start" title="Datum und Uhrzeit, die das Steuerungsprogramm als Rechneruhr sieht. Vorgabe: heute, Startzeit aus der Netzdatei.">Startzeit</label>
		<input id="va-start" class="rounded border border-slate-600 bg-slate-900 px-1.5 py-0.5 [color-scheme:dark]" type="datetime-local" value={vaStartAt} onchange={(e) => vaChange(() => (vaStartAt = e.currentTarget.value || vaDefaults.startAt))} />
	</div>
	{#if vaActive}<p class="mt-1 text-xs text-slate-500">Eine Änderung startet Steuerung und Simulation neu.</p>{/if}
{/snippet}

{#if showInflows}
	<InflowCharts rows={ui.inputs} {history} time={ui.time} onclose={() => (showInflows = false)} />
{/if}

<svelte:head><title>{fileName ? `${fileName} – Vissim-Simulation` : 'Vissim-Simulation'}</title></svelte:head>

<div
	class="flex h-screen flex-col bg-slate-900 text-slate-100 select-none"
	role="application"
	ondragover={(e) => { e.preventDefault(); dragOver = true; }}
	ondragleave={() => (dragOver = false)}
	ondrop={(e) => { e.preventDefault(); dragOver = false; openFiles(e.dataTransfer?.files); }}
>
	<header class="flex flex-wrap items-center gap-1 border-b border-slate-700 bg-slate-800 px-2 py-1.5">
		<label class="{btn} cursor-pointer bg-sky-600 hover:bg-sky-500">
			<span class="material-symbols-outlined text-[18px]">folder_open</span> Öffnen
			<input class="hidden" type="file" multiple accept=".inpx,.sig" onchange={(e) => { openFiles(e.currentTarget.files); e.currentTarget.value = ''; }} />
		</label>
		{#if hasSample}<button class={btn} onclick={openSample} title="Das Beispielnetz aus static/samples laden">Beispiel</button>{/if}
		<span class="mx-1 h-5 w-px bg-slate-600"></span>
		<button class={btn} disabled={!fileName || ui.finished || vaConnecting} title={vaConnecting ? 'Die Steuerung wird geladen…' : undefined} onclick={() => (running = !running)}>
			<span class="material-symbols-outlined text-[18px]">{running ? 'pause' : 'play_arrow'}</span>{running ? 'Pause' : 'Start'}
		</button>
		<button class={btn} disabled={!fileName} onclick={() => { running = false; restart(); }}>
			<span class="material-symbols-outlined text-[18px]">restart_alt</span> Neu starten
		</button>
		<div class="ml-1 flex overflow-hidden rounded border border-slate-600" role="group" aria-label="Simulationsgeschwindigkeit">
			{#each SPEEDS as s (s)}
				<button class="px-2 py-1 text-xs {speed === s ? 'bg-sky-600' : 'hover:bg-slate-700'}" aria-pressed={speed === s} title={s === MAX ? 'So schnell, wie dieser Rechner es schafft' : undefined} onclick={() => (speed = s)}>{s === MAX ? 'Max' : `${s}×`}</button>
			{/each}
		</div>
		<div class="ml-1 flex overflow-hidden rounded border border-slate-600" role="group" aria-label="Ansicht">
			{#each ['3d', '2d'] as const as m (m)}
				<button class="px-2 py-1 text-xs {mode === m ? 'bg-sky-600' : 'hover:bg-slate-700'}" aria-pressed={mode === m} onclick={() => setMode(m)}>{m.toUpperCase()}</button>
			{/each}
		</div>
		<button class={btn} disabled={!fileName} onclick={fit} title="Ganzes Netz zeigen"><span class="material-symbols-outlined text-[18px]">fit_screen</span></button>
		<div class="ml-auto flex items-center gap-4 px-2 text-sm tabular-nums text-slate-300">
			{#if fileName}
				<span>Zeit {clock(ui.time)} / {clock(ui.period)}{ui.finished ? ' · beendet' : ''}</span>
				<span>{ui.vehicles} Fahrzeuge{footpaths ? `, ${ui.pedestrians} Fußgänger` : ''}</span>
				{#if ui.collisions}<span class="text-red-300" title="Fahrzeuge, die sich überlappt haben – ein Fehler der Simulation oder fehlende Vorfahrtsregeln im Netz">{ui.collisions} Kollisionen</span>{/if}
				{#if ui.diffused}<span class="text-amber-300" title="Fahrzeuge, die zu lange auf einen nötigen Fahrstreifenwechsel gewartet haben und aus dem Netz genommen wurden (wie in Vissim, Diffusionszeit der Netzdatei)">{ui.diffused} entfernt</span>{/if}
			{/if}
			<span class="max-w-64 truncate text-slate-400">{fileName}</span>
		</div>
	</header>

	{#if error}
		<div class="flex items-center gap-2 bg-red-900/70 px-3 py-1.5 text-sm" role="alert">
			<span class="material-symbols-outlined text-[18px]">error</span>{error}
			<button class="ml-auto underline" onclick={() => (error = '')}>Schließen</button>
		</div>
	{/if}

	<div class="flex min-h-0 flex-1">
		<main class="relative min-w-0 flex-1">
			<div bind:this={host3d} class="absolute inset-0" class:hidden={mode !== '3d'}></div>
			<canvas bind:this={canvas} class:hidden={mode !== '2d'} class="h-full w-full cursor-grab touch-none active:cursor-grabbing" onwheel={onWheel} onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={() => (drag = null)} onpointercancel={() => (drag = null)}></canvas>
			{#if !fileName}
				<div class="pointer-events-none absolute inset-0 flex items-center justify-center">
					<div class="max-w-md rounded-lg border border-dashed border-slate-600 p-8 text-center text-slate-300">
						<span class="material-symbols-outlined text-5xl text-slate-500">traffic</span>
						<p class="mt-2 text-lg">Vissim-Netz öffnen</p>
						<p class="mt-1 text-sm text-slate-400">Eine .inpx-Datei hierher ziehen oder über „Öffnen“ wählen. Die Festzeitprogramme (.sig) gleich mit auswählen.</p>
					</div>
				</div>
			{/if}
			{#if dragOver}
				<div class="pointer-events-none absolute inset-2 rounded-lg border-2 border-dashed border-sky-400 bg-sky-500/10"></div>
			{/if}
		</main>

		{#if fileName}
			<aside class="w-80 shrink-0 overflow-y-auto border-l border-slate-700 bg-slate-800 text-sm select-text">
				<section class="border-b border-slate-700 p-3">
					<h2 class="mb-1.5 text-xs font-semibold tracking-wide text-slate-400 uppercase">Netz</h2>
					<p class="text-slate-300">{info.links} Strecken, {info.connectors} Verbinder, {info.heads} Signalgeber, {info.detectors} Detektoren, {info.zones} Konfliktflächen mit Vorfahrt</p>
					<p class="mt-1 text-xs text-slate-500">Dateiformat Version {info.version}</p>
				</section>

				<section class="border-b border-slate-700 p-3">
					<h2 class="mb-1.5 text-xs font-semibold tracking-wide text-slate-400 uppercase">Signalsteuerung</h2>
					{#if vaActive}
						<p class="text-slate-300">Verkehrsabhängig: <span class="text-emerald-300">{vaLabel}</span> steuert. Umlaufsekunde {vaCycleSecond}.</p>
						{@render vaSettings()}
						{#each vaNotes as n (n)}<p class="mt-1 text-xs text-slate-500">{n}</p>{/each}
						<button class="mt-2 rounded border border-slate-600 px-2 py-1 text-xs hover:bg-slate-700" onclick={vaDisconnect}>Trennen (zurück zur Festzeit)</button>
					{:else}
						{#if vaConnecting}
							<p class="text-amber-300">Die Steuerung wird geladen…</p>
						{:else if noProgram}
							<p class="text-amber-300">Keine Signalsteuerung: Es ist kein Festzeitprogramm (.sig) geladen, die Signalgeber werden ignoriert.</p>
						{:else}
							<p class="text-slate-300">Festzeit aus der .sig-Datei.</p>
						{/if}
						<details class="mt-2">
							<summary class="cursor-pointer text-xs text-sky-300">Steuerungsprogramm hochladen (verkehrsabhängige Steuerung)</summary>
							<div class="mt-2 grid gap-1.5 text-xs">
								<p class="text-slate-400">Steuerungsprogramm (*.exe) und Versorgungsdateien (*.vsg, *.vag) zusammen auswählen. Die Dateien bleiben auf diesem Rechner: Das Programm wird hier im Browser emuliert.</p>
								<label class="cursor-pointer rounded border border-slate-600 px-2 py-1.5 text-center hover:bg-slate-700">
									Dateien wählen…
									<input class="hidden" type="file" multiple accept=".exe,.vsg,.vag,.ini,.wtt" onchange={(e) => { void vaUpload(e.currentTarget.files); e.currentTarget.value = ''; }} />
								</label>
								{#if uploadNames}<p class="break-words text-slate-300">{uploadNames}</p>{/if}
								{@render vaSettings()}
								<button class="rounded bg-sky-600 px-2 py-1.5 hover:bg-sky-500 disabled:opacity-50" disabled={vaConnecting || !uploadNames} onclick={vaConnectEmulated}>{vaConnecting ? 'Steuerung wird geladen…' : 'Starten'}</button>
							</div>
						</details>
					{/if}
					{#if vaError}<p class="mt-2 text-xs text-red-300" role="alert">{vaError}</p>{/if}
				</section>

				<section class="border-b border-slate-700 p-3">
					<div class="mb-1.5 flex items-center">
						<h2 class="text-xs font-semibold tracking-wide text-slate-400 uppercase">Zuflüsse</h2>
						<button class="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-sky-300 hover:bg-slate-700" onclick={() => (showInflows = true)} title="Zuflüsse als Diagramme ansehen">
							<span class="material-symbols-outlined text-[16px]">bar_chart</span>Diagramme
						</button>
					</div>
					<table class="w-full tabular-nums">
						<thead class="text-xs text-slate-400">
							<tr><th class="text-left font-normal">Strecke</th><th class="text-right font-normal">Fz/h</th><th class="text-right font-normal">ein</th><th class="text-right font-normal">wartet</th><th class="text-right font-normal">aus</th><th class="text-right font-normal" title="Mittlere Verlustzeit der ausgefahrenen Fahrzeuge">Verlust</th></tr>
						</thead>
						<tbody>
							{#each ui.inputs as i (i.no)}
								<tr><td>{i.link}</td><td class="text-right">{i.volume}</td><td class="text-right">{i.entered}</td><td class="text-right">{i.waiting}</td><td class="text-right">{i.left}</td><td class="text-right">{i.delay.toFixed(0)} s</td></tr>
							{/each}
						</tbody>
					</table>
					{#if footpaths}
						<label class="mt-2 flex items-center gap-2 text-xs text-slate-300" title="Die Netzdatei enthält für die Furten keine Fußgängermengen: Dieser Wert gilt für jede Furt und Richtung.">
							Fußgänger je Furt
							<input class="w-16 rounded border border-slate-600 bg-slate-900 px-1.5 py-0.5 text-right tabular-nums" type="number" min="0" max="3000" step="50" value={pedestriansPerHour} onchange={(e) => { pedestriansPerHour = Math.max(0, +e.currentTarget.value || 0); if (sim) sim.pedestriansPerHour = pedestriansPerHour; }} />
							Pers./h
						</label>
					{/if}
				</section>

				<section class="border-b border-slate-700 p-3">
					<h2 class="mb-1.5 text-xs font-semibold tracking-wide text-slate-400 uppercase">Signalgruppen</h2>
					<ul class="grid grid-cols-2 gap-x-3 gap-y-1">
						{#each ui.groups as g (g.key)}
							<li class="flex items-center gap-2"><span class="h-3 w-3 shrink-0 rounded-full" style:background={SIGNAL_COLORS[g.state]}></span><span class="truncate">{g.name}</span><span class="ml-auto text-xs text-slate-400">{STATE_LABEL[g.state]}</span></li>
						{/each}
					</ul>
				</section>

				<section class="border-b border-slate-700 p-3">
					<h2 class="mb-1.5 text-xs font-semibold tracking-wide text-slate-400 uppercase">Detektoren</h2>
					<ul class="grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums">
						{#each ui.detectors as d (d.no)}
							<li class="flex items-center gap-2"><span class="h-2.5 w-2.5 shrink-0 rounded-sm border border-sky-400 {d.occupied ? 'bg-sky-400' : ''}"></span><span class="truncate">{d.name}</span><span class="ml-auto text-xs text-slate-400">{d.count}</span></li>
						{/each}
					</ul>
				</section>

				{#if notes.length}
					<section class="p-3">
						<h2 class="mb-1.5 text-xs font-semibold tracking-wide text-slate-400 uppercase">Hinweise</h2>
						<ul class="list-disc space-y-1 pl-4 text-xs text-amber-200/90">
							{#each notes as n (n)}<li>{n}</li>{/each}
						</ul>
					</section>
				{/if}
			</aside>
		{/if}
	</div>
</div>
