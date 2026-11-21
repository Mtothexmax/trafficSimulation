// The 3D models of the simulation, generated in code: cars, lorry, bus, tram,
// cyclist, motorcyclist and pedestrian are put together from boxes, extruded
// outlines, tubes and low-poly spheres when the 3D view starts. There are no
// model files – the shapes are entirely this project's own work.
//
// Model space: front towards +X, left +Y, up +Z, meters. The finished
// geometry is in three.js axes (y up) with the origin on the ground under the
// centre. Materials whose names start with `tint_` are white: the renderer
// colours them per vehicle.
import * as THREE from 'three';

type V = [number, number, number];

export interface ModelPart {
	geometry: THREE.BufferGeometry;
	material: THREE.Material;
}
export interface Model {
	parts: ModelPart[];
	/** body length (m): the renderer stretches the model to the vehicle's length */
	length: number;
}

/** name: [colour, roughness, metalness] */
const PALETTE: Record<string, [string, number, number]> = {
	tint_body: ['#ffffff', 0.4, 0.1],
	tint_shirt: ['#ffffff', 0.85, 0],
	glass: ['#0d1217', 0.12, 0.3],
	tyre: ['#08080a', 0.9, 0],
	rim: ['#9ea3ab', 0.35, 0.8],
	dark: ['#17171a', 0.6, 0.2],
	metal: ['#80858c', 0.4, 0.7],
	light: ['#faf5d9', 0.3, 0],
	tail: ['#bf0d0d', 0.35, 0],
	cargo: ['#dbdee0', 0.6, 0],
	roof: ['#b8bdc2', 0.5, 0.1],
	skin: ['#c79173', 0.75, 0],
	hair: ['#24170f', 0.9, 0],
	trousers: ['#1f2947', 0.85, 0],
	shoes: ['#121214', 0.6, 0],
	suit: ['#141417', 0.55, 0],
	helmet: ['#ebebe6', 0.3, 0],
	frame: ['#29334d', 0.4, 0.4]
};

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V): V => {
	const l = len(a) || 1;
	return [a[0] / l, a[1] / l, a[2] / l];
};

/** A model under construction: triangles collected per material. */
class Builder {
	private readonly triangles = new Map<string, number[]>();

	/** A flat polygon (convex, or given already triangulated), turned so that it faces along `outward`. */
	private face(points: V[], material: string, outward: V, triangles?: number[][]): void {
		let list = this.triangles.get(material);
		if (!list) this.triangles.set(material, (list = []));
		const tris = triangles ?? Array.from({ length: points.length - 2 }, (_, i) => [0, i + 1, i + 2]);
		for (const [a, b, c] of tris) {
			const flip = dot(cross(sub(points[b], points[a]), sub(points[c], points[a])), outward) < 0;
			for (const i of flip ? [a, c, b] : [a, b, c]) list.push(points[i][0], points[i][1], points[i][2]);
		}
	}

	/** Axis-aligned box; `top` can give the upper face another material. */
	box(lo: V, hi: V, material: string, top?: string): void {
		const [x0, y0, z0] = lo;
		const [x1, y1, z1] = hi;
		const c: V[] = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
		const sides: [number[], V, string][] = [
			[[0, 3, 2, 1], [0, 0, -1], material],
			[[4, 5, 6, 7], [0, 0, 1], top ?? material],
			[[0, 1, 5, 4], [0, -1, 0], material],
			[[1, 2, 6, 5], [1, 0, 0], material],
			[[2, 3, 7, 6], [0, 1, 0], material],
			[[3, 0, 4, 7], [-1, 0, 0], material]
		];
		for (const [idx, outward, m] of sides) this.face(idx.map((i) => c[i]), m, outward);
	}

