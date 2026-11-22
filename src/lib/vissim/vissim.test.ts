import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseXml } from './xml';
import { parseInpx } from './inpx';
import { groupState, parseSig } from './sig';
import { buildRuntime, laneKey, lanePose, Polyline } from './net';
import { quantile, Simulation, wiedemann74, wiedemann99 } from './sim';
import { CODE, VaBridge, type Triple } from './va';
import { defaultStartAt } from './transport';
import { readSignalPrograms } from './supply';

// The tests run on a sample network that is not part of the repository: put a
// Vissim network and its fixed-time program into static/samples as
// beispiel.inpx and beispiel.sig. Without them these tests are skipped.
const samplePath = (name: string): URL => new URL(`../../../static/samples/${name}`, import.meta.url);
const haveSamples = existsSync(samplePath('beispiel.inpx')) && existsSync(samplePath('beispiel.sig'));
const sample = (name: string): string => (haveSamples ? readFileSync(samplePath(name), 'utf8') : '');
const inpx = sample('beispiel.inpx');
const sig = sample('beispiel.sig');

describe('xml', () => {
	it('reads elements, attributes and entities', () => {
		const root = parseXml('<?xml version="1.0"?><!-- c --><a x="1" y=\'two &amp; three\'><b/><b k="&lt;"></b></a>');
		expect(root.tag).toBe('a');
		expect(root.attrs).toEqual({ x: '1', y: 'two & three' });
		expect(root.children.map((c) => c.attrs.k)).toEqual([undefined, '<']);
	});

	it('rejects broken nesting', () => {
		expect(() => parseXml('<a><b></a>')).toThrow();
		expect(() => parseXml('<a>')).toThrow();
	});
});

describe.skipIf(!haveSamples)('inpx reader', () => {
	if (!haveSamples) return;
	const net = parseInpx(inpx);

	it('reads the network objects of the sample file', () => {
		expect(net.version).toBe('6');
		expect(net.links.size).toBe(29);
		expect([...net.links.values()].filter((l) => l.from).length).toBe(10);
		expect(net.inputs.map((i) => [i.link, i.volume])).toEqual([[2, 580], [6, 740], [11, 280]]);
		expect(net.routingDecisions).toHaveLength(7);
		expect(net.signalHeads).toHaveLength(18);
		expect(net.detectors).toHaveLength(22);
		expect(net.conflictAreas).toHaveLength(82);
		expect(net.reducedSpeedAreas).toHaveLength(9);
		expect(net.controllers[0].groups).toHaveLength(11);
		expect(net.simulation).toMatchObject({ period: 900, resolution: 5, randSeed: 42 });
	});

	it('reads lanes, connectors and routes in detail', () => {
		const link2 = net.links.get(2)!;
		expect(link2.lanes.map((l) => l.width)).toEqual([3, 3]);
		const c = net.links.get(10000)!;
		expect(c.from).toMatchObject({ link: 6, lane: 1 });
		expect(c.to).toMatchObject({ link: 4, lane: 1 });
		expect(c.lanes).toHaveLength(2);
		const d = net.routingDecisions[0];
		expect(d.vehClasses).toEqual([90]);
		expect(d.routes.map((r) => [r.destLink, r.relFlow, r.linkSeq])).toEqual([[12, 20, [10007]], [9, 100, [10004]]]);
		expect(net.signalHeads[0]).toMatchObject({ link: 10007, lane: 1, sc: 1, sg: 5 });
		expect(net.drivingBehaviors.get(1)).toMatchObject({ model: 'WIEDEMANN74', w74ax: 2 });
		expect(net.modelDistributions.get(10)![0].length).toBeCloseTo(4.211);
	});

	it('reports nothing unknown in the sample and rejects other XML', () => {
		expect(net.skipped).toEqual([]);
		expect(() => parseInpx('<foo/>')).toThrow(/Vissim/);
	});
});

describe.skipIf(!haveSamples)('signal program', () => {
	if (!haveSamples) return;
	const file = parseSig(sig);
	const prog = file.programs[0];

	it('reads the fixed-time program', () => {
		expect(file.sc).toBe(1);
		expect(prog.cycleTime).toBe(110000);
		expect(prog.groups.size).toBe(11);
	});

	it('gives the state of a group through the cycle', () => {
		// K 1: green command at 26 s (1 s red/amber first), red command at 72 s (3 s amber first)
		expect(groupState(prog, 1, 10)).toBe('red');
		expect(groupState(prog, 1, 26.5)).toBe('redamber');
		expect(groupState(prog, 1, 27.5)).toBe('green');
		expect(groupState(prog, 1, 73)).toBe('amber');
		expect(groupState(prog, 1, 75.5)).toBe('red');
		expect(groupState(prog, 1, 110 + 30)).toBe('green'); // next cycle
		// K 3 is green across the cycle boundary (82 s → 5 s)
		expect(groupState(prog, 3, 100)).toBe('green');
		expect(groupState(prog, 3, 2)).toBe('green');
		expect(groupState(prog, 3, 20)).toBe('red');
		expect(groupState(prog, 99, 20)).toBe('off');
	});
});

