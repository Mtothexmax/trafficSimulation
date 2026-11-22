// Microscopic simulation of a Vissim network.
//
// Vehicles enter at the vehicle inputs, take a static route at the routing
// decisions, follow each other with the car-following model of the link's
// driving behaviour (Wiedemann 74 / 99 with the parameters from the file),
// slow down for reduced speed areas, stop at signal heads, yield at conflict
// areas and change lanes where their route needs it.
//
// The Wiedemann models follow the published descriptions (thresholds and
// regimes); they are not PTV's implementation, so results are similar to
// Vissim's, not identical. A stopping-distance bound keeps every vehicle able
// to stop behind its leader whatever the model says.
import type { DistPoint, DrivingBehavior, FuncPoint, VehicleCategory, VehicleInput, VehicleType } from './inpx';
import { laneKey, lanePose, type ConflictZone, type Pose, type RLink, type Runtime } from './net';
import { groupState, type SigFile, type SignalProgram, type SignalState } from './sig';

export interface Vehicle {
	id: number;
	type: VehicleType;
	category: VehicleCategory;
	length: number;
	width: number;
	/** desired speed (m/s) */
	vdes: number;
	/** the driver's quantile (0..1) in every distribution: desired speeds, accelerations */
	q: number;
	/** driver-specific random numbers of the car-following model */
	z1: number;
	z2: number;
	link: RLink;
	/** lane on the link, 1 = rightmost */
	lane: number;
	/** front bumper along the link (m) */
	s: number;
	v: number;
	a: number;
	/** static route: link numbers, and where on it the vehicle is */
	path: number[] | null;
	pathIdx: number;
	/** connector the vehicle leaves its link by (null: drive to the link end) */
	next: RLink | null;
	/** lane change in progress: remaining time and lateral offset still to cover */
	lcTime: number;
	/** how long the vehicle has been standing because it cannot get onto the lane its route needs (s) */
	lcWait: number;
	lcOffset: number;
	/** signal head the vehicle decided to pass at amber */
	goHead: number;
	/** sideways offset within the lane (m, to the left): pedestrians do not walk in single file */
	lateral: number;
	/** distance to the signal head it is stopping for (Infinity: none) */
	signalStop: number;
	input: number;
	born: number;
	travelled: number;
	segs: Seg[];
}

/** One stretch of the lanes ahead of a vehicle. Distance from its front to
 * position s on the stretch = base + s. */
interface Seg {
	rl: RLink;
	lane: number;
	base: number;
	from: number;
	exit: number;
}

export interface InputStats {
	input: VehicleInput;
	/** vehicles that entered the network */
	entered: number;
	/** vehicles waiting outside because the entry is blocked */
	waiting: number;
	/** vehicles that left the network */
	left: number;
	/** sums over the vehicles that left: travel time and delay (s) */
	travelTime: number;
	delay: number;
}

export interface DetectorState {
	occupied: boolean;
	/** vehicles counted (rising edges) */
	count: number;
	/** time (s) the detector became occupied / free */
	changedAt: number;
	/** the last complete time gap between two vehicles (s) */
	lastGap: number;
	/** since the last `takeInterval`: front edges, and time occupied (s) */
	edges: number;
	occupiedTime: number;
	/** a vehicle has arrived and the controller has not cleared the memory yet */
	impulse: boolean;
}

/** Pedestrians per hour on every footpath when the file gives no demand for them. */
/** how many waiting vehicles of an input may overtake each other on entering */
const ENTRY_QUEUE = 4;
/** how far before the lane two merging connectors start to take turns (m) */
const MERGE_REACH = 40;
export const DEFAULT_PEDESTRIANS_PER_HOUR = 0;

const LANE_CHANGE_TIME = 2.5;
/** Comfortable deceleration (m/s²) vehicles plan their stops with. */
const PLAN_DECEL = 2.5;
/** Reaction time constant (s) of the speed bounds. */
const TAU = 0.6;
const MAX_SEGS = 8;

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Value of a cumulative distribution at quantile q. */
export function quantile(points: DistPoint[] | undefined, q: number, fallback: number): number {
	if (!points?.length) return fallback;
	if (q <= points[0].fx) return points[0].x;
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1];
		const b = points[i];
		if (q <= b.fx) return b.fx > a.fx ? a.x + ((b.x - a.x) * (q - a.fx)) / (b.fx - a.fx) : b.x;
	}
	return points[points.length - 1].x;
}

/** Acceleration function at speed v (m/s) for a driver quantile: between yMin and yMax around y. */
function funcAt(points: FuncPoint[] | undefined, v: number, q: number, fallback: number): number {
	if (!points?.length) return fallback;
	const x = v * 3.6;
	let a = points[0];
	let b = points[points.length - 1];
	if (x <= a.x) b = a;
	else if (x >= b.x) a = b;
	else {
		for (let i = 1; i < points.length; i++) {
			if (x <= points[i].x) {
				a = points[i - 1];
				b = points[i];
				break;
			}
		}
	}
	const t = b.x > a.x ? (x - a.x) / (b.x - a.x) : 0;
	const mix = (k: 'y' | 'yMin' | 'yMax'): number => a[k] + (b[k] - a[k]) * t;
	const y = mix('y');
	return q < 0.5 ? mix('yMin') + (y - mix('yMin')) * (q * 2) : y + (mix('yMax') - y) * (q * 2 - 1);
}

