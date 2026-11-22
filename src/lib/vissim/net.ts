// Runtime network: the parsed file turned into what the simulation and the
// view work on – link centre lines with arc length, lane offsets, connectors
// attached to their links, objects indexed by lane, conflict zones, routes as
// full link sequences.
import { DEFAULT_LANE_WIDTH, type ConflictArea, type Detector, type DrivingBehavior, type Link, type Network, type P, type ReducedSpeedArea, type RoutingDecision, type SignalHead } from './inpx';

export interface Pose {
	x: number;
	y: number;
	/** unit direction of travel */
	dx: number;
	dy: number;
}

/** A polyline with arc length. Positions outside [0, length] continue straight. */
export class Polyline {
	readonly cum: number[] = [0];
	readonly length: number;
	constructor(readonly pts: P[]) {
		for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
		this.length = this.cum[this.cum.length - 1];
	}

	at(s: number): Pose {
		const { pts, cum } = this;
		let i = 1;
		if (s > 0) {
			// binary search for the segment that holds s
			let lo = 1;
			let hi = pts.length - 1;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (cum[mid] < s) lo = mid + 1;
				else hi = mid;
			}
			i = lo;
		}
		// skip zero-length segments
		while (i < pts.length - 1 && cum[i] - cum[i - 1] < 1e-9) i++;
		const a = pts[i - 1];
		const b = pts[i];
		const len = cum[i] - cum[i - 1] || 1;
		const dx = (b.x - a.x) / len;
		const dy = (b.y - a.y) / len;
		const t = s - cum[i - 1];
		return { x: a.x + dx * t, y: a.y + dy * t, dx, dy };
	}

	/** Distance from a point to the polyline. */
	distanceTo(p: P): number {
		let best = Infinity;
		for (let i = 1; i < this.pts.length; i++) {
			const a = this.pts[i - 1];
			const b = this.pts[i];
			const vx = b.x - a.x;
			const vy = b.y - a.y;
			const l2 = vx * vx + vy * vy;
			const t = l2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2)) : 0;
			best = Math.min(best, Math.hypot(p.x - a.x - vx * t, p.y - a.y - vy * t));
		}
		return best;
	}
}

export interface RLink {
	no: number;
	link: Link;
	poly: Polyline;
	length: number;
	nLanes: number;
	width: number;
	/** lateral offset of each lane's centre from the link centre line, to the left (index 0 = lane 1 = rightmost) */
	offsets: number[];
	connector: boolean;
	/** connectors leaving this link, by position */
	out: RLink[];
	behavior: DrivingBehavior;
}

/** Where a yielding link has to wait for a priority link. */
export interface ConflictZone {
	no: number;
	yieldLink: number;
	prioLink: number;
	/** zone along the yielding link */
	y0: number;
	y1: number;
	/** zone along the priority link */
	p0: number;
	p1: number;
	frontGap: number;
	rearGap: number;
	addStopDist: number;
}

export interface RRoute {
	relFlow: number;
	/** every link from the decision link to the destination link, connectors included */
	path: number[];
}

export interface RDecision {
	decision: RoutingDecision;
	routes: RRoute[];
}

export interface Runtime {
	net: Network;
	links: Map<number, RLink>;
	headsByLane: Map<number, SignalHead[]>;
	detectors: Detector[];
	areasByLane: Map<number, ReducedSpeedArea[]>;
	zonesByYieldLink: Map<number, ConflictZone[]>;
	zones: ConflictZone[];
	decisionsByLink: Map<number, RDecision[]>;
	/** footpaths across the road: links without interaction between their users, without vehicle
	 * input and without a way on – pedestrians walk along them from start to end */
	pedestrianLinks: RLink[];
	/** vehicle type → the classes it belongs to */
	classesOfType: Map<number, number[]>;
	bounds: { minX: number; minY: number; maxX: number; maxY: number };
	warnings: string[];
}