	/**
	 * An outline in the X/Z plane, extruded to ±half along Y. `materials[i]` is
	 * for the side between point i and i+1, `cap` for the two flat sides.
	 * `halfAt(x, z)` can narrow the body per point.
	 */
	prism(outline: [number, number][], half: number, materials: string | string[], cap: string, halfAt?: (x: number, z: number) => number): void {
		const n = outline.length;
		const width = outline.map(([x, z]) => (halfAt ? halfAt(x, z) : half));
		const right = outline.map(([x, z], i): V => [x, -width[i], z]);
		const left = outline.map(([x, z], i): V => [x, width[i], z]);
		// the outline may be concave: triangulate it properly
		const contour = outline.map(([x, z]) => new THREE.Vector2(x, z));
		const tris = THREE.ShapeUtils.triangulateShape(contour, []);
		this.face(right, cap, [0, -1, 0], tris);
		this.face(left, cap, [0, 1, 0], tris);
		let area = 0;
		for (let i = 0; i < n; i++) {
			const [x0, z0] = outline[i];
			const [x1, z1] = outline[(i + 1) % n];
			area += x0 * z1 - x1 * z0;
		}
		const turn = area > 0 ? 1 : -1;
		for (let i = 0; i < n; i++) {
			const j = (i + 1) % n;
			const ex = outline[j][0] - outline[i][0];
			const ez = outline[j][1] - outline[i][1];
			this.face([right[i], right[j], left[j], left[i]], Array.isArray(materials) ? materials[i] : materials, [ez * turn, 0, -ex * turn]);
		}
	}

	/** A (tapered) tube from a to b. `flat` stretches the cross-section along `side`. */
	tube(a: V, b: V, ra: number, rb = ra, material = 'dark', segs = 6, flat = 1, side?: V): void {
		const d = sub(b, a);
		if (len(d) < 1e-6) return;
		const dir = unit(d);
		let u = side ?? cross(dir, [0, 0, 1]);
		if (len(u) < 1e-6) u = [0, 1, 0];
		u = unit(u);
		const w = unit(cross(dir, u));
		const ringA: V[] = [];
		const ringB: V[] = [];
		const offs: V[] = [];
		for (let i = 0; i < segs; i++) {
			const t = (2 * Math.PI * i) / segs;
			const off = add(mul(u, Math.cos(t) * flat), mul(w, Math.sin(t)));
			offs.push(off);
			ringA.push(add(a, mul(off, ra)));
			ringB.push(add(b, mul(off, rb)));
		}
		for (let i = 0; i < segs; i++) {
			const j = (i + 1) % segs;
			this.face([ringA[i], ringA[j], ringB[j], ringB[i]], material, add(offs[i], offs[j]));
		}
		this.face(ringA, material, mul(dir, -1));
		this.face(ringB, material, dir);
	}

	/** A wheel standing in the X/Z plane, centred at (x, y, radius). */
	wheel(x: number, y: number, radius: number, width: number, segs = 12, rim = 0.62): void {
		const at = (angle: number, r: number, yy: number): V => [x + r * Math.cos(angle), yy, radius + r * Math.sin(angle)];
		for (const sign of [-1, 1]) {
			const yy = y + (sign * width) / 2;
			const out: V = [0, sign, 0];
			const inner: V[] = [];
			for (let i = 0; i < segs; i++) {
				const a0 = (2 * Math.PI * i) / segs;
				const a1 = (2 * Math.PI * (i + 1)) / segs;
				this.face([at(a0, radius, yy), at(a1, radius, yy), at(a1, radius * rim, yy), at(a0, radius * rim, yy)], 'tyre', out);
				inner.push(at(a0, radius * rim, yy));
			}
			this.face(inner, 'rim', out);
		}
		for (let i = 0; i < segs; i++) {
			const a0 = (2 * Math.PI * i) / segs;
			const a1 = (2 * Math.PI * (i + 1)) / segs;
			const mid = (a0 + a1) / 2;
			this.face([at(a0, radius, y - width / 2), at(a0, radius, y + width / 2), at(a1, radius, y + width / 2), at(a1, radius, y - width / 2)], 'tyre', [Math.cos(mid), 0, Math.sin(mid)]);
		}
	}

	/** A low-poly sphere (80 faces); `paint(point)` can pick the material per face. */
	ball(centre: V, radius: number, material: string, scale: V = [1, 1, 1], paint?: (p: V) => string): void {
		for (const tri of BALL) {
			const pts = tri.map((p): V => [centre[0] + p[0] * radius * scale[0], centre[1] + p[1] * radius * scale[1], centre[2] + p[2] * radius * scale[2]]);
			const mid = mul(add(add(pts[0], pts[1]), pts[2]), 1 / 3);
			this.face(pts, paint ? paint(mid) : material, sub(mid, centre));
		}
	}