describe.skipIf(!haveSamples)('runtime network', () => {
	if (!haveSamples) return;
	const rt = buildRuntime(parseInpx(inpx));

	it('measures along polylines', () => {
		const p = new Polyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
		expect(p.length).toBe(20);
		expect(p.at(15)).toMatchObject({ x: 10, y: 5, dx: 0, dy: 1 });
		expect(p.at(-2).x).toBeCloseTo(-2); // continues straight before the start
		expect(p.distanceTo({ x: 5, y: 3 })).toBeCloseTo(3);
	});

	it('puts lane 1 on the right of the direction of travel', () => {
		const rl = rt.links.get(2)!; // two lanes of 3 m, heading roughly east
		const centre = rl.poly.at(10);
		const right = lanePose(rl, 1, 10);
		const left = lanePose(rl, 2, 10);
		// y points north: right of an eastbound link is south
		expect(right.y).toBeLessThan(centre.y);
		expect(left.y).toBeGreaterThan(centre.y);
		expect(Math.hypot(left.x - right.x, left.y - right.y)).toBeCloseTo(3);
	});

	it('attaches connectors, resolves routes and builds conflict zones', () => {
		expect(rt.warnings).toEqual([]);
		expect(rt.links.get(2)!.out.map((c) => c.no).sort()).toEqual([10004, 10007]);
		expect(rt.decisionsByLink.get(2)![0].routes.map((r) => r.path)).toEqual([[2, 10007, 12], [2, 10004, 9]]);
		expect(rt.zones.length).toBeGreaterThan(0);
		for (const z of rt.zones) {
			expect(z.y1).toBeGreaterThan(z.y0);
			expect(z.p1).toBeGreaterThan(z.p0);
		}
		// connectors start where they leave their link
		const c = rt.links.get(10007)!;
		const from = lanePose(rt.links.get(2)!, 1, c.link.from!.pos);
		const start = lanePose(c, 1, 0);
		expect(Math.hypot(from.x - start.x, from.y - start.y)).toBeLessThan(1.5);
	});
});

describe.skipIf(!haveSamples)('car following', () => {
	if (!haveSamples) return;
	const b = parseInpx(inpx).drivingBehaviors;
	const w74 = b.get(1)!;
	const w99 = [...b.values()].find((x) => x.model === 'WIEDEMANN99')!;

	it('drives freely when the leader is far away', () => {
		expect(wiedemann74(10, 200, 10, 0, 1.2, w74, 0.5, 0.5)).toBe(1.2);
		expect(wiedemann99(10, 200, 10, 0, 1.2, w99, 3)).toBeCloseTo(1.2);
	});

	it('brakes when closing in on a standing leader', () => {
		expect(wiedemann74(10, 15, 0, 0, 1.2, w74, 0.5, 0.5)).toBeLessThan(-2);
		expect(wiedemann99(10, 8, 0, 0, 1.2, w99, 3)).toBeLessThan(-2);
	});

	it('takes quantiles of a distribution', () => {
		const d = [{ x: 48, fx: 0 }, { x: 58, fx: 1 }];
		expect(quantile(d, 0.5, 0)).toBe(53);
		expect(quantile(d, 0, 0)).toBe(48);
		expect(quantile(undefined, 0.5, 7)).toBe(7);
	});
});

