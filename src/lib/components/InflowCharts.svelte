<script lang="ts" module>
	export interface InflowRow {
		no: number;
		link: number;
		/** demand (veh/h) */
		volume: number;
		entered: number;
		waiting: number;
		left: number;
		/** mean delay (s) of the vehicles that left so far */
		delay: number;
	}
	/** The inflows at one moment of the simulation. */
	export interface InflowSample {
		time: number;
		rows: InflowRow[];
	}
</script>

<script lang="ts">
	// Popup with the inflow figures as charts: demand against what really got
	// in, and the mean delay over time – one colour per inflow link.
	let { rows, history, time, onclose }: { rows: InflowRow[]; history: InflowSample[]; time: number; onclose: () => void } = $props();

	// categorical colours for the dark surface (validated against it); a ninth inflow and beyond share the neutral
	const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767'];
	const OTHER = '#8b97a8';
	const color = (i: number): string => SERIES[i] ?? OTHER;

	let dialog = $state<HTMLDialogElement>();
	$effect(() => {
		if (dialog && !dialog.open) dialog.showModal();
	});

	const clock = (t: number): string => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
	/** vehicles per hour so far */
	const rate = (r: InflowRow): number => (time > 0 ? Math.round((r.entered / time) * 3600) : 0);

	/** A "nice" axis maximum and its ticks. */
	function axis(max: number, count = 4): { max: number; ticks: number[] } {
		const raw = Math.max(max, 1e-9) / count;
		const pow = Math.pow(10, Math.floor(Math.log10(raw)));
		const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
		const top = Math.ceil(Math.max(max, step) / step) * step;
		return { max: top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => +(i * step).toFixed(6)) };
	}

	// ---- chart 1: demand and actual inflow (horizontal bars with a demand marker)
	const BAR = { left: 76, right: 150, row: 34, width: 640 };
	const flow = $derived(axis(Math.max(...rows.map((r) => Math.max(r.volume, rate(r))), 1)));
	const fx = (v: number): number => BAR.left + (v / flow.max) * (BAR.width - BAR.left - BAR.right);

	// ---- chart 2: mean delay over time (lines)
	const LINE = { left: 44, right: 74, top: 12, bottom: 28, width: 640, height: 250 };
	const samples = $derived(history.length ? history : [{ time, rows }]);
	const tMax = $derived(Math.max(samples[samples.length - 1].time, 10));
	const delayAxis = $derived(axis(Math.max(...samples.flatMap((s) => s.rows.map((r) => r.delay)), 5)));
	const lx = (t: number): number => LINE.left + (t / tMax) * (LINE.width - LINE.left - LINE.right);
	const ly = (v: number): number => LINE.height - LINE.bottom - (v / delayAxis.max) * (LINE.height - LINE.top - LINE.bottom);
	const lines = $derived(
		rows.map((r, i) => ({
			row: r,
			color: color(i),
			path: samples.map((s, k) => `${k ? 'L' : 'M'}${lx(s.time).toFixed(1)},${ly(s.rows[i]?.delay ?? 0).toFixed(1)}`).join(''),
			end: samples[samples.length - 1].rows[i]?.delay ?? 0
		}))
	);
	const timeTicks = $derived(axis(tMax, 5).ticks.filter((t) => t <= tMax));
	/** end labels, pushed apart so they do not overlap */
	const endLabels = $derived.by(() => {
		const sorted = lines.map((l, i) => ({ i, y: ly(l.end) })).sort((a, b) => a.y - b.y);
		for (let k = 1; k < sorted.length; k++) sorted[k].y = Math.max(sorted[k].y, sorted[k - 1].y + 13);
		const out: number[] = [];
		for (const s of sorted) out[s.i] = s.y;
		return out;
	});

	// ---- hover
	let tip = $state<{ x: number; y: number; title: string; lines: { color?: string; text: string }[] } | null>(null);
	let cross = $state<number | null>(null);
	let body = $state<HTMLDivElement>();
	function place(e: PointerEvent): { x: number; y: number } {
		const box = body!.getBoundingClientRect();
		return { x: Math.min(e.clientX - box.left + 14, box.width - 210), y: e.clientY - box.top + 14 };
	}
	function overBar(e: PointerEvent, r: InflowRow, i: number): void {
		tip = {
			...place(e),
			title: `Strecke ${r.link}`,
			lines: [
				{ color: color(i), text: `Ist ${rate(r)} Fz/h (${r.entered} eingefahren)` },
				{ text: `Soll ${r.volume} Fz/h` },
				{ text: `${r.waiting} warten vor dem Netz, ${r.left} ausgefahren` }
			]
		};
	}
	function overLine(e: PointerEvent): void {
		const svg = e.currentTarget as SVGSVGElement;
		const box = svg.getBoundingClientRect();
		const x = ((e.clientX - box.left) / box.width) * LINE.width;
		const t = ((x - LINE.left) / (LINE.width - LINE.left - LINE.right)) * tMax;
		let best = samples[0];
		for (const s of samples) if (Math.abs(s.time - t) < Math.abs(best.time - t)) best = s;
		cross = lx(best.time);
		tip = { ...place(e), title: `Zeit ${clock(best.time)}`, lines: best.rows.map((r, i) => ({ color: color(i), text: `Strecke ${r.link}: ${r.delay.toFixed(1)} s` })) };
	}
	function leave(): void {
		tip = null;
		cross = null;
	}