	/** The finished model, centred on the ground, in three.js axes. */
	build(materials: Map<string, THREE.Material>): Model {
		let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity;
		for (const list of this.triangles.values()) {
			for (let i = 0; i < list.length; i += 3) {
				minX = Math.min(minX, list[i]);
				maxX = Math.max(maxX, list[i]);
				minY = Math.min(minY, list[i + 1]);
				maxY = Math.max(maxY, list[i + 1]);
				minZ = Math.min(minZ, list[i + 2]);
			}
		}
		const cx = (minX + maxX) / 2;
		const cy = (minY + maxY) / 2;
		const parts: ModelPart[] = [];
		for (const [name, list] of this.triangles) {
			const pos = new Float32Array(list.length);
			for (let i = 0; i < list.length; i += 3) {
				// model (x forward, y left, z up) → three.js (x, y up, z = −left)
				pos[i] = list[i] - cx;
				pos[i + 1] = list[i + 2] - minZ;
				pos[i + 2] = -(list[i + 1] - cy);
			}
			const geometry = new THREE.BufferGeometry();
			geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
			geometry.computeVertexNormals(); // not indexed: one normal per face, the flat low-poly look
			parts.push({ geometry, material: materials.get(name)! });
		}
		return { parts, length: maxX - minX };
	}
}

/** The faces of a unit sphere: an icosahedron, each face split in four. */
const BALL: V[][] = (() => {
	const t = (1 + Math.sqrt(5)) / 2;
	const v: V[] = ([[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]] as V[]).map(unit);
	const faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
	const out: V[][] = [];
	for (const [a, b, c] of faces) {
		const ab = unit(add(v[a], v[b]));
		const bc = unit(add(v[b], v[c]));
		const ca = unit(add(v[c], v[a]));
		out.push([v[a], ab, ca], [v[b], bc, ab], [v[c], ca, bc], [ab, bc, ca]);
	}
	return out;
})();

// ---------------------------------------------------------------------- cars
interface CarShape {
	length: number;
	width: number;
	height: number;
	/** length of bonnet and boot */
	hood: number;
	deck: number;
	/** height of the belt line (where the windows start) */
	belt: number;
	wheel: number;
	cabinFront: number;
	cabinBack: number;
	/** how far the windscreen and the rear window lean (m) */
	screen: number;
	back: number;
}

/** A passenger car from two extruded outlines: the body up to the belt line and the cabin on top. */
function car(s: CarShape): Builder {
	const m = new Builder();
	const x0 = -s.length / 2;
	const x1 = s.length / 2;
	const ground = 0.2;
	const half = s.width / 2;
	m.prism([[x0 + 0.08, ground], [x1 - 0.1, ground], [x1, 0.42], [x1 - 0.04, s.belt - 0.14], [x1 - s.hood, s.belt], [x0 + s.deck, s.belt], [x0 + 0.02, s.belt - 0.06], [x0, 0.45]], half, 'tint_body', 'tint_body');
	const cabHalf = half - 0.11;
	const a = x0 + s.cabinBack;
	const b = x1 - s.cabinFront;
	m.prism([[a, s.belt], [b, s.belt], [b - s.screen, s.height], [a + s.back, s.height]], cabHalf, ['dark', 'glass', 'tint_body', 'glass'], 'glass');
	// pillars: thin body-coloured posts that break up the side windows
	const mid = (a + b) / 2 - 0.1;
	for (const y of [-cabHalf - 0.005, cabHalf - 0.035]) m.box([mid, y, s.belt], [mid + 0.09, y + 0.04, s.height - 0.02], 'tint_body');
	for (const x of [x1 - s.hood * 0.62 - 0.1, x0 + Math.max(s.deck, 0.55) * 0.62 + 0.2]) {
		for (const y of [-half + 0.1, half - 0.1]) m.wheel(x, y, s.wheel, 0.22);
	}
	for (const y of [-half + 0.18, half - 0.48]) {
		m.box([x1 - 0.03, y, s.belt - 0.3], [x1 + 0.012, y + 0.3, s.belt - 0.17], 'light');
		m.box([x0 - 0.012, y, s.belt - 0.26], [x0 + 0.03, y + 0.3, s.belt - 0.12], 'tail');
	}
	m.box([x1 - 0.06, -half + 0.05, ground + 0.02], [x1 + 0.02, half - 0.05, ground + 0.2], 'dark');
	m.box([x0 - 0.02, -half + 0.05, ground + 0.02], [x0 + 0.06, half - 0.05, ground + 0.22], 'dark');
	return m;
}