describe.skipIf(!haveSamples)('simulation of the sample network', () => {
	if (!haveSamples) return;
	const run = (seconds: number, withSignals = true): Simulation => {
		const sim = new Simulation(buildRuntime(parseInpx(inpx)), withSignals ? [parseSig(sig)] : []);
		const steps = Math.round(seconds / sim.dt);
		for (let i = 0; i < steps; i++) sim.step();
		return sim;
	};

	it('runs the whole period: traffic flows, nobody collides, nobody runs a red light', () => {
		const sim = new Simulation(buildRuntime(parseInpx(inpx)), [parseSig(sig)]);
		const heads = sim.rt.net.signalHeads;
		const before = new Map<number, number>(); // vehicle id → position on its head's lane
		let ranRed = 0;
		let overlaps = 0;
		let maxVehicles = 0;
		const steps = Math.round(900 / sim.dt);
		for (let i = 0; i < steps; i++) {
			sim.step();
			maxVehicles = Math.max(maxVehicles, sim.vehicles.length);
			for (const v of sim.vehicles) {
				// crossed a head this step while it showed red (and had been red for a while)?
				for (const h of heads) {
					if (laneKey(h.link, h.lane) !== laneKey(v.link.no, v.lane)) continue;
					const prev = before.get(v.id);
					if (prev !== undefined && prev < h.pos && v.s >= h.pos + 0.5 && sim.signals.get(Simulation.signalKey(h.sc, h.sg)) === 'red' && v.goHead !== h.no && v.v > 1) ranRed++;
				}
				before.set(v.id, v.link.connector || heads.some((h) => h.link === v.link.no) ? v.s : -Infinity);
			}
			// same lane, overlapping bodies
			const lanes = new Map<number, typeof sim.vehicles>();
			for (const v of sim.vehicles) if (v.category !== 'PEDESTRIAN') lanes.set(laneKey(v.link.no, v.lane), [...(lanes.get(laneKey(v.link.no, v.lane)) ?? []), v]);
			for (const l of lanes.values()) {
				l.sort((a, b) => a.s - b.s);
				for (let k = 1; k < l.length; k++) if (l[k].s - l[k].length < l[k - 1].s - 0.3) overlaps++;
			}
		}
		expect(sim.uncontrolled).toEqual([]);
		expect(overlaps).toBe(0);
		expect(sim.collisions).toBe(0);
		expect(ranRed).toBe(0);
		expect(maxVehicles).toBeGreaterThan(10);
		// inflow of 15 minutes at 580 / 740 / 280 veh/h, most of it got through
		const entered = sim.inputStats.map((s) => s.entered);
		expect(entered[0]).toBeGreaterThan(100);
		expect(entered[1]).toBeGreaterThan(130);
		expect(entered[2]).toBeGreaterThan(45);
		for (const s of sim.inputStats) expect(s.left).toBeGreaterThan(s.entered * 0.5);
		// vehicles wait at red: there is delay
		expect(sim.inputStats.reduce((a, s) => a + s.delay, 0)).toBeGreaterThan(0);
	}, 60000);

	it('is reproducible', () => {
		const a = run(120);
		const b = run(120);
		expect(a.vehicles.map((v) => [v.id, v.link.no, v.s])).toEqual(b.vehicles.map((v) => [v.id, v.link.no, v.s]));
	});

	it('stops vehicles at red and counts them on the detectors', () => {
		const sim = run(25); // K 1 (head on connector 10004) is red until 26 s
		const queued = sim.vehicles.filter((v) => v.link.no === 2 && v.v < 0.1);
		expect(queued.length).toBeGreaterThan(0);
		for (const v of queued) expect(v.s).toBeLessThanOrEqual(sim.rt.links.get(10004)!.link.from!.pos + 0.2);
		expect([...sim.detectorStates.values()].some((d) => d.count > 0)).toBe(true);
	});

	it('ignores the signal heads of a controller without a program', () => {
		const sim = run(60, false);
		expect(sim.uncontrolled).toEqual([1]);
		expect(sim.inputStats.some((s) => s.left > 0)).toBe(true);
	});
});

