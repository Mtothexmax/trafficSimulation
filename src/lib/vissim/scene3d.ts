// 3D view of the network and the running simulation (three.js): asphalt
// ribbons for links and connectors, lane markings, stop lines, signal heads on
// poles that show their group's state, detector loops, and the vehicles as 3D
// models.
//
// Map coordinates (x east, y north, meters) become three.js x / −z, y is up.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildModels, type Model } from './models';
import { asphaltTextures, MARKING_GRAIN } from './asphalt';
import { lanePose, type RLink, type Runtime } from './net';
import { Simulation, type Vehicle } from './sim';
import type { SignalState } from './sig';
import type { P, SignalHead, VehicleCategory } from './inpx';

const C = {
	sky: '#dfe7ef',
	ground: '#a9b89a',
	asphalt: '#8b8f94',
	marking: '#f5f5f2',
	steel: '#8a9097',
	housing: '#17181a',
	loop: '#3f4347',
	occupied: '#ffcc00'
};
const LAMP_ON = { red: '#ff3b30', amber: '#ffcc00', green: '#30d158' };
const LAMP_OFF = { red: '#3a1513', amber: '#3a3010', green: '#123a1c' };
/** which lamps are lit per state: [red, amber, green] */
const LIT: Record<SignalState, [boolean, boolean, boolean]> = {
	red: [true, false, false],
	redamber: [true, true, false],
	green: [false, false, true],
	amber: [false, true, false],
	amberflash: [false, true, false],
	off: [false, false, false]
};

/** The flat road layers are painted in this order before everything else
 * (they lie too close together for the depth buffer): the ground and the
 * paint write no depth, the paint does not test it either. */
const ORDER = { ground: -10, asphalt: -9, loop: -6, marking: -5 };

/** What a vehicle is drawn as: its Vissim category, with motorbikes told apart from bicycles. */
type Look = VehicleCategory | 'MOTORBIKE';
/** The models per look (generated in models.ts). */
const MODELS: Record<Look, string[]> = {
	CAR: ['sedan', 'hatchback', 'estate', 'suv', 'van'],
	HGV: ['truck'],
	BUS: ['bus'],
	TRAM: ['tram'],
	BIKE: ['cyclist'],
	MOTORBIKE: ['motorcyclist'],
	PEDESTRIAN: ['pedestrian']
};

/** Vissim has one category for all two-wheelers: a fast one, or one named like it, is a motorbike. */
function lookOf(v: Vehicle): Look {
	if (v.category === 'BIKE' && (v.vdes > 9 || /krad|motor|moped|roller|scooter/i.test(v.type.name))) return 'MOTORBIKE';
	return v.category;
}
/** Colours for the white `tint_` materials, picked per vehicle: paint for bodies, brighter ones for clothes. */
const BODY_TINTS = ['#e8e9ea', '#b9bec4', '#2b2e33', '#5f6871', '#8a1c1c', '#1f3f73', '#c7c2b3', '#2f5d4a', '#d9b23c', '#7a8ea3'].map((c) => new THREE.Color(c));
const CLOTH_TINTS = ['#d7263d', '#f4b400', '#1b74c5', '#2e9e5b', '#f2f2ee', '#e8601c', '#7b3fa0', '#17a2a2'].map((c) => new THREE.Color(c));