/** Lorry: a cab with windscreen in front of a box body on a chassis. */
function truck(): Builder {
	const m = new Builder();
	const length = 7.6;
	const half = 1.25;
	const height = 3.4;
	const cabLen = 1.9;
	const cabHeight = 2.75;
	const r = 0.5;
	const x0 = -length / 2;
	const x1 = length / 2;
	const floor = r * 2 + 0.12;
	m.box([x0 + 0.1, -half + 0.3, r * 0.9], [x1 - 0.2, half - 0.3, floor], 'dark');
	const cx = x1 - cabLen;
	m.box([cx, -half + 0.05, 0.45], [x1, half - 0.05, cabHeight * 0.52], 'tint_body');
	m.prism([[cx, cabHeight * 0.52], [x1, cabHeight * 0.52], [x1 - 0.14, cabHeight], [cx, cabHeight]], half - 0.08, ['dark', 'glass', 'tint_body', 'tint_body'], 'glass');
	m.box([cx, -half + 0.06, cabHeight * 0.52], [cx + cabLen * 0.38, half - 0.06, cabHeight - 0.01], 'tint_body');
	for (const y of [-half + 0.12, half - 0.47]) m.box([x1 - 0.02, y, 0.62], [x1 + 0.015, y + 0.35, 0.8], 'light');
	m.box([x1 - 0.05, -half + 0.03, 0.3], [x1 + 0.03, half - 0.03, 0.55], 'dark');
	m.box([x0, -half, floor], [cx - 0.18, half, height], 'cargo');
	for (const y of [-half + 0.1, half - 0.4]) m.box([x0 - 0.015, y, floor + 0.05], [x0 + 0.02, y + 0.3, floor + 0.22], 'tail');
	for (const x of [2.75, -1.7, -2.85]) for (const y of [-half + 0.16, half - 0.16]) m.wheel(x, y, r, 0.3);
	return m;
}

/** One car body of a bus or tram: coloured skirt, window band, light roof. */
function coach(m: Builder, x0: number, x1: number, width: number, height: number, floor: number, noseFront: number, noseBack: number, band: [number, number]): void {
	const half = width / 2;
	const [z0, z1] = band;
	m.box([x0, -half, floor], [x1, half, z0], 'tint_body');
	m.prism([[x0 + noseBack * 0.3, z0], [x1 - noseFront * 0.3, z0], [x1 - noseFront, z1], [x0 + noseBack, z1]], half - 0.03, 'glass', 'glass');
	m.prism([[x0 + noseBack, z1], [x1 - noseFront, z1], [x1 - noseFront - 0.25, height], [x0 + noseBack + 0.25, height]], half - 0.02, 'roof', 'tint_body');
	const n = Math.max(2, Math.floor((x1 - x0) / 1.5));
	for (let i = 1; i < n; i++) {
		const x = x0 + ((x1 - x0) * i) / n;
		for (const y of [-half - 0.007, half - 0.045]) m.box([x - 0.05, y, z0], [x + 0.05, y + 0.052, z1], 'tint_body');
	}
}

function bus(): Builder {
	const m = new Builder();
	const length = 12;
	const half = 2.55 / 2;
	const x0 = -length / 2;
	const x1 = length / 2;
	coach(m, x0, x1, 2.55, 3.0, 0.32, 0.35, 0.1, [1.25, 2.35]);
	for (const y of [-half + 0.2, half - 0.6]) {
		m.box([x1 - 0.02, y, 0.55], [x1 + 0.015, y + 0.4, 0.72], 'light');
		m.box([x0 - 0.015, y, 0.7], [x0 + 0.02, y + 0.4, 0.9], 'tail');
	}
	for (const x of [x1 - 2.6, x0 + 3.2]) for (const y of [-half + 0.17, half - 0.17]) m.wheel(x, y, 0.5, 0.3);
	return m;
}