describe.skipIf(!haveSamples)('pedestrians', () => {
	if (!haveSamples) return;
	const run = (seconds: number, pedestriansPerHour?: number): Simulation => {
		const sim = new Simulation(buildRuntime(parseInpx(inpx)), [parseSig(sig)], pedestriansPerHour === undefined ? {} : { pedestriansPerHour });
		for (let i = 0; i < Math.round(seconds / sim.dt); i++) sim.step();
		return sim;
	};

	it('finds the footpaths of the network', () => {
		expect(buildRuntime(parseInpx(inpx)).pedestrianLinks.map((l) => l.no).sort((a, b) => a - b)).toEqual([14, 15, 16, 17, 18, 19]);
	});

	it('lets pedestrians walk along the footpaths and wait at red', () => {
		const sim = new Simulation(buildRuntime(parseInpx(inpx)), [parseSig(sig)], { pedestriansPerHour: 600 });
		const heads = sim.rt.net.signalHeads;
		const before = new Map<number, number>();
		let seen = 0;
		let waiting = 0;
		let crossedAtRed = 0;
		let finished = 0;
		for (let i = 0; i < Math.round(330 / sim.dt); i++) {
			const ids = new Set(sim.vehicles.filter((v) => v.category === 'PEDESTRIAN').map((v) => v.id));
			sim.step();
			for (const v of sim.vehicles) {
				if (v.category !== 'PEDESTRIAN') continue;
				ids.delete(v.id);
				seen = Math.max(seen, v.id);
				expect(sim.rt.pedestrianLinks).toContain(v.link);
				const head = heads.find((h) => h.link === v.link.no)!;
				const state = sim.signals.get(Simulation.signalKey(head.sc, head.sg));
				if (v.v < 0.05 && v.s < head.pos) waiting++;
				const prev = before.get(v.id);
				if (prev !== undefined && prev < head.pos - 0.6 && v.s >= head.pos && state === 'red') crossedAtRed++;
				before.set(v.id, v.s);
			}
			finished += ids.size; // those that reached the end of their footpath
		}
		expect(seen).toBeGreaterThan(0);
		expect(waiting).toBeGreaterThan(0);
		expect(crossedAtRed).toBe(0);
		expect(finished).toBeGreaterThan(10);
	}, 20_000);

	it('does not change the vehicle traffic, and can be switched off', () => {
		const withPeds = run(200, 150);
		const without = run(200); // none unless asked for
		const cars = (s: Simulation): number[][] => s.vehicles.filter((v) => v.category !== 'PEDESTRIAN').map((v) => [v.type.no, v.link.no]);
		expect(without.vehicles.some((v) => v.category === 'PEDESTRIAN')).toBe(false);
		expect(withPeds.vehicles.some((v) => v.category === 'PEDESTRIAN')).toBe(true);
		// same vehicles entered in both runs (their own random stream is untouched)
		expect(withPeds.inputStats.map((s) => s.entered)).toEqual(without.inputStats.map((s) => s.entered));
		expect(cars(withPeds).length).toBeGreaterThan(0);
	});
});