/** Time (s) to cover d from speed v0, accelerating with a up to vmax. */
function travelTime(v0: number, d: number, a: number, vmax: number): number {
	if (d <= 0) return 0;
	if (v0 >= vmax) return d / Math.max(v0, 0.1);
	const dAcc = (vmax * vmax - v0 * v0) / (2 * a);
	if (d <= dAcc) return (-v0 + Math.sqrt(v0 * v0 + 2 * a * d)) / a;
	return (vmax - v0) / a + (d - dAcc) / vmax;
}

/**
 * Wiedemann 74: acceleration behind a leader. `dx` is the net gap (m),
 * `vl` / `al` the leader's speed and acceleration, `aFree` what the vehicle
 * would do on a free road.
 */
export function wiedemann74(v: number, dx: number, vl: number, al: number, aFree: number, b: DrivingBehavior, z1: number, z2: number): number {
	const ax = b.w74ax;
	const bx = (b.w74bxAdd + b.w74bxMult * z1) * Math.sqrt(Math.max(0, Math.min(v, vl)));
	const abx = ax + bx; // desired minimum following distance
	const sdx = ax + (2 + z2) * bx; // upper end of the following distance
	const dv = v - vl; // > 0: closing in
	if (dx <= abx) {
		// too close: brake back out to the minimum distance
		let a = Math.min(al, 0);
		if (dv > 0) a -= (0.5 * dv * dv) / Math.max(dx - ax, 0.2);
		a -= (1.5 * (abx - dx)) / Math.max(bx, 0.5);
		return Math.min(a, aFree);
	}
	// perception threshold of the speed difference grows with the distance
	const cx = 25 * (1 + z1 + z2);
	const sdv = ((dx - ax) / cx) ** 2;
	if (dv > sdv) return Math.min(aFree, Math.min(al, 0) - (0.5 * dv * dv) / (dx - abx)); // approaching: aim at abx
	if (dx < sdx) {
		// following: keep the leader's speed, drift to the middle of the band
		const a = 0.6 * (vl - v) + 0.08 * (dx - (abx + sdx) / 2);
		return Math.min(aFree, Math.max(-1.5, Math.min(1, a)));
	}
	return aFree;
}

/** Wiedemann 99 (CC0 … CC9). Same arguments as `wiedemann74`. */
export function wiedemann99(v: number, dx: number, vl: number, al: number, aFree: number, b: DrivingBehavior, aMax: number): number {
	const [cc0, cc1, cc2, cc3, cc4, cc5, cc6, cc7, cc8, cc9] = b.cc;
	const dv = vl - v; // < 0: closing in
	const vSlower = dv >= 0 || al < -1 ? v : vl;
	const sdxc = cc0 + cc1 * Math.max(0, vSlower); // minimum following distance
	const sdxo = sdxc + cc2; // upper end of the following distance
	const sdxv = sdxo + cc3 * (dv - cc4); // where the vehicle starts to react
	const sdv = (cc6 * dx * dx) / 10000;
	const sdvc = vl > 0 ? cc4 - sdv : 0; // closing threshold
	const sdvo = v > cc5 ? sdv + cc5 : sdv; // opening threshold
	let a: number;
	if (dv < sdvo && dx <= sdxc) {
		// too close
		a = 0;
		if (v > 0) {
			if (dv < 0) {
				a = dx > cc0 ? Math.min(al + (dv * dv) / (cc0 - dx), 0) : Math.min(al + 0.5 * (dv - sdvo), 0);
			}
			a = a > -cc7 ? -cc7 : Math.max(a, -10 + 0.5 * Math.sqrt(v));
		}
	} else if (dv < sdvc && dx < sdxv) {
		// closing in on a slower leader
		a = Math.max((0.5 * dv * dv) / (sdxc - dx - 0.1), -10);
	} else if (dv < sdvo && dx < sdxo) {
		// following: small accelerations around the leader's speed
		a = dv >= 0 ? cc7 : -cc7;
	} else {
		// free
		a = aFree;
		if (dx > sdxc) {
			// cc8: acceleration from standstill, cc9: at 80 km/h
			const max = Math.min(aMax, cc8 + ((cc9 - cc8) * Math.min(v, 80 / 3.6)) / (80 / 3.6));
			a = dx < sdxo ? Math.min((dv * dv) / (sdxo - dx), max) : max;
		}
	}
	return Math.min(a, aFree);
}

export class Simulation {
	time = 0;
	readonly dt: number;
	vehicles: Vehicle[] = [];
	/** signal state per `signalKey(sc, sg)` */
	readonly signals = new Map<number, SignalState>();
	readonly detectorStates = new Map<number, DetectorState>();
	readonly inputStats: InputStats[];
	/** controllers without a signal program: their heads are ignored */
	readonly uncontrolled: number[] = [];
	collisions = 0;
	/** vehicles taken out because they waited too long for a lane change (as Vissim does) */
	diffused = 0;
	/** for diagnosis: called for every overlap counted in `collisions` */
	onCollision?: (v: Vehicle, w: Vehicle, gap: number) => void;
	/** signal states of externally controlled controllers: controller → group → state */
	readonly external = new Map<number, Map<number, SignalState>>();
	/** called before the signal states are taken for a step */
	onSignals: ((time: number) => void) | null = null;
	/** pedestrians per hour on every footpath (the network files carry no pedestrian demand for
	 * these links); can be changed while the simulation runs */
	pedestriansPerHour: number;
	private readonly random: () => number;
	/** own random stream: pedestrians do not change the vehicle traffic */
	private readonly pedRandom: () => number;
	private readonly nextPedestrian: number[];
	private readonly programs = new Map<number, SignalProgram>();
	private readonly nextArrival: number[];
	/** the next vehicles of every input, waiting before the network for room on a lane that fits */
	private readonly pending: Vehicle[][];
	private lanes = new Map<number, Vehicle[]>();
	private nextId = 1;

