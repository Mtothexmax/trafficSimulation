// Traffic-actuated control by an external signal controller program:
// what the simulation sends it every second (detector values, signal states)
// and how its answer becomes signal states. Running the program is the
// emulator's part (./exe); this part is pure and runs in tests.
//
// The codes are those of SC_Interface.h of the Vissim API.
import type { SignalController } from './inpx';
import type { SignalState } from './sig';
import type { Simulation } from './sim';

/** (code, index, value) */
export type Triple = [number, number, number];

export const CODE = {
	UMLAUFZEIT: 1001,
	UMLAUFSEKUNDE: 1002,
	PROGRAMMNUMMER: 1011,
	IST_BILD: 2001,
	SOLL_BILD: 2002,
	SOLL_BILD_O_UE: 2003,
	T_GRUEN_MIN: 2011,
	T_ROT_MIN: 2012,
	T_ROTGELB: 2013,
	T_GELB: 2014,
	LAUFZEIT: 2021,
	ANWESENHEIT: 3001,
	IMPULSSPEICHER: 3011,
	VORDERKANTEN: 3012,
	ANG_ZEITLUECKE: 3021,
	KOMPL_ZEITLUECKE: 3022,
	ANG_BELEGUNG: 3031,
	AKT_BELEGUNG: 3040,
	GEGL_BELEGUNG: 3041
} as const;

/** Signal pictures of the interface (BILD_*). */
const BILD: Record<SignalState, number> = { off: 0, red: 2, redamber: 3, green: 4, amber: 5, amberflash: 6 };
const STATE_OF_BILD: Record<number, SignalState> = { 0: 'off', 1: 'green', 2: 'red', 3: 'redamber', 4: 'green', 5: 'amber', 6: 'amberflash', 7: 'red', 8: 'green', 9: 'amberflash', 10: 'amber' };

interface Group {
	no: number;
	state: SignalState;
	/** simulation time the state began */
	since: number;
	/** state to switch to once the transition (red/amber, amber) is over */
	then: { state: SignalState; at: number } | null;
	amber: number;
	redAmber: number;
}

/** Smoothing factor of the smoothed occupancy (per interval). */
const SMOOTHING = 0.25;

export class VaBridge {
	/** cycle second as reported by the controller */
	cycleSecond = 0;
	/** simulation time of the next exchange with the controller */
	nextExchange = 0;
	private readonly groups: Group[];
	/** detector channel → detector numbers of the network on that channel */
	private readonly channels = new Map<number, number[]>();
	private readonly smoothed = new Map<number, number>();

	/** `progNo`: the signal program the controller is to run (default: the one the network file names) */
	constructor(
		private readonly sim: Simulation,
		readonly controller: SignalController,
		readonly progNo: number = controller.progNo
	) {
		this.groups = controller.groups.map((g) => ({ no: g.no, state: 'red', since: 0, then: null, amber: g.amber, redAmber: g.redAmber }));
		for (const d of sim.rt.detectors) {
			if (d.sc !== controller.no || d.type !== 'STANDARD' || d.portNo <= 0) continue;
			this.channels.set(d.portNo, [...(this.channels.get(d.portNo) ?? []), d.no]);
		}
		sim.controlExternally(controller.no);
		sim.onSignals = (time) => this.advance(time);
		this.publish();
	}

	/** Data for "DateiLesen" and "Init": program, cycle time, the signal groups and their times. */
	setup(): Triple[] {
		const out: Triple[] = [
			[CODE.UMLAUFZEIT, 0, Math.round(this.controller.cycleTime)],
			[CODE.PROGRAMMNUMMER, 0, this.progNo]
		];
		for (const g of this.controller.groups) {
			out.push([CODE.IST_BILD, g.no, BILD.red], [CODE.T_GRUEN_MIN, g.no, Math.round(g.minGreen)], [CODE.T_ROT_MIN, g.no, Math.round(g.minRed)], [CODE.T_ROTGELB, g.no, Math.round(g.redAmber)], [CODE.T_GELB, g.no, Math.round(g.amber)]);
		}
		return out;
	}