function tram(): Builder {
	const m = new Builder();
	const length = 24;
	const width = 2.4;
	const height = 3.3;
	const half = width / 2;
	const x0 = -length / 2;
	const x1 = length / 2;
	const gap = 0.5;
	const carLen = (length - 2 * gap) / 3;
	for (let i = 0; i < 3; i++) {
		const a = x0 + i * (carLen + gap);
		const b = a + carLen;
		coach(m, a, b, width, height, 0.3, i === 2 ? 0.9 : 0, i === 0 ? 0.9 : 0, [1.15, 2.4]);
		if (i < 2) m.box([b, -half + 0.12, 0.35], [b + gap, half - 0.12, height - 0.15], 'dark'); // bellows
		const c = (a + b) / 2;
		for (const x of [c - 0.9, c + 0.9]) for (const y of [-half + 0.2, half - 0.2]) m.wheel(x, y, 0.3, 0.14, 10, 0.8);
		m.box([c - 1.4, -half + 0.25, 0.12], [c + 1.4, half - 0.25, 0.42], 'dark');
	}
	// pantograph on the middle car
	const top = height + 0.9;
	m.tube([-0.9, 0, height], [0.1, 0, height + 0.5], 0.035, 0.035, 'metal', 4);
	m.tube([0.1, 0, height + 0.5], [-0.5, 0, top], 0.03, 0.03, 'metal', 4);
	m.box([-0.56, -0.7, top - 0.02], [-0.44, 0.7, top + 0.03], 'dark');
	m.box([-1.1, -0.5, height], [0.4, 0.5, height + 0.12], 'roof');
	for (const y of [-half + 0.25, half - 0.75]) {
		m.box([x1 - 0.03, y, 0.55], [x1 + 0.012, y + 0.5, 0.7], 'light');
		m.box([x0 - 0.012, y, 0.55], [x0 + 0.03, y + 0.5, 0.7], 'tail');
	}
	return m;
}

// ---------------------------------------------------------------------- people
/** Where the joint between two limbs of the given lengths lies (bending towards `forward`). */
function joint(from: V, to: V, upper: number, lower: number, forward: V): V {
	const d = sub(to, from);
	const dist = Math.min(len(d), (upper + lower) * 0.999);
	const dir = unit(d);
	const a = Math.max(-1, Math.min(1, (upper * upper + dist * dist - lower * lower) / (2 * upper * dist)));
	let f = sub(forward, mul(dir, dot(forward, dir)));
	if (len(f) < 1e-6) f = [1, 0, 0];
	f = unit(f);
	return add(add(from, mul(dir, upper * a)), mul(f, upper * Math.sqrt(1 - a * a)));
}

interface Pose {
	hips: V;
	chest: V;
	head: V;
	/** left, right */
	hands: [V, V];
	feet: [V, V];
	/** direction the feet point in */
	toes: V;
	shirt?: string;
	legs?: string;
	arms?: string;
	headgear?: (m: Builder, head: V) => void;
	/** the way the knees bend */
	lean?: V;
}

/** A figure from tubes and a ball, given where its joints are. */
function person(m: Builder, p: Pose): void {
	const shirt = p.shirt ?? 'tint_shirt';
	const legs = p.legs ?? 'trousers';
	const arms = p.arms ?? 'skin';
	const spine = unit(sub(p.chest, p.hips));
	m.tube(sub(p.hips, mul(spine, 0.06)), add(p.chest, mul(spine, 0.08)), 0.125, 0.15, shirt, 8, 1.45, [0, 1, 0]);
	m.tube(add(p.chest, mul(spine, 0.06)), sub(p.head, mul(unit(sub(p.head, p.chest)), 0.08)), 0.05, 0.05, 'skin', 6);
	if (p.headgear) p.headgear(m, p.head);
	else m.ball(p.head, 0.105, 'skin', [1, 0.9, 1.15], (q) => (q[2] > p.head[2] + 0.045 || q[0] < p.head[0] - 0.06 ? 'hair' : 'skin'));
	const toes = unit(p.toes);
	[1, -1].forEach((sign, i) => {
		const shoulder = add(add(p.chest, [0, sign * 0.2, 0]), mul(spine, 0.02));
		const hand = p.hands[i];
		const elbow = joint(shoulder, hand, 0.3, 0.28, [-0.3, sign * 0.6, -1]);
		m.tube(shoulder, elbow, 0.05, 0.042, shirt, 6);
		m.tube(elbow, hand, 0.04, 0.032, arms, 6);
		m.ball(hand, 0.045, arms);
		const hip = add(p.hips, [0, sign * 0.1, 0]);
		const foot = p.feet[i];
		const knee = joint(hip, foot, 0.45, 0.43, p.lean ?? [1, 0, 0]);
		m.tube(hip, knee, 0.08, 0.06, legs, 6);
		m.tube(knee, foot, 0.058, 0.042, legs, 6);
		m.tube(add(sub(foot, mul(toes, 0.06)), [0, 0, -0.03]), add(add(foot, mul(toes, 0.19)), [0, 0, -0.05]), 0.05, 0.04, 'shoes', 6, 1.2, [0, 1, 0]);
	});
}