	constructor(
		readonly rt: Runtime,
		sigs: SigFile[] = [],
		options: { pedestriansPerHour?: number } = {}
	) {
		const sim = rt.net.simulation;
		this.dt = 1 / sim.resolution;
		this.random = mulberry32(sim.randSeed);
		this.pedRandom = mulberry32(sim.randSeed + 7919);
		this.pedestriansPerHour = options.pedestriansPerHour ?? DEFAULT_PEDESTRIANS_PER_HOUR;
		this.nextPedestrian = rt.pedestrianLinks.map(() => -Math.log(1 - this.pedRandom()) * 20);
		for (const c of rt.net.controllers) {
			const program = sigs.find((s) => s.sc === c.no)?.programs[0];
			if (program) this.programs.set(c.no, program);
			else this.uncontrolled.push(c.no);
		}
		this.inputStats = rt.net.inputs.filter((i) => rt.links.has(i.link) && i.volume > 0).map((input) => ({ input, entered: 0, waiting: 0, left: 0, travelTime: 0, delay: 0 }));
		this.nextArrival = this.inputStats.map((s) => this.headway(s.input.volume));
		this.pending = this.inputStats.map(() => []);
		for (const d of rt.detectors) this.detectorStates.set(d.no, { occupied: false, count: 0, changedAt: 0, lastGap: 0, edges: 0, occupiedTime: 0, impulse: false });
		this.updateSignals();
	}

	static signalKey(sc: number, sg: number): number {
		return sc * 1000 + sg;
	}

	/** Has the simulation period of the file run out? */
	get finished(): boolean {
		return this.time >= this.rt.net.simulation.period;
	}

	/** Where a vehicle's front and rear are on the map (for drawing). */
	pose(v: Vehicle): { front: Pose; rear: Pose } {
		const extra = v.lateral + (v.lcTime > 0 ? v.lcOffset * smooth(v.lcTime / LANE_CHANGE_TIME) : 0);
		return { front: lanePose(v.link, v.lane, v.s, extra), rear: lanePose(v.link, v.lane, v.s - v.length, extra) };
	}

	step(): void {
		this.updateSignals();
		this.spawn();
		this.indexLanes();
		for (const v of this.vehicles) v.segs = this.ahead(v);
		const byLink = new Map<number, { w: Vehicle; base: number }[]>();
		for (const w of this.vehicles) {
			for (const seg of w.segs) {
				const l = byLink.get(seg.rl.no);
				if (l) l.push({ w, base: seg.base });
				else byLink.set(seg.rl.no, [{ w, base: seg.base }]);
			}
		}
		for (const v of this.vehicles) v.a = this.accelerate(v, byLink);
		this.move();
		this.detect();
		this.time += this.dt;
	}

	// ------------------------------------------------------------------ signals

	/** Hands a controller to an external control (all its groups red until
	 * that sets them in `external`). */
	controlExternally(sc: number): void {
		const c = this.rt.net.controllers.find((x) => x.no === sc);
		if (!c) return;
		this.external.set(sc, new Map(c.groups.map((g) => [g.no, 'red' as SignalState])));
		const i = this.uncontrolled.indexOf(sc);
		if (i >= 0) this.uncontrolled.splice(i, 1);
		this.updateSignals();
	}

	private updateSignals(): void {
		this.onSignals?.(this.time);
		for (const c of this.rt.net.controllers) {
			const ext = this.external.get(c.no);
			const program = this.programs.get(c.no);
			for (const g of c.groups) this.signals.set(Simulation.signalKey(c.no, g.no), ext ? (ext.get(g.no) ?? 'red') : program ? groupState(program, g.no, this.time) : 'off');
		}
	}

	// ------------------------------------------------------------------ vehicle inputs

	/** Exponential headway (s) of a flow in veh/h. */
	private headway(volume: number): number {
		return (-Math.log(1 - this.random()) * 3600) / volume;
	}