describe.skipIf(!haveSamples)('external traffic-actuated control', () => {
	if (!haveSamples) return;
	const make = (): { sim: Simulation; va: VaBridge } => {
		const sim = new Simulation(buildRuntime(parseInpx(inpx)), []);
		return { sim, va: new VaBridge(sim, sim.rt.net.controllers[0]) };
	};
	const run = (sim: Simulation, seconds: number): void => {
		for (let i = 0; i < Math.round(seconds / sim.dt); i++) sim.step();
	};
	const state = (sim: Simulation, sg: number): string | undefined => sim.signals.get(Simulation.signalKey(1, sg));

	it('takes the controller over: all groups red, nothing uncontrolled', () => {
		const { sim, va } = make();
		expect(sim.uncontrolled).toEqual([]);
		for (let sg = 1; sg <= 11; sg++) expect(state(sim, sg)).toBe('red');
		const setup = va.setup();
		expect(setup).toContainEqual([CODE.UMLAUFZEIT, 0, 110]);
		expect(setup).toContainEqual([CODE.PROGRAMMNUMMER, 0, 1]);
		expect(setup).toContainEqual([CODE.T_GELB, 1, 3]);
		expect(setup.filter((t) => t[0] === CODE.IST_BILD)).toHaveLength(11);
	});

	it('sends the chosen signal program instead of the one of the network file', () => {
		const sim = new Simulation(buildRuntime(parseInpx(inpx)), []);
		const va = new VaBridge(sim, sim.rt.net.controllers[0], 3);
		expect(va.setup()).toContainEqual([CODE.PROGRAMMNUMMER, 0, 3]);
		expect(va.input()).toContainEqual([CODE.PROGRAMMNUMMER, 0, 3]);
	});

	it('adds the transitions to a wanted signal picture, and none when told so', () => {
		const { sim, va } = make();
		va.apply([[CODE.SOLL_BILD, 1, 4], [CODE.SOLL_BILD_O_UE, 2, 4], [CODE.UMLAUFSEKUNDE, 0, 17]]);
		run(sim, 0.4);
		expect(state(sim, 1)).toBe('redamber');
		expect(state(sim, 2)).toBe('green');
		expect(va.cycleSecond).toBe(17);
		run(sim, 1);
		expect(state(sim, 1)).toBe('green');
		va.apply([[CODE.SOLL_BILD, 1, 2], [CODE.SOLL_BILD_O_UE, 3, 6]]);
		run(sim, 2);
		expect(state(sim, 1)).toBe('amber');
		expect(state(sim, 3)).toBe('amberflash');
		run(sim, 1.4);
		expect(state(sim, 1)).toBe('red');
		// repeating the same wish does not restart anything
		va.apply([[CODE.SOLL_BILD, 1, 2]]);
		run(sim, 0.2);
		expect(state(sim, 1)).toBe('red');
	});

	it('reports signal states and detector values by channel, and clears the impulse memory on request', () => {
		const { sim, va } = make();
		va.apply([]);
		// everything red: queues build up on the detectors before the stop lines
		for (let s = 0; s < 40; s++) {
			run(sim, 1);
			if (s < 39) {
				va.input();
				va.apply([]);
			}
		}
		const input = va.input();
		const get = (code: number, index: number): number | undefined => input.find((t) => t[0] === code && t[1] === index)?.[2];
		expect(get(CODE.UMLAUFSEKUNDE, 0)).toBe(40);
		expect(get(CODE.PROGRAMMNUMMER, 0)).toBe(1);
		expect(get(CODE.IST_BILD, 1)).toBe(2);
		expect(get(CODE.LAUFZEIT, 1)).toBe(40);
		const channels = input.filter((t) => t[0] === CODE.ANWESENHEIT);
		expect(channels.length).toBeGreaterThan(5);
		const occupied = channels.filter((t) => t[2] === 1).map((t) => t[1]);
		expect(occupied.length).toBeGreaterThan(0);
		const ch = occupied[0];
		expect(get(CODE.IMPULSSPEICHER, ch)).toBe(1);
		expect(get(CODE.AKT_BELEGUNG, ch)).toBe(100);
		expect(get(CODE.ANG_BELEGUNG, ch)).toBeGreaterThan(0);
		expect(get(CODE.ANG_ZEITLUECKE, ch)).toBe(0);
		va.apply([[CODE.IMPULSSPEICHER, ch, 0]] as Triple[]);
		run(sim, 1);
		expect(va.input().find((t) => t[0] === CODE.IMPULSSPEICHER && t[1] === ch)?.[2]).toBe(0);
	});

	it('lets traffic through on green from the controller', () => {
		const { sim, va } = make();
		// a simple stand-in controller: K 1 / K 2 green for 20 s, then K 3
		for (let s = 0; s < 120; s++) {
			va.input();
			const phase = Math.floor(s / 20) % 2;
			va.apply([[CODE.SOLL_BILD, 1, phase === 0 ? 4 : 2], [CODE.SOLL_BILD, 2, phase === 0 ? 4 : 2], [CODE.SOLL_BILD, 3, phase === 1 ? 4 : 2]]);
			run(sim, 1);
		}
		expect(sim.collisions).toBe(0);
		expect(sim.inputStats.reduce((a, st) => a + st.left, 0)).toBeGreaterThan(5);
	});
});

describe('start time of the controller clock', () => {
	it('is the start time of the network on the given day', () => {
		expect(defaultStartAt(43200, new Date(2026, 10, 18, 9, 30))).toBe('2026-11-18T12:00');
		expect(defaultStartAt(27030, new Date(2026, 0, 5))).toBe('2026-01-05T07:30');
		expect(defaultStartAt(0, new Date(2026, 0, 5))).toBe('2026-01-05T00:00');
	});
});

describe('signal programs of a supply file', () => {
	const hex = (bytes: number[]): string => bytes.map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
	const block = (no: number, mark: number, name: string): string => {
		const bytes = new Array<number>(64).fill(0);
		bytes[4] = no;
		bytes[6] = mark;
		[...name].forEach((c, i) => (bytes[26 + i] = c.charCodeAt(0)));
		return `// AL_sSignalplan Instanz: ${no}
BOT

Data=${hex(bytes.slice(0, 32))}
Data=${hex(bytes.slice(32))}
EOT

`;
	};

	it('lists the filled slots with their names and leaves out the empty ones', () => {
		const text = `::Knotennummer=5

// AL_sStammdaten Instanz: 1
BOT
Data=7C00
EOT

${block(1, 0x33, 'SP 1')}${block(2, 0x33, 'Morgenspitze')}${block(3, 0x31, '')}${block(4, 0x33, '')}`;
		expect(readSignalPrograms(text)).toEqual([{ no: 1, name: 'SP 1' }, { no: 2, name: 'Morgenspitze' }, { no: 4, name: '' }]);
	});

	it('finds nothing in a file of another kind', () => {
		expect(readSignalPrograms('<network/>')).toEqual([]);
	});
});