function pedestrian(): Builder {
	const m = new Builder();
	// mid-stride: left leg forward, right leg back, arms the other way
	person(m, { hips: [0, 0, 0.94], chest: [0.03, 0, 1.4], head: [0.05, 0, 1.63], hands: [[-0.13, 0.27, 0.9], [0.2, -0.26, 0.98]], feet: [[0.3, 0.1, 0.09], [-0.28, -0.1, 0.13]], toes: [1, 0, -0.1] });
	return m;
}

function cyclist(): Builder {
	const m = new Builder();
	const r = 0.34;
	for (const x of [-0.52, 0.52]) m.wheel(x, 0, r, 0.045, 14, 0.88);
	const bb: V = [-0.02, 0, 0.29];
	const seat: V = [-0.2, 0, 0.9];
	const headTop: V = [0.4, 0, 0.93];
	const headLow: V = [0.43, 0, 0.78];
	const tubes: [V, V][] = [[bb, seat], [bb, headLow], [[-0.18, 0, 0.82], headTop], [seat, [-0.52, 0, r]], [bb, [-0.52, 0, r]], [headLow, [0.52, 0, r]], [headLow, [0.38, 0, 1.0]]];
	for (const [a, b] of tubes) m.tube(a, b, 0.02, 0.02, 'frame', 5);
	m.tube([0.4, -0.21, 1.0], [0.4, 0.21, 1.0], 0.016, 0.016, 'dark', 5);
	m.box([-0.33, -0.06, 0.9], [-0.09, 0.06, 0.94], 'dark');
	const pedals: V[] = [[0.12, 0.11, 0.2], [-0.15, -0.11, 0.38]];
	for (const p of pedals) {
		m.tube(bb, [p[0], p[1] * 0.7, p[2]], 0.012, 0.012, 'metal', 4);
		m.box([p[0] - 0.05, p[1] - 0.04, p[2] - 0.012], [p[0] + 0.05, p[1] + 0.04, p[2] + 0.012], 'dark');
	}
	person(m, {
		hips: [-0.2, 0, 1.0], chest: [0.1, 0, 1.36], head: [0.25, 0, 1.56],
		hands: [[0.4, 0.2, 1.03], [0.4, -0.2, 1.03]],
		feet: [[pedals[0][0] - 0.03, pedals[0][1], pedals[0][2] + 0.09], [pedals[1][0] - 0.03, pedals[1][1], pedals[1][2] + 0.09]],
		toes: [1, 0, -0.25], legs: 'suit',
		headgear: (b, head) => {
			b.ball(head, 0.105, 'skin', [1, 0.9, 1.15]);
			b.ball(add(head, [-0.01, 0, 0.06]), 0.125, 'helmet', [1.15, 0.92, 0.72]);
		}
	});
	return m;
}

