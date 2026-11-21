// 2D top view of the network and the running simulation on a canvas.
import { lanePose, type RLink, type Runtime } from './net';
import { Simulation, type Vehicle } from './sim';
import type { SignalState } from './sig';
import type { P, VehicleCategory } from './inpx';

export interface View {
	/** world point (m) at the centre of the canvas */
	cx: number;
	cy: number;
	/** pixels per meter */
	scale: number;
}

const COLORS = {
	background: '#1b1f24',
	link: '#4a4f57',
	connector: '#555b64',
	laneLine: 'rgba(255,255,255,0.45)',
	edge: 'rgba(255,255,255,0.18)',
	detector: '#38bdf8',
	detectorOn: 'rgba(56,189,248,0.55)'
};
const SIGNAL: Record<SignalState, string> = { red: '#ef4444', redamber: '#f97316', green: '#22c55e', amber: '#facc15', amberflash: '#facc15', off: '#6b7280' };
const CARS = ['#e5e7eb', '#93c5fd', '#fca5a5', '#fde68a', '#a7f3d0', '#c4b5fd', '#f9a8d4', '#d1d5db'];
const CATEGORY: Partial<Record<VehicleCategory, string>> = { HGV: '#f59e0b', BUS: '#10b981', TRAM: '#eab308', BIKE: '#f472b6', PEDESTRIAN: '#f472b6' };

interface Shape {
	rl: RLink;
	outline: P[];
	/** lines between neighbouring lanes */
	dividers: P[][];
}

const shapes = new WeakMap<Runtime, Shape[]>();

/** Points along a link shifted `off` metres to the left of its centre line. */
function offsetLine(rl: RLink, off: number): P[] {
	const out: P[] = [];
	const n = Math.max(1, Math.ceil(rl.length / 2));
	for (let i = 0; i <= n; i++) {
		const p = rl.poly.at((rl.length * i) / n);
		out.push({ x: p.x - p.dy * off, y: p.y + p.dx * off });
	}
	return out;
}

function shapesOf(rt: Runtime): Shape[] {
	let s = shapes.get(rt);
	if (!s) {
		s = [...rt.links.values()]
			.sort((a, b) => Number(a.connector) - Number(b.connector))
			.map((rl) => {
				const dividers: P[][] = [];
				for (let k = 1; k < rl.nLanes; k++) dividers.push(offsetLine(rl, (rl.offsets[k - 1] + rl.offsets[k]) / 2));
				return { rl, outline: [...offsetLine(rl, rl.width / 2), ...offsetLine(rl, -rl.width / 2).reverse()], dividers };
			});
		shapes.set(rt, s);
	}
	return s;
}

/** A view that shows the whole network in a canvas of the given size (CSS pixels). */
export function fitView(rt: Runtime, width: number, height: number): View {
	const b = rt.bounds;
	const w = Math.max(1, b.maxX - b.minX);
	const h = Math.max(1, b.maxY - b.minY);
	return { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale: Math.max(0.05, Math.min(width / w, height / h) * 0.94) };
}

export function draw(ctx: CanvasRenderingContext2D, width: number, height: number, view: View, rt: Runtime | null, sim: Simulation | null): void {
	ctx.fillStyle = COLORS.background;
	ctx.fillRect(0, 0, width, height);
	if (!rt) return;
	// world (m, y north) → canvas (px, y down)
	const X = (x: number): number => (x - view.cx) * view.scale + width / 2;
	const Y = (y: number): number => height / 2 - (y - view.cy) * view.scale;
	const path = (pts: P[], close = false): void => {
		ctx.beginPath();
		pts.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
		if (close) ctx.closePath();
	};
	const px = (m: number): number => m * view.scale;

	for (const s of shapesOf(rt)) {
		path(s.outline, true);
		ctx.fillStyle = s.rl.connector ? COLORS.connector : COLORS.link;
		ctx.fill();
		if (!s.rl.connector) {
			ctx.strokeStyle = COLORS.edge;
			ctx.lineWidth = 1;
			ctx.stroke();
		}
	}
	ctx.setLineDash([px(3), px(4.5)]);
	ctx.strokeStyle = COLORS.laneLine;
	ctx.lineWidth = Math.max(0.6, px(0.12));
	for (const s of shapesOf(rt)) {
		if (s.rl.connector) continue;
		for (const d of s.dividers) {
			path(d);
			ctx.stroke();
		}
	}
	ctx.setLineDash([]);

	/** Quad across a lane from s0 to s1, `half` metres to each side of its centre. */
	const laneQuad = (rl: RLink, lane: number, s0: number, s1: number, half: number): P[] => {
		const a = lanePose(rl, lane, s0);
		const b = lanePose(rl, lane, s1);
		return [
			{ x: a.x - a.dy * half, y: a.y + a.dx * half },
			{ x: b.x - b.dy * half, y: b.y + b.dx * half },
			{ x: b.x + b.dy * half, y: b.y - b.dx * half },
			{ x: a.x + a.dy * half, y: a.y - a.dx * half }
		];
	};
	const laneWidth = (rl: RLink, lane: number): number => rl.link.lanes[lane - 1]?.width ?? 3.5;

	// detectors
	ctx.lineWidth = 1;
	for (const d of rt.detectors) {
		const rl = rt.links.get(d.link)!;
		path(laneQuad(rl, d.lane, d.pos, d.pos + Math.max(d.length, 0.5), laneWidth(rl, d.lane) * 0.36), true);
		if (sim?.detectorStates.get(d.no)?.occupied) {
			ctx.fillStyle = COLORS.detectorOn;
			ctx.fill();
		}
		ctx.strokeStyle = COLORS.detector;
		ctx.stroke();
	}

	// signal heads: a bar across the lane in the colour of its signal group
	for (const heads of rt.headsByLane.values()) {
		for (const h of heads) {
			const rl = rt.links.get(h.link)!;
			const state = sim?.signals.get(Simulation.signalKey(h.sc, h.sg)) ?? 'off';
			path(laneQuad(rl, h.lane, h.pos - 0.35, h.pos + 0.35, laneWidth(rl, h.lane) * 0.46), true);
			ctx.fillStyle = SIGNAL[state];
			ctx.fill();
		}
	}

	if (!sim) return;
	for (const v of sim.vehicles) {
		const { front, rear } = sim.pose(v);
		const half = v.width / 2;
		const dx = front.x - rear.x;
		const dy = front.y - rear.y;
		const len = Math.hypot(dx, dy) || 1;
		const nx = (-dy / len) * half;
		const ny = (dx / len) * half;
		path([{ x: rear.x + nx, y: rear.y + ny }, { x: front.x + nx, y: front.y + ny }, { x: front.x - nx, y: front.y - ny }, { x: rear.x - nx, y: rear.y - ny }], true);
		ctx.fillStyle = vehicleColor(v);
		ctx.fill();
		if (view.scale > 5) {
			ctx.strokeStyle = 'rgba(0,0,0,0.55)';
			ctx.lineWidth = 1;
			ctx.stroke();
		}
	}
}

export function vehicleColor(v: Vehicle): string {
	return CATEGORY[v.category] ?? CARS[v.id % CARS.length];
}

export const SIGNAL_COLORS = SIGNAL;