/** Key of a lane (lane counted from 1) for the per-lane indexes. */
export const laneKey = (link: number, lane: number): number => link * 16 + lane;

/** Point on a lane at arc length s of its link; `extra` shifts it further to the left. */
export function lanePose(rl: RLink, lane: number, s: number, extra = 0): Pose {
	const p = rl.poly.at(s);
	const off = (rl.offsets[Math.min(rl.nLanes, Math.max(1, lane)) - 1] ?? 0) + extra;
	return { x: p.x - p.dy * off, y: p.y + p.dx * off, dx: p.dx, dy: p.dy };
}

const FALLBACK_BEHAVIOR: DrivingBehavior = { no: 0, name: 'default', model: 'WIEDEMANN74', lookAheadDistMax: 250, standDist: 0.5, w74ax: 2, w74bxAdd: 2, w74bxMult: 3, cc: [1.5, 0.9, 4, -8, -0.35, 0.35, 11.44, 0.25, 3.5, 1.5] };

function group<T>(items: T[], key: (t: T) => number): Map<number, T[]> {
	const m = new Map<number, T[]>();
	for (const it of items) {
		const k = key(it);
		const l = m.get(k);
		if (l) l.push(it);
		else m.set(k, [it]);
	}
	return m;
}

/** Stretch of `a` (arc length from..to) that runs within `reach` of `b`'s centre line, or null. */
function overlap(a: RLink, b: RLink, reach: number): [number, number] | null {
	let from = Infinity;
	let to = -Infinity;
	const step = 0.5;
	for (let s = 0; s <= a.length + 1e-9; s += step) {
		if (b.poly.distanceTo(a.poly.at(Math.min(s, a.length))) <= reach) {
			from = Math.min(from, s);
			to = Math.max(to, s);
		}
	}
	return to >= from ? [Math.max(0, from - step), Math.min(a.length, to + step)] : null;
}