function motorcyclist(): Builder {
	const m = new Builder();
	const r = 0.31;
	for (const x of [-0.68, 0.7]) m.wheel(x, 0, r, 0.13, 12, 0.6);
	// fairing and tank as one outline, the tail narrower
	m.prism([[-0.95, 0.78], [-0.5, 0.66], [-0.25, 0.5], [0.3, 0.42], [0.72, 0.52], [0.86, 0.8], [0.66, 1.08], [0.5, 0.98], [0.1, 0.93], [-0.25, 0.8], [-0.6, 0.86]], 0.17, 'tint_body', 'tint_body', (x) => (x < -0.45 ? 0.07 : x < 0.6 ? 0.17 : 0.12));
	m.prism([[0.5, 0.98], [0.66, 1.08], [0.6, 1.2], [0.52, 1.04]], 0.13, 'glass', 'glass');
	m.box([-0.3, -0.13, 0.28], [0.32, 0.13, 0.5], 'dark');
	m.box([-0.62, -0.13, 0.84], [-0.2, 0.13, 0.88], 'dark');
	m.tube([-0.25, -0.15, 0.36], [-0.85, -0.17, 0.55], 0.045, 0.055, 'metal', 6);
	for (const y of [-0.09, 0.09]) {
		m.tube([0.56, y, 0.92], [0.7, y, r], 0.025, 0.025, 'metal', 5);
		m.tube([-0.2, y, 0.45], [-0.68, y, r], 0.03, 0.03, 'dark', 4);
	}
	m.tube([0.52, -0.3, 0.98], [0.52, 0.3, 0.98], 0.018, 0.018, 'dark', 5);
	m.box([0.85, -0.09, 0.72], [0.875, 0.09, 0.82], 'light');
	m.box([-0.975, -0.05, 0.76], [-0.95, 0.05, 0.81], 'tail');
	person(m, {
		hips: [-0.36, 0, 0.98], chest: [-0.02, 0, 1.3], head: [0.17, 0, 1.5],
		hands: [[0.5, 0.26, 1.0], [0.5, -0.26, 1.0]], feet: [[-0.2, 0.19, 0.42], [-0.2, -0.19, 0.42]], toes: [1, 0, -0.3],
		shirt: 'suit', legs: 'suit', arms: 'suit', lean: [1, 0, 0.6],
		headgear: (b, head) => {
			const c = add(head, [0.01, 0, 0.02]);
			b.ball(c, 0.15, 'helmet', [1.05, 0.9, 1], (q) => (q[0] > c[0] + 0.07 && Math.abs(q[2] - c[2]) < 0.07 ? 'glass' : 'helmet'));
		}
	});
	return m;
}

/** Builds every model. The materials are shared between the models. */
export function buildModels(): Map<string, Model> {
	const materials = new Map<string, THREE.Material>();
	for (const [name, [color, roughness, metalness]] of Object.entries(PALETTE)) {
		const material = new THREE.MeshStandardMaterial({ color, roughness, metalness });
		material.name = name;
		materials.set(name, material);
	}
	const builders: Record<string, Builder> = {
		sedan: car({ length: 4.55, width: 1.8, height: 1.44, hood: 1.15, deck: 0.95, belt: 0.92, wheel: 0.32, cabinFront: 1.0, cabinBack: 0.75, screen: 0.6, back: 0.55 }),
		hatchback: car({ length: 4.05, width: 1.76, height: 1.48, hood: 1.0, deck: 0.12, belt: 0.93, wheel: 0.31, cabinFront: 0.9, cabinBack: 0.06, screen: 0.55, back: 0.4 }),
		estate: car({ length: 4.7, width: 1.82, height: 1.5, hood: 1.15, deck: 0.1, belt: 0.95, wheel: 0.32, cabinFront: 1.0, cabinBack: 0.04, screen: 0.6, back: 0.22 }),
		suv: car({ length: 4.6, width: 1.9, height: 1.7, hood: 1.1, deck: 0.1, belt: 1.08, wheel: 0.37, cabinFront: 0.95, cabinBack: 0.05, screen: 0.45, back: 0.25 }),
		van: car({ length: 5.0, width: 1.95, height: 1.98, hood: 0.6, deck: 0.05, belt: 1.15, wheel: 0.34, cabinFront: 0.5, cabinBack: 0.03, screen: 0.4, back: 0.05 }),
		truck: truck(),
		bus: bus(),
		tram: tram(),
		cyclist: cyclist(),
		motorcyclist: motorcyclist(),
		pedestrian: pedestrian()
	};
	const models = new Map<string, Model>();
	for (const [name, builder] of Object.entries(builders)) models.set(name, builder.build(materials));
	return models;
}