/** Flat polygons (triangle fans of convex quads) at height y; UVs in world meters. */
function quadGeometry(quads: P[][], y: number): THREE.BufferGeometry {
	const pos: number[] = [];
	const uv: number[] = [];
	const put = (p: P): void => {
		pos.push(p.x, y, -p.y);
		uv.push(p.x, p.y);
	};
	for (const q of quads) {
		// front face up: counter-clockwise seen from above
		const ccw = (q[1].x - q[0].x) * (q[2].y - q[0].y) - (q[1].y - q[0].y) * (q[2].x - q[0].x) > 0;
		for (let i = 1; i < q.length - 1; i++) {
			put(q[0]);
			put(ccw ? q[i] : q[i + 1]);
			put(ccw ? q[i + 1] : q[i]);
		}
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
	g.computeVertexNormals();
	return g;
}

/** Quads of a strip along a link between two lateral offsets (to the left of its centre line). */
function strip(rl: RLink, left: number, right: number, from = 0, to = rl.length, dash?: [number, number]): P[][] {
	const quads: P[][] = [];
	const at = (s: number, off: number): P => {
		const p = rl.poly.at(s);
		return { x: p.x - p.dy * off, y: p.y + p.dx * off };
	};
	const piece = (a: number, b: number): void => {
		const n = Math.max(1, Math.ceil((b - a) / 2));
		for (let i = 0; i < n; i++) {
			const s0 = a + ((b - a) * i) / n;
			const s1 = a + ((b - a) * (i + 1)) / n;
			quads.push([at(s0, left), at(s1, left), at(s1, right), at(s0, right)]);
		}
	};
	if (!dash) piece(from, to);
	else for (let s = from; s < to; s += dash[0] + dash[1]) piece(s, Math.min(to, s + dash[0]));
	return quads;
}

export class Scene3D {
	private readonly renderer: THREE.WebGLRenderer;
	private readonly scene = new THREE.Scene();
	private readonly camera: THREE.PerspectiveCamera;
	private readonly controls: OrbitControls;
	private readonly sun: THREE.DirectionalLight;
	private readonly ground: THREE.Mesh;
	private readonly observer: ResizeObserver;
	private readonly textures: THREE.Texture[] = [];
	private readonly asphalt: THREE.MeshStandardMaterial;
	private readonly paint: THREE.MeshStandardMaterial;
	/** everything built from the network */
	private content = new THREE.Group();
	private readonly actors = new THREE.Group();
	private rt: Runtime | null = null;
	private lamps: { head: SignalHead; meshes: [THREE.Mesh, THREE.Mesh, THREE.Mesh]; state: SignalState | null }[] = [];
	private loops: { no: number; mesh: THREE.Mesh }[] = [];
	/** the vehicle models, generated in code, and their instanced meshes */
	private readonly models: Map<string, Model> = buildModels();
	private readonly instances = new Map<string, THREE.InstancedMesh[]>();
	private disposed = false;

	constructor(private readonly host: HTMLElement) {
		this.renderer = new THREE.WebGLRenderer({ antialias: true });
		this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = THREE.PCFShadowMap;
		this.renderer.domElement.style.display = 'block';
		host.appendChild(this.renderer.domElement);

		this.scene.background = new THREE.Color(C.sky);
		this.scene.fog = new THREE.Fog(C.sky, 250, 900);
		this.camera = new THREE.PerspectiveCamera(42, 1, 0.5, 3000);
		this.camera.position.set(60, 80, 90);
		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.maxPolarAngle = Math.PI / 2 - 0.03;
		this.controls.minDistance = 4;
		this.controls.maxDistance = 900;
		this.controls.enableDamping = true;

		this.scene.add(new THREE.HemisphereLight('#ffffff', '#9aa3ad', 1.55));
		this.sun = new THREE.DirectionalLight('#fff6e8', 2.3);
		this.sun.castShadow = true;
		this.sun.shadow.mapSize.set(4096, 4096);
		this.sun.shadow.bias = -0.0004;
		this.sun.shadow.normalBias = 0.03;
		this.scene.add(this.sun, this.sun.target);

		const set = asphaltTextures(C.asphalt);
		const paintMap = set.paint(C.marking, MARKING_GRAIN);
		this.textures.push(set.map, set.normal, paintMap);
		const aniso = Math.min(16, this.renderer.capabilities.getMaxAnisotropy());
		for (const t of this.textures) t.anisotropy = aniso;
		this.asphalt = new THREE.MeshStandardMaterial({ map: set.map, normalMap: set.normal, normalScale: new THREE.Vector2(0.15, 0.15), roughness: 0.95 });
		this.paint = new THREE.MeshStandardMaterial({ map: paintMap, normalMap: set.normal, normalScale: new THREE.Vector2(0.1, 0.1), roughness: 0.8, depthTest: false, depthWrite: false });

		this.ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshStandardMaterial({ color: C.ground, roughness: 1, depthWrite: false }));
		this.ground.rotation.x = -Math.PI / 2;
		this.ground.position.y = -0.03;
		this.ground.receiveShadow = true;
		this.ground.renderOrder = ORDER.ground;
		this.scene.add(this.ground, this.content, this.actors);

		this.observer = new ResizeObserver(() => this.resize());
		this.observer.observe(host);
		this.resize();
	}

	private resize(): void {
		const w = this.host.clientWidth;
		const h = this.host.clientHeight;
		if (!w || !h) return;
		this.renderer.setSize(w, h, false);
		this.renderer.domElement.style.width = '100%';
		this.renderer.domElement.style.height = '100%';
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	}

	/** Builds the static scene of a network (or clears it). */
	setNetwork(rt: Runtime | null): void {
		this.scene.remove(this.content);
		this.content.traverse((o) => {
			const m = o as THREE.Mesh;
			if (!m.isMesh) return;
			m.geometry.dispose();
			if (m.material !== this.asphalt && m.material !== this.paint) (m.material as THREE.Material).dispose();
		});
		this.content = new THREE.Group();
		this.scene.add(this.content);
		this.lamps = [];
		this.loops = [];
		this.rt = rt;
		if (!rt) return;
		this.buildRoads(rt);
		this.buildDetectors(rt);
		this.buildSignals(rt);

		// light and shadows over the whole network
		const b = rt.bounds;
		const cx = (b.minX + b.maxX) / 2;
		const cz = -(b.minY + b.maxY) / 2;
		const r = Math.max(40, Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2 + 20);
		this.sun.position.set(cx + r * 0.55, r * 1.25, cz + r * 0.35);
		this.sun.target.position.set(cx, 0, cz);
		const cam = this.sun.shadow.camera;
		cam.left = cam.bottom = -r;
		cam.right = cam.top = r;
		cam.near = 1;
		cam.far = r * 4;
		cam.updateProjectionMatrix();
		this.fit();
	}

	/** Shows the whole network. */
	fit(): void {
		if (!this.rt) return;
		const b = this.rt.bounds;
		const cx = (b.minX + b.maxX) / 2;
		const cz = -(b.minY + b.maxY) / 2;
		const r = Math.max(30, Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2);
		this.controls.target.set(cx, 0, cz);
		this.camera.position.set(cx + r * 0.25, r * 0.95, cz + r * 1.05);
		this.controls.update();
	}

	/** Dev helper: camera position and target in map coordinates (x, height, y north). */
	setView(position: [number, number, number], target: [number, number, number]): void {
		this.camera.position.set(position[0], position[1], -position[2]);
		this.controls.target.set(target[0], target[1], -target[2]);
		this.controls.update();
	}

	private add(geometry: THREE.BufferGeometry, material: THREE.Material, order?: number, cast = false): THREE.Mesh {
		const m = new THREE.Mesh(geometry, material);
		m.receiveShadow = true;
		m.castShadow = cast;
		if (order !== undefined) m.renderOrder = order;
		this.content.add(m);
		return m;
	}

	private buildRoads(rt: Runtime): void {
		const road: P[][] = [];
		const lines: P[][] = [];
		for (const rl of rt.links.values()) {
			road.push(...strip(rl, rl.width / 2, -rl.width / 2));
			if (rl.connector) continue;
			// edge lines, and dashed lines between the lanes
			const w = 0.12;
			lines.push(...strip(rl, rl.width / 2 - 0.1, rl.width / 2 - 0.1 - w), ...strip(rl, -rl.width / 2 + 0.1 + w, -rl.width / 2 + 0.1));
			for (let k = 1; k < rl.nLanes; k++) {
				const off = (rl.offsets[k - 1] + rl.offsets[k]) / 2;
				lines.push(...strip(rl, off + w / 2, off - w / 2, 0, rl.length, [3, 6]));
			}
		}
		// stop lines at the signal heads
		for (const heads of rt.headsByLane.values()) {
			for (const h of heads) {
				const rl = rt.links.get(h.link)!;
				const half = (rl.link.lanes[h.lane - 1]?.width ?? 3.5) / 2 - 0.1;
				const off = rl.offsets[h.lane - 1] ?? 0;
				lines.push(...strip(rl, off + half, off - half, h.pos - 0.25, h.pos + 0.25));
			}
		}
		this.add(quadGeometry(road, 0), this.asphalt, ORDER.asphalt);
		if (lines.length) this.add(quadGeometry(lines, 0.02), this.paint, ORDER.marking);
	}

	private buildDetectors(rt: Runtime): void {
		const frame: P[][] = [];
		const t = 0.08;
		for (const d of rt.detectors) {
			const rl = rt.links.get(d.link)!;
			const half = (rl.link.lanes[d.lane - 1]?.width ?? 3.5) * 0.36;
			const off = rl.offsets[d.lane - 1] ?? 0;
			const a = d.pos;
			const b = d.pos + Math.max(d.length, 0.5);
			// the loop as a thin frame, and a highlight that shows while it is occupied
			frame.push(...strip(rl, off + half, off + half - t, a, b), ...strip(rl, off - half + t, off - half, a, b), ...strip(rl, off + half, off - half, a, a + t), ...strip(rl, off + half, off - half, b - t, b));
			const mesh = this.add(quadGeometry(strip(rl, off + half, off - half, a, b), 0.02), new THREE.MeshBasicMaterial({ color: C.occupied, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false }), ORDER.loop + 0.5);
			mesh.visible = false;
			this.loops.push({ no: d.no, mesh });
		}
		if (frame.length) this.add(quadGeometry(frame, 0.02), new THREE.MeshStandardMaterial({ color: C.loop, roughness: 0.7, depthTest: false, depthWrite: false }), ORDER.loop);
	}

	/** One pole with a three-lamp head per signal head, beside its lane's stop line, facing the traffic. */
	private buildSignals(rt: Runtime): void {
		const steel = new THREE.MeshStandardMaterial({ color: C.steel, roughness: 0.5, metalness: 0.4 });
		const housing = new THREE.MeshStandardMaterial({ color: C.housing, roughness: 0.6 });
		const poleGeo = new THREE.CylinderGeometry(0.06, 0.07, 3.2, 10);
		const boxGeo = new THREE.BoxGeometry(0.26, 0.86, 0.3);
		const lampGeo = new THREE.CircleGeometry(0.1, 16);
		const taken = new Set<string>();
		for (const heads of rt.headsByLane.values()) {
			for (const h of heads) {
				const rl = rt.links.get(h.link)!;
				const p = lanePose(rl, h.lane, h.pos);
				// right of the lane; a second head at the same spot goes to the left
				const laneHalf = (rl.link.lanes[h.lane - 1]?.width ?? 3.5) / 2;
				let side = -(laneHalf + 0.7);
				const key = (s: number): string => `${Math.round(p.x + p.dy * -s)}:${Math.round(p.y - p.dx * -s)}`;
				if (taken.has(key(side))) side = laneHalf + 0.7;
				taken.add(key(side));
				const x = p.x - p.dy * side;
				const y = p.y + p.dx * side;
				const group = new THREE.Group();
				group.position.set(x, 0, -y);
				// local +z looks against the direction of travel (towards the approaching traffic)
				group.rotation.y = Math.atan2(-p.dx, p.dy);
				const pole = new THREE.Mesh(poleGeo, steel);
				pole.position.y = 1.6;
				pole.castShadow = true;
				const box = new THREE.Mesh(boxGeo, housing);
				box.position.set(0, 2.75, 0.1);
				box.castShadow = true;
				group.add(pole, box);
				const meshes = (['red', 'amber', 'green'] as const).map((colour, i) => {
					const lamp = new THREE.Mesh(lampGeo, new THREE.MeshBasicMaterial({ color: LAMP_OFF[colour] }));
					lamp.position.set(0, 3.03 - i * 0.28, 0.252);
					group.add(lamp);
					return lamp;
				}) as unknown as [THREE.Mesh, THREE.Mesh, THREE.Mesh];
				this.content.add(group);
				this.lamps.push({ head: h, meshes, state: null });
			}
		}
	}

	// ------------------------------------------------------------------ vehicles

	private drawVehicles(sim: Simulation | null): void {
		const vehicles = sim?.vehicles ?? [];
		const m = new THREE.Matrix4();
		const q = new THREE.Quaternion();
		const up = new THREE.Vector3(0, 1, 0);
		const pos = new THREE.Vector3();
		const scale = new THREE.Vector3();
		/** instance matrix of a vehicle; the body is `length` long, the model `modelLength` */
		const place = (v: Vehicle, modelLength: number, height = 1): void => {
			const { front, rear } = sim!.pose(v);
			q.setFromAxisAngle(up, Math.atan2(front.y - rear.y, front.x - rear.x));
			pos.set((front.x + rear.x) / 2, 0.02, -(front.y + rear.y) / 2);
			m.compose(pos, q, scale.set(v.length / modelLength, height, 1));
		};

		const buckets = new Map<string, Vehicle[]>();
		for (const v of vehicles) {
			const names = MODELS[lookOf(v)] ?? MODELS.CAR;
			const name = names[v.id % names.length];
			const l = buckets.get(name);
			if (l) l.push(v);
			else buckets.set(name, [v]);
		}
		for (const [name, model] of this.models) {
			const list = buckets.get(name) ?? [];
			let instances = this.instances.get(name);
			if (!instances) {
				if (!list.length) continue;
				this.instances.set(name, (instances = []));
			}
			if (!instances.length || instances[0].instanceMatrix.count < list.length) {
				for (const old of instances) {
					this.actors.remove(old);
					old.dispose();
				}
				const cap = Math.max(16, list.length * 2);
				instances.length = 0;
				for (const part of model.parts) {
					const im = new THREE.InstancedMesh(part.geometry, part.material, cap);
					im.castShadow = true;
					im.frustumCulled = false;
					this.actors.add(im);
					instances.push(im);
				}
			}
			list.forEach((v, i) => {
				place(v, model.length);
				for (const im of instances) {
					im.setMatrixAt(i, m);
					const material = (im.material as THREE.Material).name;
					if (material.startsWith('tint_')) im.setColorAt(i, material === 'tint_body' ? BODY_TINTS[v.id % BODY_TINTS.length] : CLOTH_TINTS[v.id % CLOTH_TINTS.length]);
				}
			});
			for (const im of instances) {
				im.count = list.length;
				im.instanceMatrix.needsUpdate = true;
				if (im.instanceColor) im.instanceColor.needsUpdate = true;
			}
		}
	}

	/** Draws one frame with the current state of the simulation. */
	render(sim: Simulation | null): void {
		for (const l of this.lamps) {
			const state = sim?.signals.get(Simulation.signalKey(l.head.sc, l.head.sg)) ?? 'off';
			if (state === l.state) continue;
			l.state = state;
			(['red', 'amber', 'green'] as const).forEach((colour, i) => (l.meshes[i].material as THREE.MeshBasicMaterial).color.set(LIT[state][i] ? LAMP_ON[colour] : LAMP_OFF[colour]));
		}
		for (const l of this.loops) l.mesh.visible = !!sim?.detectorStates.get(l.no)?.occupied;
		this.drawVehicles(sim);
		this.controls.update();
		this.renderer.render(this.scene, this.camera);
	}

	dispose(): void {
		this.disposed = true;
		this.observer.disconnect();
		this.controls.dispose();
		this.setNetwork(null);
		for (const instances of this.instances.values()) for (const im of instances) im.dispose();
		const materials = new Set<THREE.Material>();
		for (const model of this.models.values()) {
			for (const part of model.parts) {
				part.geometry.dispose();
				materials.add(part.material);
			}
		}
		for (const material of materials) material.dispose();
		for (const t of this.textures) t.dispose();
		this.asphalt.dispose();
		this.paint.dispose();
		this.ground.geometry.dispose();
		(this.ground.material as THREE.Material).dispose();
		this.renderer.dispose();
		this.renderer.domElement.remove();
	}
}