export function buildRuntime(net: Network): Runtime {
	const warnings: string[] = [];
	const links = new Map<number, RLink>();
	for (const link of net.links.values()) {
		const widths = link.lanes.map((l) => l.width || DEFAULT_LANE_WIDTH);
		const width = widths.reduce((a, b) => a + b, 0);
		let acc = 0;
		const offsets = widths.map((w) => {
			const off = acc + w / 2 - width / 2;
			acc += w;
			return off;
		});
		const poly = new Polyline(link.points);
		const behaviorNo = net.linkBehaviorTypes.get(link.behaviorType);
		links.set(link.no, {
			no: link.no, link, poly, length: poly.length, nLanes: link.lanes.length, width, offsets,
			connector: !!link.from && !!link.to, out: [],
			behavior: (behaviorNo !== undefined ? net.drivingBehaviors.get(behaviorNo) : undefined) ?? FALLBACK_BEHAVIOR
		});
	}
	for (const c of links.values()) {
		if (!c.connector) continue;
		const from = links.get(c.link.from!.link);
		const to = links.get(c.link.to!.link);
		if (!from || !to) {
			warnings.push(`Verbinder ${c.no}: Strecke ${!from ? c.link.from!.link : c.link.to!.link} fehlt – ignoriert`);
			links.delete(c.no);
			continue;
		}
		from.out.push(c);
	}
	for (const l of links.values()) l.out.sort((a, b) => a.link.from!.pos - b.link.from!.pos);

	// ---- conflict zones (only where one side has to yield)
	const zones: ConflictZone[] = [];
	const zone = (c: ConflictArea, yieldNo: number, prioNo: number): void => {
		const y = links.get(yieldNo);
		const p = links.get(prioNo);
		if (!y || !p) return;
		// branching (both leave the same link): the vehicles follow each other until they part
		if (y.connector && p.connector && y.link.from!.link === p.link.from!.link) return;
		const onY = overlap(y, p, p.width / 2 + 1);
		const onP = overlap(p, y, y.width / 2 + 1);
		if (!onY || !onP) return;
		zones.push({ no: c.no, yieldLink: yieldNo, prioLink: prioNo, y0: onY[0], y1: onY[1], p0: onP[0], p1: onP[1], frontGap: c.frontGap, rearGap: c.rearGap, addStopDist: c.addStopDist });
	};
	for (const c of net.conflictAreas) {
		if (c.status === 'ONEYIELDSTWO') zone(c, c.link1, c.link2);
		else if (c.status === 'TWOYIELDSONE') zone(c, c.link2, c.link1);
	}

	// ---- static routes as full link sequences
	const follows = (a: RLink, b: RLink): boolean => (b.connector ? b.link.from!.link === a.no : a.connector && a.link.to!.link === b.no);
	const search = (from: number, to: number): number[] | null => {
		// breadth-first over links and connectors
		const prev = new Map<number, number>([[from, 0]]);
		const queue = [from];
		while (queue.length) {
			const no = queue.shift()!;
			if (no === to) {
				const path = [to];
				while (path[0] !== from) path.unshift(prev.get(path[0])!);
				return path;
			}
			const l = links.get(no)!;
			for (const n of l.connector ? [l.link.to!.link] : l.out.map((c) => c.no)) {
				if (!prev.has(n) && links.has(n)) {
					prev.set(n, no);
					queue.push(n);
				}
			}
		}
		return null;
	};
	const decisions: RDecision[] = [];
	for (const d of net.routingDecisions) {
		if (!links.has(d.link)) continue;
		const routes: RRoute[] = [];
		for (const r of d.routes) {
			let path: number[] | null = [d.link, ...r.linkSeq.filter((n) => n !== d.link && n !== r.destLink), r.destLink];
			const ok = path.every((n, i) => links.has(n) && (i === 0 || follows(links.get(path![i - 1])!, links.get(n)!)));
			if (!ok) path = links.has(r.destLink) ? search(d.link, r.destLink) : null;
			if (path && r.relFlow > 0) routes.push({ relFlow: r.relFlow, path });
			else if (!path) warnings.push(`Route ${r.no} der Routenentscheidung ${d.no}: kein Weg von Strecke ${d.link} nach ${r.destLink} – ignoriert`);
		}
		if (routes.length) decisions.push({ decision: d, routes });
	}

	const classesOfType = new Map<number, number[]>();
	for (const [cls, types] of net.vehicleClasses) for (const t of types) classesOfType.set(t, [...(classesOfType.get(t) ?? []), cls]);

	const onNet = <T extends { link: number }>(items: T[], what: string): T[] =>
		items.filter((it) => {
			if (links.has(it.link)) return true;
			warnings.push(`${what}: Strecke ${it.link} fehlt – ignoriert`);
			return false;
		});

	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const l of links.values()) {
		for (const p of l.link.points) {
			minX = Math.min(minX, p.x - l.width);
			minY = Math.min(minY, p.y - l.width);
			maxX = Math.max(maxX, p.x + l.width);
			maxY = Math.max(maxY, p.y + l.width);
		}
	}
	if (!links.size) minX = minY = maxX = maxY = 0;

	return {
		net, links,
		headsByLane: group(onNet(net.signalHeads, 'Signalgeber'), (h) => laneKey(h.link, h.lane)),
		detectors: onNet(net.detectors, 'Detektor'),
		areasByLane: group(onNet(net.reducedSpeedAreas, 'Langsamfahrbereich'), (a) => laneKey(a.link, a.lane)),
		zonesByYieldLink: group(zones, (z) => z.yieldLink),
		zones,
		decisionsByLink: group(decisions, (d) => d.decision.link),
		pedestrianLinks: [...links.values()].filter((l) => !l.connector && l.behavior.model === 'NOINTERACTION' && !l.out.length && !net.inputs.some((i) => i.link === l.no)),
		classesOfType,
		bounds: { minX, minY, maxX, maxY },
		warnings
	};
}