</script>

<dialog bind:this={dialog} class="m-auto w-[min(760px,94vw)] rounded-lg border border-slate-600 bg-slate-800 p-0 text-slate-100 shadow-2xl backdrop:bg-black/60" onclose={onclose}>
	<div bind:this={body} class="relative p-5">
		<div class="mb-4 flex items-center">
			<h2 class="text-base font-semibold">Zuflüsse</h2>
			<span class="ml-3 text-sm text-slate-400">Stand {clock(time)}</span>
			<button class="ml-auto rounded px-2 py-1 text-sm text-slate-300 hover:bg-slate-700" onclick={() => dialog?.close()} aria-label="Schließen">Schließen</button>
		</div>

		<h3 class="text-sm font-medium">Zufluss: Soll und Ist</h3>
		<p class="mb-1 text-xs text-slate-400">Fahrzeuge pro Stunde. Ist: hochgerechnet aus den bisher eingefahrenen Fahrzeugen.</p>
		<div class="mb-1 flex gap-4 text-xs text-slate-300">
			<span class="flex items-center gap-1.5"><span class="inline-block h-2.5 w-5 rounded-r" style:background={SERIES[0]}></span>Ist (Farbe je Strecke)</span>
			<span class="flex items-center gap-1.5"><span class="inline-block h-4 w-0.5 bg-slate-100"></span>Soll</span>
		</div>
		<svg viewBox="0 0 {BAR.width} {rows.length * BAR.row + 24}" class="w-full" role="img" aria-label="Balkendiagramm: Soll- und Ist-Zufluss je Strecke">
			{#each flow.ticks as t (t)}
				<line x1={fx(t)} x2={fx(t)} y1="0" y2={rows.length * BAR.row} stroke="#334155" stroke-width="1" />
				<text x={fx(t)} y={rows.length * BAR.row + 15} text-anchor="middle" font-size="11" fill="#94a3b8">{t}</text>
			{/each}
			{#each rows as r, i (r.no)}
				{@const y = i * BAR.row + (BAR.row - 16) / 2}
				{@const w = Math.max(0, fx(rate(r)) - BAR.left)}
				<g role="img" aria-label="Strecke {r.link}: Ist {rate(r)}, Soll {r.volume} Fahrzeuge pro Stunde" onpointermove={(e) => overBar(e, r, i)} onpointerleave={leave}>
					<rect x="0" y={i * BAR.row} width={BAR.width} height={BAR.row} fill="transparent" />
					<text x={BAR.left - 8} y={y + 12} text-anchor="end" font-size="12" fill="#cbd5e1">Strecke {r.link}</text>
					<!-- bar: square at the baseline, rounded at the data end -->
					<path d="M{BAR.left},{y} h{Math.max(0, w - 4)} a4,4 0 0 1 4,4 v8 a4,4 0 0 1 -4,4 h-{Math.max(0, w - 4)} z" fill={color(i)} />
					<line x1={fx(r.volume)} x2={fx(r.volume)} y1={y - 5} y2={y + 21} stroke="#f1f5f9" stroke-width="2" />
					<text x={Math.max(fx(rate(r)), fx(r.volume)) + 8} y={y + 12} font-size="12" fill="#f1f5f9">{rate(r)} <tspan fill="#94a3b8">von {r.volume}</tspan></text>
				</g>
			{/each}
		</svg>

		<h3 class="mt-5 text-sm font-medium">Mittlere Verlustzeit im Zeitverlauf</h3>
		<p class="mb-1 text-xs text-slate-400">Sekunden je Fahrzeug, gemittelt über alle bis dahin ausgefahrenen Fahrzeuge der Strecke.</p>
		<div class="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-300">
			{#each lines as l (l.row.no)}
				<span class="flex items-center gap-1.5"><span class="inline-block h-0.5 w-5" style:background={l.color}></span>Strecke {l.row.link}</span>
			{/each}
		</div>
		<svg viewBox="0 0 {LINE.width} {LINE.height}" class="w-full" role="img" aria-label="Liniendiagramm: mittlere Verlustzeit je Strecke über die Simulationszeit" onpointermove={overLine} onpointerleave={leave}>
			{#each delayAxis.ticks as t (t)}
				<line x1={LINE.left} x2={LINE.width - LINE.right} y1={ly(t)} y2={ly(t)} stroke="#334155" stroke-width="1" />
				<text x={LINE.left - 8} y={ly(t) + 4} text-anchor="end" font-size="11" fill="#94a3b8">{t}</text>
			{/each}
			{#each timeTicks as t (t)}
				<text x={lx(t)} y={LINE.height - 8} text-anchor="middle" font-size="11" fill="#94a3b8">{clock(t)}</text>
			{/each}
			{#if cross !== null}<line x1={cross} x2={cross} y1={LINE.top} y2={LINE.height - LINE.bottom} stroke="#94a3b8" stroke-width="1" />{/if}
			{#each lines as l, i (l.row.no)}
				<path d={l.path} fill="none" stroke={l.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
				<circle cx={lx(samples[samples.length - 1].time)} cy={ly(l.end)} r="4" fill={l.color} stroke="#1e293b" stroke-width="2" />
				{#if lines.length <= 4}
					<text x={lx(samples[samples.length - 1].time) + 9} y={endLabels[i] + 4} font-size="11" fill="#f1f5f9">{l.end.toFixed(0)} s <tspan fill="#94a3b8">Str. {l.row.link}</tspan></text>
				{/if}
			{/each}
		</svg>

		<details class="mt-4 text-sm">
			<summary class="cursor-pointer text-xs text-sky-300">Als Tabelle</summary>
			<table class="mt-2 w-full tabular-nums">
				<thead class="text-xs text-slate-400">
					<tr><th class="text-left font-normal">Strecke</th><th class="text-right font-normal">Soll Fz/h</th><th class="text-right font-normal">Ist Fz/h</th><th class="text-right font-normal">eingefahren</th><th class="text-right font-normal">wartet</th><th class="text-right font-normal">ausgefahren</th><th class="text-right font-normal">Verlust</th></tr>
				</thead>
				<tbody>
					{#each rows as r (r.no)}
						<tr><td>{r.link}</td><td class="text-right">{r.volume}</td><td class="text-right">{rate(r)}</td><td class="text-right">{r.entered}</td><td class="text-right">{r.waiting}</td><td class="text-right">{r.left}</td><td class="text-right">{r.delay.toFixed(1)} s</td></tr>
					{/each}
				</tbody>
			</table>
		</details>

		{#if tip}
			<div class="pointer-events-none absolute z-10 w-48 rounded border border-slate-600 bg-slate-900 px-2.5 py-2 text-xs shadow-lg" style:left="{tip.x}px" style:top="{tip.y}px">
				<div class="mb-1 font-medium text-slate-100">{tip.title}</div>
				{#each tip.lines as l (l.text)}
					<div class="flex items-center gap-1.5 text-slate-300">{#if l.color}<span class="inline-block h-2 w-2 shrink-0 rounded-full" style:background={l.color}></span>{/if}{l.text}</div>
				{/each}
			</div>
		{/if}
	</div>
</dialog>