	/** Data for "Rechnen": the signal states now and the detector values of the
	 * interval since the last call (which this call closes). */
	input(): Triple[] {
		const { sim } = this;
		const t = sim.time;
		const interval = Math.max(sim.dt, t - (this.nextExchange - 1));
		// The controller takes its time from the cycle second it is sent: without
		// it, it never leaves its switched-off state.
		const cycle = Math.max(1, Math.round(this.controller.cycleTime));
		const out: Triple[] = [
			[CODE.UMLAUFSEKUNDE, 0, Math.floor(t + 1e-6) % cycle],
			[CODE.PROGRAMMNUMMER, 0, this.progNo]
		];
		for (const g of this.groups) out.push([CODE.IST_BILD, g.no, BILD[g.state]], [CODE.LAUFZEIT, g.no, Math.floor(t - g.since)]);
		for (const [channel, numbers] of this.channels) {
			let occupied = false, impulse = false, edges = 0, occupiedTime = 0, changedAt = 0, lastGap = 0;
			for (const no of numbers) {
				const st = sim.detectorStates.get(no);
				if (!st) continue;
				occupied ||= st.occupied;
				impulse ||= st.impulse;
				edges += st.edges;
				occupiedTime = Math.max(occupiedTime, st.occupiedTime);
				changedAt = Math.max(changedAt, st.changedAt);
				lastGap = Math.max(lastGap, st.lastGap);
				st.edges = 0;
				st.occupiedTime = 0;
			}
			const share = Math.min(100, Math.round((occupiedTime / interval) * 100));
			const smoothed = (this.smoothed.get(channel) ?? 0) + SMOOTHING * (share - (this.smoothed.get(channel) ?? 0));
			this.smoothed.set(channel, smoothed);
			const hundredths = (s: number): number => Math.min(2_000_000_000, Math.round(s * 100));
			out.push(
				[CODE.ANWESENHEIT, channel, occupied ? 1 : 0],
				[CODE.IMPULSSPEICHER, channel, impulse ? 1 : 0],
				[CODE.VORDERKANTEN, channel, edges],
				[CODE.ANG_ZEITLUECKE, channel, occupied ? 0 : hundredths(t - changedAt)],
				[CODE.KOMPL_ZEITLUECKE, channel, hundredths(lastGap)],
				[CODE.ANG_BELEGUNG, channel, occupied ? hundredths(t - changedAt) : 0],
				[CODE.AKT_BELEGUNG, channel, share],
				[CODE.GEGL_BELEGUNG, channel, Math.round(smoothed)]
			);
		}
		return out;
	}

	/** Takes over what the controller wants. */
	apply(reply: Triple[]): void {
		const t = this.sim.time;
		for (const [code, index, value] of reply) {
			if (code === CODE.UMLAUFSEKUNDE) this.cycleSecond = value;
			else if (code === CODE.IMPULSSPEICHER && value === 0) {
				for (const no of this.channels.get(index) ?? []) {
					const st = this.sim.detectorStates.get(no);
					if (st) st.impulse = false;
				}
			} else if (code === CODE.SOLL_BILD || code === CODE.SOLL_BILD_O_UE) {
				const g = this.groups.find((x) => x.no === index);
				const target = STATE_OF_BILD[value];
				if (!g || !target) continue;
				const current = g.then?.state ?? g.state;
				if (target === current) continue;
				// with transition: red → red/amber → green, green → amber → red
				const via: SignalState | null = code === CODE.SOLL_BILD ? (target === 'green' && g.state === 'red' && g.redAmber > 0 ? 'redamber' : target === 'red' && g.state === 'green' && g.amber > 0 ? 'amber' : null) : null;
				if (via) {
					this.set(g, via, t);
					g.then = { state: target, at: t + (via === 'amber' ? g.amber : g.redAmber) };
				} else {
					this.set(g, target, t);
					g.then = null;
				}
			}
		}
		this.nextExchange = Math.floor(t + 1e-6) + 1;
		this.publish();
	}

	/** Ends the transitions that are due. */
	private advance(time: number): void {
		let changed = false;
		for (const g of this.groups) {
			if (g.then && time >= g.then.at - 1e-9) {
				this.set(g, g.then.state, g.then.at);
				g.then = null;
				changed = true;
			}
		}
		if (changed) this.publish();
	}

	private set(g: Group, state: SignalState, at: number): void {
		if (g.state === state) return;
		g.state = state;
		g.since = at;
	}

	private publish(): void {
		const states = this.sim.external.get(this.controller.no);
		if (states) for (const g of this.groups) states.set(g.no, g.state);
	}
}