	private normal(): number {
		const u = 1 - this.random();
		return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.random());
	}

	private createVehicle(input: VehicleInput): Vehicle | null {
		const { net, links } = this.rt;
		const comp = net.compositions.get(input.composition)?.filter((c) => net.vehicleTypes.has(c.vehType) && c.relFlow > 0);
		if (!comp?.length) return null;
		let x = this.random() * comp.reduce((s, c) => s + c.relFlow, 0);
		const share = comp.find((c) => (x -= c.relFlow) <= 0) ?? comp[comp.length - 1];
		const type = net.vehicleTypes.get(share.vehType)!;
		const models = net.modelDistributions.get(type.model2D3DDistr);
		let model = { length: 4.5, width: 1.8 };
		if (models?.length) {
			let y = this.random() * models.reduce((s, m) => s + m.share, 0);
			model = models.find((m) => (y -= m.share) <= 0) ?? models[models.length - 1];
		}
		const q = this.random();
		const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
		const v: Vehicle = {
			id: this.nextId++, type, category: type.category, length: model.length, width: Math.min(model.width || 1.8, 2.6),
			vdes: quantile(net.desSpeedDistributions.get(share.desSpeedDistr), q, 50) / 3.6,
			q, z1: clamp01(0.5 + 0.15 * this.normal()), z2: clamp01(0.5 + 0.15 * this.normal()),
			link: links.get(input.link)!, lane: 1, s: 0, v: 0, a: 0, path: null, pathIdx: 0, next: null,
			lcTime: 0, lcWait: 0, lcOffset: 0, lateral: 0, goHead: 0, signalStop: Infinity, input: input.no, born: 0, travelled: 0, segs: []
		};
		this.enterLink(v, v.link);
		return v;
	}

	/** Pedestrians appear at the start of every footpath, at random intervals. */
	private spawnPedestrians(): void {
		const { net } = this.rt;
		const types = [...net.vehicleTypes.values()].filter((t) => t.category === 'PEDESTRIAN');
		if (!types.length) return;
		const walking = [...net.desSpeedDistributions.entries()].find(([no]) => no === 5)?.[1];
		this.rt.pedestrianLinks.forEach((rl, i) => {
			if (this.pedestriansPerHour <= 0) {
				this.nextPedestrian[i] = this.time;
				return;
			}
			while (this.time >= this.nextPedestrian[i]) {
				this.nextPedestrian[i] += (-Math.log(1 - this.pedRandom()) * 3600) / this.pedestriansPerHour;
				const type = types[Math.floor(this.pedRandom() * types.length)];
				const q = this.pedRandom();
				const room = Math.max(0, (rl.link.lanes[0]?.width ?? 2) / 2 - 0.35);
				// walking speed: the file's "5 km/h" distribution if it has one, else 4 – 5.8 km/h
				const vdes = walking ? quantile(walking, q, 5) / 3.6 : 1.1 + 0.5 * q;
				this.vehicles.push({
					id: this.nextId++, type, category: 'PEDESTRIAN', length: 0.45, width: 0.5, vdes, q, z1: 0.5, z2: 0.5,
					link: rl, lane: 1, s: 0, v: vdes, a: 0, path: null, pathIdx: 0, next: null,
					lcTime: 0, lcWait: 0, lcOffset: 0, lateral: (this.pedRandom() * 2 - 1) * room, goHead: 0, signalStop: Infinity, input: -1, born: this.time, travelled: 0, segs: []
				});
			}
		});
	}

	private spawn(): void {
		this.spawnPedestrians();
		this.indexLanes();
		this.inputStats.forEach((st, i) => {
			while (this.time >= this.nextArrival[i]) {
				st.waiting++;
				this.nextArrival[i] += this.headway(st.input.volume);
			}
			if (!st.waiting) return;
			// The first few waiting vehicles may enter in any order: one that finds its lane
			// full does not keep those for the other lanes out.
			const queue = this.pending[i];
			while (queue.length < Math.min(st.waiting, ENTRY_QUEUE)) {
				const made = this.createVehicle(st.input);
				if (!made) break;
				queue.push(made);
			}
			if (!queue.length) {
				st.waiting = 0;
				return;
			}
			for (const v of queue) {
				// lanes the vehicle may use
				const rl = v.link;
				const lanes: number[] = [];
				for (let lane = 1; lane <= rl.nLanes; lane++) if (!this.blocked(v, rl, lane)) lanes.push(lane);
				const wanted = (lane: number): number => (v.next ? Math.max(0, v.next.link.from!.lane - lane, lane - (v.next.link.from!.lane + v.next.nLanes - 1)) : 0);
				lanes.sort((a, b) => wanted(a) - wanted(b));
				// Only the lanes that fit the route best: a vehicle set onto another lane of a
				// short, full link blocks it while waiting for a gap it never gets.
				// (far from the connector there is room to change, any lane will do)
				const fit = lanes.length ? wanted(lanes[0]) : 0;
				const near = !!v.next && v.next.link.from!.pos <= rl.link.lnChgDist;
				while (near && lanes.length && wanted(lanes[lanes.length - 1]) > fit) lanes.pop();
				for (const lane of lanes) {
					const first = this.lanes.get(laneKey(rl.no, lane))?.[0];
					const room = first ? first.s - first.length : Infinity;
					if (room < 3) continue;
					v.lane = lane;
					v.s = 0;
					v.v = Math.min(v.vdes, first ? Math.sqrt(first.v * first.v + 2 * PLAN_DECEL * (room - 3)) : Infinity);
					v.born = this.time;
					this.vehicles.push(v);
					queue.splice(queue.indexOf(v), 1);
					st.waiting--;
					st.entered++;
					this.insertSorted(v);
					return;
				}
			}
		});
	}

	// ------------------------------------------------------------------ routes

	private blocked(v: Vehicle, rl: RLink, lane: number): boolean {
		const blockedClasses = rl.link.lanes[lane - 1]?.blockedClasses;
		if (!blockedClasses?.length) return false;
		const classes = this.rt.classesOfType.get(v.type.no);
		return !!classes?.some((c) => blockedClasses.includes(c));
	}

	/** Called when a vehicle gets onto a link: follows its route, or takes a
	 * new one at the link's routing decision, or picks any connector. */
	private enterLink(v: Vehicle, rl: RLink): void {
		v.link = rl;
		v.next = null;
		if (rl.connector) return;
		if (v.path) {
			const i = v.path.indexOf(rl.no, v.pathIdx);
			if (i < 0 || i === v.path.length - 1) v.path = null; // destination reached (or off the route)
			else {
				v.pathIdx = i;
				v.next = this.rt.links.get(v.path[i + 1]) ?? null;
				if (v.next) return;
				v.path = null;
			}
		}
		const classes = this.rt.classesOfType.get(v.type.no) ?? [];
		for (const d of this.rt.decisionsByLink.get(rl.no) ?? []) {
			if (!d.decision.allVehTypes && !d.decision.vehClasses.some((c) => classes.includes(c))) continue;
			let x = this.random() * d.routes.reduce((s, r) => s + r.relFlow, 0);
			const route = d.routes.find((r) => (x -= r.relFlow) <= 0) ?? d.routes[d.routes.length - 1];
			v.path = route.path;
			v.pathIdx = 0;
			v.next = this.rt.links.get(route.path[1]) ?? null;
			return;
		}
		// no route: any connector ahead the vehicle may use
		const out = rl.out.filter((c) => c.link.from!.pos > v.s && !this.blocked(v, c, 1));
		if (out.length) v.next = out[Math.floor(this.random() * out.length)];
	}

	/** The connector a vehicle will take from a link further along its route (unknown: null). */
	private nextAfter(v: Vehicle, rl: RLink): RLink | null {
		if (!v.path) return null;
		const i = v.path.indexOf(rl.no, v.pathIdx);
		return i >= 0 && i < v.path.length - 1 ? (this.rt.links.get(v.path[i + 1]) ?? null) : null;
	}

	/** The lanes ahead of a vehicle along its route. */
	private ahead(v: Vehicle): Seg[] {
		const segs: Seg[] = [];
		let rl = v.link;
		let lane = v.lane;
		let base = -v.s;
		let from = v.s;
		let next = v.next;
		const reach = rl.behavior.lookAheadDistMax;
		for (let i = 0; i < MAX_SEGS; i++) {
			const seg: Seg = { rl, lane, base, from, exit: rl.length };
			segs.push(seg);
			let target: RLink | undefined;
			let entry = 0;
			if (rl.connector) {
				const to = rl.link.to!;
				target = this.rt.links.get(to.link);
				entry = to.pos;
				lane = Math.min(target?.nLanes ?? 1, to.lane + lane - 1);
			} else if (next) {
				const fr = next.link.from!;
				seg.exit = fr.pos;
				// on a lane the connector does not leave by: the vehicle has to change
				// lanes first, what lies beyond is not ahead of it yet
				if (lane < fr.lane || lane > fr.lane + next.nLanes - 1) break;
				target = next;
				lane = lane - fr.lane + 1;
			}
			if (!target) break;
			base += seg.exit - entry;
			if (base > reach) break;
			from = entry;
			rl = target;
			next = rl.connector ? null : this.nextAfter(v, rl);
		}
		return segs;
	}

	// ------------------------------------------------------------------ lanes

	private indexLanes(): void {
		this.lanes = new Map();
		for (const v of this.vehicles) {
			const k = laneKey(v.link.no, v.lane);
			const l = this.lanes.get(k);
			if (l) l.push(v);
			else this.lanes.set(k, [v]);
		}
		for (const l of this.lanes.values()) l.sort((a, b) => a.s - b.s || a.id - b.id);
	}

	private insertSorted(v: Vehicle): void {
		const k = laneKey(v.link.no, v.lane);
		const l = this.lanes.get(k);
		if (!l) this.lanes.set(k, [v]);
		else {
			let i = 0;
			while (i < l.length && (l[i].s < v.s || (l[i].s === v.s && l[i].id < v.id))) i++;
			l.splice(i, 0, v);
		}
	}

	/** The vehicle in front on the lanes ahead: net gap and the vehicle. */
	private leader(v: Vehicle): { gap: number; w: Vehicle; beside?: boolean } | null {
		const onPath = this.pathLeader(v);
		const merging = this.mergeLeader(v);
		return merging && (!onPath || merging.gap < onPath.gap) ? { ...merging, beside: true } : onPath;
	}

	/** Where two connectors run into the same lane and the file gives neither priority, the
	 * vehicles take turns: the one nearer to the lane goes first, the other follows it as if
	 * it were in front already. */
	private mergeLeader(v: Vehicle): { gap: number; w: Vehicle } | null {
		let best: { gap: number; w: Vehicle } | null = null;
		for (const seg of v.segs) {
			const c = seg.rl;
			if (!c.connector) continue;
			const mine = seg.base + c.length; // to the point where the lane is reached
			if (mine > MERGE_REACH) break;
			const to = c.link.to!;
			const target = this.rt.links.get(to.link);
			if (!target) continue;
			const lane = to.lane + seg.lane - 1;
			for (const other of this.incoming(target)) {
				const o = other.link.to!;
				if (other === c || Math.abs(o.pos - to.pos) > 5 || lane < o.lane || lane > o.lane + other.nLanes - 1) continue;
				if (other.link.from!.link === c.link.from!.link) continue; // they part, they do not merge
				if (this.hasPriorityRule(c.no, other.no)) continue; // the conflict area settles it
				for (const w of this.lanes.get(laneKey(other.no, lane - o.lane + 1)) ?? []) {
					const theirs = other.length - w.s;
					if (theirs > mine || (theirs === mine && w.id > v.id)) continue;
					const gap = mine - theirs - w.length;
					if (!best || gap < best.gap) best = { gap, w };
				}
			}
		}
		return best;
	}

	private priorityPairs: Set<number> | null = null;
	private hasPriorityRule(a: number, b: number): boolean {
		if (!this.priorityPairs) {
			this.priorityPairs = new Set();
			for (const z of this.rt.zones) {
				this.priorityPairs.add(z.yieldLink * 100000 + z.prioLink);
				this.priorityPairs.add(z.prioLink * 100000 + z.yieldLink);
			}
		}
		return this.priorityPairs.has(a * 100000 + b);
	}

	private pathLeader(v: Vehicle): { gap: number; w: Vehicle } | null {
		for (let i = 0; i < v.segs.length; i++) {
			const seg = v.segs[i];
			const l = this.lanes.get(laneKey(seg.rl.no, seg.lane));
			if (!l) continue;
			for (const w of l) {
				if (w === v) continue;
				// further on, a vehicle that still covers the point where this one gets onto the
				// lane (it came in by another connector) is in the way too
				const ahead = i === 0 ? w.s > v.s || (w.s === v.s && w.id < v.id) : w.s >= seg.from - (seg.rl.connector ? 0 : w.length);
				if (ahead && w.s - w.length < seg.exit) return { gap: seg.base + w.s - w.length, w };
			}
		}
		return null;
	}

	/** Changes to the neighbouring lane towards the lanes the next connector
	 * leaves by, if there is room. Returns the distance to stop in if not. */
	private incomingByLink: Map<number, RLink[]> | null = null;
	/** The connectors that end on a link. */
	private incoming(rl: RLink): RLink[] {
		if (!this.incomingByLink) {
			this.incomingByLink = new Map();
			for (const c of this.rt.links.values()) {
				if (!c.connector) continue;
				const list = this.incomingByLink.get(c.link.to!.link);
				if (list) list.push(c);
				else this.incomingByLink.set(c.link.to!.link, [c]);
			}
		}
		return this.incomingByLink.get(rl.no) ?? [];
	}

	private laneChange(v: Vehicle): number {
		const next = v.next;
		if (!next || v.link.connector) return Infinity;
		const lo = next.link.from!.lane;
		const hi = lo + next.nLanes - 1;
		if (v.lane >= lo && v.lane <= hi) return Infinity;
		const toGo = next.link.from!.pos - v.s;
		if (toGo > v.link.link.lnChgDist) return Infinity;
		const dir = v.lane < lo ? 1 : -1;
		const target = v.lane + dir;
		const l = this.lanes.get(laneKey(v.link.no, target)) ?? [];
		let front: Vehicle | undefined;
		let back: Vehicle | undefined;
		for (const w of l) {
			if (w.s > v.s) {
				front = w;
				break;
			}
			back = w;
		}
		let gapFront = front ? front.s - front.length - v.s : Infinity;
		if (!front) {
			// a vehicle already on the connector may still have its tail on the lane
			const lane = v.lane;
			v.lane = target;
			const lead = this.leader({ ...v, segs: this.ahead(v) });
			v.lane = lane;
			if (lead) {
				front = lead.w;
				gapFront = lead.gap;
			}
		}
		let gapBack = back ? v.s - v.length - back.s : Infinity;
		if (!back) {
			// nobody behind on this link: someone may be about to enter the lane from a connector
			for (const c of this.incoming(v.link)) {
				const to = c.link.to!;
				if (to.pos > v.s || target < to.lane || target > to.lane + c.nLanes - 1) continue;
				const l2 = this.lanes.get(laneKey(c.no, target - to.lane + 1));
				let u = l2?.[l2.length - 1];
				let behind = u ? c.length - u.s : 0;
				if (!u) {
					// connector empty: the next one to take it from the link before
					const fr = c.link.from!;
					const l1 = this.lanes.get(laneKey(fr.link, fr.lane + target - to.lane)) ?? [];
					for (let k = l1.length - 1; k >= 0; k--) {
						if (l1[k].s > fr.pos || l1[k].next !== c) continue;
						u = l1[k];
						behind = c.length + fr.pos - u.s;
						break;
					}
				}
				if (!u) continue;
				const gap = v.s - v.length - to.pos + behind;
				if (gap < gapBack) {
					gapBack = gap;
					back = u;
				}
			}
		}
		const needFront = 1 + (front ? Math.max(0, (v.v * v.v - front.v * front.v) / (2 * 3)) : 0);
		const needBack = 1 + (back ? Math.max(0, (back.v * back.v - v.v * v.v) / (2 * 3)) + back.v * 0.3 : 0);
		// (not before the vehicle is on the link with its whole length)
		if (gapFront > needFront && gapBack > needBack && v.lcTime <= 0 && (v.s >= v.length || v.input >= 0 && v.travelled < v.length) && !this.blocked(v, v.link, target)) {
			const old = this.lanes.get(laneKey(v.link.no, v.lane));
			old?.splice(old.indexOf(v), 1);
			v.lcOffset = v.link.offsets[v.lane - 1] - v.link.offsets[target - 1];
			v.lcTime = LANE_CHANGE_TIME;
			v.lane = target;
			this.insertSorted(v);
			if (target >= lo && target <= hi) {
				v.lcWait = 0;
				return Infinity;
			}
		}
		// still on the wrong lane: wait before the connector until a gap opens
		const missing = v.lane < lo ? lo - v.lane : v.lane - hi;
		const wait = Math.max(0, toGo - v.link.link.emergStopDist * missing);
		if (v.v < 0.3 && wait < 2) v.lcWait += this.dt;
		return wait;
	}

	// ------------------------------------------------------------------ driving

	private accelerate(v: Vehicle, byLink: Map<number, { w: Vehicle; base: number }[]>): number {
		const { net } = this.rt;
		const type = v.type;
		const aMax = Math.max(0.2, funcAt(net.maxAccel.get(type.maxAccelFunc), v.v, v.q, 3));
		const aDes = Math.min(aMax, Math.max(0.2, funcAt(net.desAccel.get(type.desAccelFunc), v.v, v.q, 2)));
		const bMax = Math.min(-1, funcAt(net.maxDecel.get(type.maxDecelFunc), v.v, v.q, -7));
		const bDes = Math.min(-0.5, funcAt(net.desDecel.get(type.desDecelFunc), v.v, v.q, -2.75));

		let vdes = v.vdes;
		let bound = Infinity; // upper bound of the acceleration from everything ahead
		/** Be no faster than `vAt` once `d` metres on (0 = stop there), braking with `decel`. */
		const limit = (d: number, vAt: number, decel: number): void => {
			if (d <= 0.02 && vAt <= 0) {
				bound = Math.min(bound, -v.v / this.dt); // at the stop point: stand
				return;
			}
			const dist = Math.max(d, 0.02);
			const allowed = Math.sqrt(vAt * vAt + 2 * decel * dist);
			// Far away: only keep from accelerating past what can still be braked
			// off. Close (near the braking curve): exactly the deceleration that
			// reaches `vAt` at the point – following it keeps the curve.
			bound = Math.min(bound, v.v > 0.9 * allowed ? (vAt * vAt - v.v * v.v) / (2 * dist) : (allowed - v.v) / TAU);
		};

		// reduced speed areas
		const classes = this.rt.classesOfType.get(type.no) ?? [];
		for (const seg of v.segs) {
			for (const area of this.rt.areasByLane.get(laneKey(seg.rl.no, seg.lane)) ?? []) {
				const start = seg.base + area.pos;
				if (start + area.length + v.length < 0 || area.pos + area.length < seg.from - v.length) continue;
				const cls = classes.find((c) => area.byClass.has(c));
				if (cls === undefined) continue;
				const red = area.byClass.get(cls)!;
				const speed = quantile(net.desSpeedDistributions.get(red.desSpeedDistr), v.q, 30) / 3.6;
				if (speed >= v.vdes) continue;
				if (start <= 0) vdes = Math.min(vdes, speed);
				else limit(start, speed, red.decel);
			}
		}

		// signal heads
		v.signalStop = Infinity;
		signal: for (const seg of v.segs) {
			for (const head of this.rt.headsByLane.get(laneKey(seg.rl.no, seg.lane)) ?? []) {
				const d = seg.base + head.pos;
				if (d < -0.2 || head.pos < seg.from - 0.2 || head.pos > seg.exit) {
					if (v.goHead === head.no && d < -0.2) v.goHead = 0;
					continue;
				}
				const state = this.signals.get(Simulation.signalKey(head.sc, head.sg)) ?? 'off';
				if (state === 'green' || state === 'off' || state === 'amberflash') continue;
				if (v.goHead === head.no) continue;
				if (state === 'amber' && (v.v * v.v) / (2 * 3) > d) {
					v.goHead = head.no; // too close to stop comfortably: drive on
					continue;
				}
				if (state === 'red' && (v.v * v.v) / (2 * -bMax) > d + 1) continue; // cannot stop any more
				v.signalStop = d;
				limit(d - 0.5, 0, PLAN_DECEL);
				break signal;
			}
		}

		// conflict areas: wait for the vehicles with right of way
		for (const seg of v.segs) {
			for (const z of this.rt.zonesByYieldLink.get(seg.rl.no) ?? []) {
				if (z.y1 < seg.from) continue;
				const toZone = seg.base + z.y0 - z.addStopDist;
				if (toZone <= 0.3 || toZone > 60 || toZone > v.signalStop) continue;
				if ((v.v * v.v) / (2 * -bMax) > toZone + 1) continue; // cannot stop before it any more
				if (this.mustYield(v, seg, z, byLink)) limit(toZone - 0.5, 0, PLAN_DECEL);
			}
		}

		// lane change for the route
		const wait = this.laneChange(v);
		if (wait < Infinity) limit(wait, 0, PLAN_DECEL);

		// free road
		const aFree = v.v < vdes ? Math.min(aDes, (vdes - v.v) / TAU + 0.05) : Math.max(bDes, (vdes - v.v) / TAU);
		let a = aFree;

		// vehicle in front
		// (no interaction on footpaths: pedestrians walk past each other)
		const lead = v.link.behavior.model === 'NOINTERACTION' ? null : this.leader(v);
		if (lead && lead.gap < v.link.behavior.lookAheadDistMax) {
			const b = v.link.behavior;
			const { gap, w } = lead;
			// (a vehicle on the other connector of a merge is not on this one's lane yet)
			if (gap < -0.05 && w.v + v.v > 0.5 && !lead.beside) {
				this.collisions++;
				this.onCollision?.(v, w, gap);
			}
			if (b.model === 'WIEDEMANN99') a = wiedemann99(v.v, Math.max(gap, 0.01), w.v, w.a, aFree, b, aMax);
			else if (b.model === 'WIEDEMANN74') a = wiedemann74(v.v, Math.max(gap, 0.01), w.v, w.a, aFree, b, v.z1, v.z2);
			// never faster than what still stops behind the leader
			const stand = (b.model === 'WIEDEMANN99' ? b.cc[0] : b.w74ax) * 0.9;
			if (b.model !== 'NOINTERACTION') limit(gap - stand, w.v, Math.min(-bDes, 3));
		}

		a = Math.min(a, bound);
		return Math.max(bMax, Math.min(aMax, a));
	}

	/** Does `v` have to wait before conflict zone `z` for a vehicle on the priority link? */
	private mustYield(v: Vehicle, seg: Seg, z: ConflictZone, byLink: Map<number, { w: Vehicle; base: number }[]>): boolean {
		const enter = seg.base + z.y0;
		const clear = seg.base + z.y1 + v.length;
		const tEnter = travelTime(v.v, enter, 1.5, Math.max(v.vdes, 3));
		const tClear = travelTime(v.v, clear, 1.5, Math.max(v.vdes, 3));
		for (const { w, base } of byLink.get(z.prioLink) ?? []) {
			if (w === v) continue;
			const wEnter = base + z.p0;
			const wClear = base + z.p1 + w.length;
			if (wClear <= 0) continue; // already through
			if (w.signalStop < wEnter - 0.1) continue; // held by a signal before the zone
			const speed = Math.max(w.v, 1.5);
			const tw0 = wEnter <= 0 ? 0 : wEnter / speed;
			const tw1 = wClear / speed;
			if (tEnter < tw1 + z.rearGap + 0.5 && tw0 < tClear + z.frontGap + 0.5) return true;
		}
		return false;
	}

	private move(): void {
		const dt = this.dt;
		const gone = new Set<Vehicle>();
		for (const v of this.vehicles) {
			const v1 = Math.max(0, v.v + v.a * dt);
			const ds = ((v.v + v1) / 2) * dt;
			v.v = v1;
			v.s += ds;
			v.travelled += ds;
			if (v.lcTime > 0) v.lcTime = Math.max(0, v.lcTime - dt);
			// stuck before its connector for too long: taken out, so the others get on
			if (v.lcWait > (v.link.behavior.diffusTm ?? 60)) {
				this.diffused++;
				gone.add(v);
				continue;
			}
			for (let guard = 0; guard < 4; guard++) {
				const rl = v.link;
				if (rl.connector) {
					if (v.s < rl.length) break;
					const to = rl.link.to!;
					const target = this.rt.links.get(to.link);
					if (!target) {
						gone.add(v);
						break;
					}
					v.lane = Math.min(target.nLanes, to.lane + v.lane - 1);
					v.s = to.pos + (v.s - rl.length);
					this.enterLink(v, target);
				} else if (v.next && v.s >= v.next.link.from!.pos) {
					const fr = v.next.link.from!;
					if (v.lane < fr.lane || v.lane > fr.lane + v.next.nLanes - 1) {
						// could not get onto the connector's lane: drive on to the link end
						v.next = null;
						v.path = null;
						continue;
					}
					const c = v.next;
					v.lane = v.lane - fr.lane + 1;
					v.s -= fr.pos;
					v.link = c;
					v.next = null;
				} else if (v.s >= rl.length) {
					gone.add(v);
					break;
				} else break;
			}
		}
		if (gone.size) {
			for (const v of gone) {
				const st = this.inputStats.find((s) => s.input.no === v.input);
				if (!st || v.lcWait > (v.link.behavior.diffusTm ?? 60)) continue;
				const t = this.time + dt - v.born;
				st.left++;
				st.travelTime += t;
				st.delay += Math.max(0, t - v.travelled / Math.max(v.vdes, 0.1));
			}
			this.vehicles = this.vehicles.filter((v) => !gone.has(v));
		}
	}

	// ------------------------------------------------------------------ detectors

	private detect(): void {
		this.indexLanes();
		for (const d of this.rt.detectors) {
			const st = this.detectorStates.get(d.no)!;
			const occupied = !!this.lanes.get(laneKey(d.link, d.lane))?.some((v) => v.s >= d.pos && v.s - v.length <= d.pos + d.length);
			const now = this.time + this.dt;
			if (occupied && !st.occupied) {
				st.count++;
				st.edges++;
				st.impulse = true;
				st.lastGap = now - st.changedAt;
				st.changedAt = now;
			} else if (!occupied && st.occupied) st.changedAt = now;
			if (occupied) st.occupiedTime += this.dt;
			st.occupied = occupied;
		}
	}
}

function smooth(t: number): number {
	const x = Math.min(1, Math.max(0, t));
	return x * x * (3 - 2 * x);
}
