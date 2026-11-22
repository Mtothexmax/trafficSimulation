// Reader for Vissim network files (.inpx, XML). Reads what the simulation
// uses; everything else is skipped and listed in `Network.skipped`, so files
// from other Vissim versions still open.
import { bool, child, kids, list, num, parseXml, refs, str, type XmlNode } from './xml';

export interface P {
	x: number;
	y: number;
}

/** "link lane" reference as written in the file, lane counted from 1 = rightmost. */
export interface LaneRef {
	link: number;
	lane: number;
}

export interface Lane {
	width: number;
	/** vehicle class numbers that may not use the lane */
	blockedClasses: number[];
}

export interface Link {
	no: number;
	name: string;
	lanes: Lane[];
	/** centre line, meters, y pointing north */
	points: P[];
	behaviorType: number;
	lnChgDist: number;
	emergStopDist: number;
	/** set on connectors: where it leaves / joins (the rightmost connected lane) */
	from?: LaneRef & { pos: number };
	to?: LaneRef & { pos: number };
}

export type VehicleCategory = 'CAR' | 'HGV' | 'BUS' | 'TRAM' | 'BIKE' | 'PEDESTRIAN';

export interface VehicleType {
	no: number;
	name: string;
	category: VehicleCategory;
	model2D3DDistr: number;
	maxAccelFunc: number;
	desAccelFunc: number;
	maxDecelFunc: number;
	desDecelFunc: number;
}

/** One vehicle model of a model distribution: share and body size. */
export interface ModelShare {
	share: number;
	length: number;
	width: number;
}

/** Acceleration / deceleration function: value over speed (km/h) with its spread. */
export interface FuncPoint {
	x: number;
	y: number;
	yMin: number;
	yMax: number;
}

/** Cumulative distribution: `fx` (0..1) over `x`. */
export interface DistPoint {
	x: number;
	fx: number;
}

export interface CompositionShare {
	vehType: number;
	desSpeedDistr: number;
	relFlow: number;
}

export interface VehicleInput {
	no: number;
	link: number;
	/** veh/h */
	volume: number;
	composition: number;
}

export interface StaticRoute {
	no: number;
	destLink: number;
	destPos: number;
	relFlow: number;
	/** links between the decision link and the destination link */
	linkSeq: number[];
}

export interface RoutingDecision {
	no: number;
	link: number;
	pos: number;
	allVehTypes: boolean;
	vehClasses: number[];
	routes: StaticRoute[];
}

export interface SignalGroupDef {
	no: number;
	name: string;
	amber: number;
	redAmber: number;
	minGreen: number;
	minRed: number;
}

export interface SignalController {
	no: number;
	name: string;
	type: string;
	cycleTime: number;
	/** signal program number the controller is to run */
	progNo: number;
	/** external control program and its supply files, as named in the file */
	progFile: string;
	supplyFiles: string[];
	groups: SignalGroupDef[];
}

export interface SignalHead {
	no: number;
	link: number;
	lane: number;
	pos: number;
	sc: number;
	sg: number;
}

export interface Detector {
	no: number;
	name: string;
	link: number;
	lane: number;
	pos: number;
	length: number;
	sc: number;
	portNo: number;
	type: string;
}

export interface ReducedSpeedArea {
	no: number;
	link: number;
	lane: number;
	pos: number;
	length: number;
	/** vehicle class → desired speed distribution and deceleration (m/s², positive) */
	byClass: Map<number, { desSpeedDistr: number; decel: number }>;
}

export type ConflictStatus = 'PASSIVE' | 'ONEYIELDSTWO' | 'TWOYIELDSONE' | 'UNDETERMINED';

export interface ConflictArea {
	no: number;
	link1: number;
	link2: number;
	status: ConflictStatus;
	frontGap: number;
	rearGap: number;
	addStopDist: number;
}

export interface DrivingBehavior {
	no: number;
	name: string;
	model: 'WIEDEMANN74' | 'WIEDEMANN99' | 'NOINTERACTION';
	lookAheadDistMax: number;
	/** how long a vehicle waits for a lane change it needs before it is taken out of the network (s) */
	diffusTm?: number;
	standDist: number;
	w74ax: number;
	w74bxAdd: number;
	w74bxMult: number;
	/** cc0 … cc9 */
	cc: number[];
}

export interface SimulationSettings {
	/** simulation period (s) */
	period: number;
	/** time steps per simulation second */
	resolution: number;
	randSeed: number;
	/** time of day at simulation second 0 (s since midnight) */
	startTime: number;
}

export interface Network {
	version: string;
	links: Map<number, Link>;
	vehicleTypes: Map<number, VehicleType>;
	/** class number → vehicle type numbers */
	vehicleClasses: Map<number, number[]>;
	/** model distribution number → models */
	modelDistributions: Map<number, ModelShare[]>;
	desSpeedDistributions: Map<number, DistPoint[]>;
	maxAccel: Map<number, FuncPoint[]>;
	desAccel: Map<number, FuncPoint[]>;
	maxDecel: Map<number, FuncPoint[]>;
	desDecel: Map<number, FuncPoint[]>;
	compositions: Map<number, CompositionShare[]>;
	inputs: VehicleInput[];
	routingDecisions: RoutingDecision[];
	controllers: SignalController[];
	signalHeads: SignalHead[];
	detectors: Detector[];
	reducedSpeedAreas: ReducedSpeedArea[];
	conflictAreas: ConflictArea[];
	drivingBehaviors: Map<number, DrivingBehavior>;
	/** link behaviour type → default driving behaviour */
	linkBehaviorTypes: Map<number, number>;
	simulation: SimulationSettings;
	/** sections of the file that hold objects the simulation does not use (name → object count) */
	skipped: { section: string; count: number }[];
}

export const DEFAULT_LANE_WIDTH = 3.5;

const laneRef = (s: string): LaneRef => {
	const [link, lane] = s.trim().split(/\s+/).map(Number);
	return { link: link || 0, lane: lane || 1 };
};

/** Sections that are read, or that only carry display / evaluation settings. */
const KNOWN = new Set([
	'links', 'vehicleTypes', 'vehicleClasses', 'model2D3DDistributions', 'models2D3D', 'desSpeedDistributions', 'maxAccelerationFunctions', 'desAccelerationFunctions',
	'maxDecelerationFunctions', 'desDecelerationFunctions', 'vehicleCompositions', 'vehicleInputs', 'vehicleRoutingDecisionsStatic', 'signalControllers', 'signalHeads',
	'detectors', 'reducedSpeedAreas', 'conflictAreas', 'drivingBehaviors', 'linkBehaviorTypes', 'simulation'
]);
const IRRELEVANT = new Set([
	'netPara', 'displayTypes', 'levels', 'colorDistributions', 'weightDistributions', 'powerDistributions', 'timeDistributions', 'locationDistributions', 'occupancyDistributions',
	'timeIntervalSets', 'anmDefaults', 'evaluation', 'dynamicAssignment', 'wttFiles', 'nodes', 'pedestrianTypes', 'pedestrianClasses', 'walkingBehaviors', 'pedestrianCompositions'
]);

function funcPoints(n: XmlNode): FuncPoint[] {
	return kids(n.children[0]).map((p) => ({ x: num(p, 'x'), y: num(p, 'y'), yMin: num(p, 'yMin', num(p, 'y')), yMax: num(p, 'yMax', num(p, 'y')) }));
}

export function parseInpx(text: string): Network {
	const root = parseXml(text);
	if (root.tag !== 'network') throw new Error(`Not a Vissim network file (root element <${root.tag}>)`);

	const links = new Map<number, Link>();
	for (const l of list(root, 'links')) {
		const from = child(l, 'fromLinkEndPt');
		const to = child(l, 'toLinkEndPt');
		const link: Link = {
			no: num(l, 'no'),
			name: str(l, 'name'),
			lanes: list(l, 'lanes').map((ln) => ({ width: num(ln, 'width', DEFAULT_LANE_WIDTH), blockedClasses: refs(child(ln, 'blockedVehClasses')) })),
			points: kids(child(child(l, 'geometry'), 'points3D')).map((p) => ({ x: num(p, 'x'), y: num(p, 'y') })),
			behaviorType: num(l, 'linkBehavType', 1),
			lnChgDist: num(l, 'lnChgDist', 200),
			emergStopDist: num(l, 'emergStopDist', 5)
		};
		if (!link.lanes.length) link.lanes.push({ width: DEFAULT_LANE_WIDTH, blockedClasses: [] });
		if (from && to) {
			link.from = { ...laneRef(str(from, 'lane')), pos: num(from, 'pos') };
			link.to = { ...laneRef(str(to, 'lane')), pos: num(to, 'pos') };
		}
		if (link.points.length >= 2) links.set(link.no, link);
	}

	const vehicleTypes = new Map<number, VehicleType>();
	for (const v of list(root, 'vehicleTypes')) {
		vehicleTypes.set(num(v, 'no'), {
			no: num(v, 'no'),
			name: str(v, 'name'),
			category: (str(v, 'category', 'CAR') as VehicleCategory) || 'CAR',
			model2D3DDistr: num(v, 'model2D3DDistr'),
			maxAccelFunc: num(v, 'maxAccelFunc'),
			desAccelFunc: num(v, 'desAccelFunc'),
			maxDecelFunc: num(v, 'maxDecelFunc'),
			desDecelFunc: num(v, 'desDecelFunc')
		});
	}

	const vehicleClasses = new Map<number, number[]>();
	for (const c of list(root, 'vehicleClasses')) vehicleClasses.set(num(c, 'no'), refs(child(c, 'vehTypes')));

	// models: body length = sum of the segments, width = widest segment
	const models = new Map<number, { length: number; width: number }>();
	for (const m of list(root, 'models2D3D')) {
		const segs = list(m, 'model2D3DSegs');
		models.set(num(m, 'no'), { length: segs.reduce((s, x) => s + num(x, 'length'), 0), width: Math.max(0, ...segs.map((x) => num(x, 'width'))) });
	}
	const modelDistributions = new Map<number, ModelShare[]>();
	for (const d of list(root, 'model2D3DDistributions')) {
		const shares: ModelShare[] = [];
		for (const e of list(d, 'model2D3DDistrEl')) {
			const model = models.get(num(e, 'model2D3D'));
			if (model && model.length > 0) shares.push({ share: num(e, 'share', 1), ...model });
		}
		modelDistributions.set(num(d, 'no'), shares);
	}

	const desSpeedDistributions = new Map<number, DistPoint[]>();
	for (const d of list(root, 'desSpeedDistributions')) desSpeedDistributions.set(num(d, 'no'), list(d, 'speedDistrDatPts').map((p) => ({ x: num(p, 'x'), fx: num(p, 'fx') })));

	const functions = (section: string): Map<number, FuncPoint[]> => new Map(list(root, section).map((f) => [num(f, 'no'), funcPoints(f)]));

	const compositions = new Map<number, CompositionShare[]>();
	for (const c of list(root, 'vehicleCompositions')) {
		compositions.set(num(c, 'no'), list(c, 'vehCompRelFlows').map((r) => ({ vehType: num(r, 'vehType'), desSpeedDistr: num(r, 'desSpeedDistr'), relFlow: num(r, 'relFlow', 1) })));
	}

	const inputs: VehicleInput[] = [];
	for (const v of list(root, 'vehicleInputs')) {
		// first time interval only: the volume at the start of the simulation
		const vol = list(v, 'timeIntVehVols')[0];
		if (vol) inputs.push({ no: num(v, 'no'), link: num(v, 'link'), volume: num(vol, 'volume'), composition: num(vol, 'vehComp') });
	}

	const routingDecisions: RoutingDecision[] = list(root, 'vehicleRoutingDecisionsStatic').map((d) => ({
		no: num(d, 'no'),
		link: num(d, 'link'),
		pos: num(d, 'pos'),
		allVehTypes: bool(d, 'allVehTypes', true),
		vehClasses: refs(child(d, 'vehClasses')),
		routes: list(d, 'vehRoutSta').map((r) => ({
			no: num(r, 'no'),
			destLink: num(r, 'destLink'),
			destPos: num(r, 'destinationPosition'),
			// "<time interval set> <interval>:<value>[,…]" – the first interval's value
			relFlow: Number(str(r, 'relFlow').split(',')[0].split(':')[1] ?? 1) || 0,
			linkSeq: refs(child(r, 'linkSeq'))
		}))
	}));

	const controllers: SignalController[] = list(root, 'signalControllers').map((c) => ({
		no: num(c, 'no'),
		name: str(c, 'name'),
		type: str(c, 'type'),
		cycleTime: num(c, 'cycTm'),
		progNo: num(c, 'progNo', 1),
		progFile: str(c, 'progFile'),
		supplyFiles: [str(c, 'supplyFile1'), str(c, 'supplyFile2')].filter(Boolean),
		groups: list(c, 'sGs').map((g) => ({ no: num(g, 'no'), name: str(g, 'name'), amber: num(g, 'amber', 3), redAmber: num(g, 'redAmber', 1), minGreen: num(g, 'minGreen', 5), minRed: num(g, 'minRed', 1) }))
	}));

	const signalHeads: SignalHead[] = list(root, 'signalHeads').map((h) => {
		const [sc, sg] = str(h, 'sg').trim().split(/\s+/).map(Number);
		return { no: num(h, 'no'), ...laneRef(str(h, 'lane')), pos: num(h, 'pos'), sc: sc || 0, sg: sg || 0 };
	});

	const detectors: Detector[] = list(root, 'detectors').map((d) => ({
		no: num(d, 'no'),
		name: str(d, 'name'),
		...laneRef(str(d, 'lane')),
		pos: num(d, 'pos'),
		length: num(d, 'length'),
		sc: num(d, 'sc'),
		portNo: num(d, 'portNo'),
		type: str(d, 'type', 'STANDARD')
	}));

	const reducedSpeedAreas: ReducedSpeedArea[] = list(root, 'reducedSpeedAreas').map((a) => ({
		no: num(a, 'no'),
		...laneRef(str(a, 'lane')),
		pos: num(a, 'pos'),
		length: num(a, 'length'),
		byClass: new Map(list(a, 'vehClassSpeedRed').map((r) => [num(r, 'vehClass'), { desSpeedDistr: num(r, 'desSpeedDistr'), decel: Math.abs(num(r, 'decel', 2)) }]))
	}));

	const conflictAreas: ConflictArea[] = list(root, 'conflictAreas').map((c) => ({
		no: num(c, 'no'),
		link1: num(c, 'link1'),
		link2: num(c, 'link2'),
		status: str(c, 'status', 'PASSIVE') as ConflictStatus,
		frontGap: num(c, 'frontGapDef', 0.5),
		rearGap: num(c, 'rearGapDef', 0.5),
		addStopDist: num(c, 'addStopDist', 0)
	}));

	const drivingBehaviors = new Map<number, DrivingBehavior>();
	for (const b of list(root, 'drivingBehaviors')) {
		const model = str(b, 'carFollowModType', 'WIEDEMANN74');
		drivingBehaviors.set(num(b, 'no'), {
			no: num(b, 'no'),
			name: str(b, 'name'),
			model: model === 'WIEDEMANN99' || model === 'NOINTERACTION' ? model : 'WIEDEMANN74',
			lookAheadDistMax: num(b, 'lookAheadDistMax', 250),
			diffusTm: num(b, 'diffusTm', 60),
			standDist: num(b, 'standDist', 0.5),
			w74ax: num(b, 'w74ax', 2),
			w74bxAdd: num(b, 'w74bxAdd', 2),
			w74bxMult: num(b, 'w74bxMult', 3),
			cc: [1.5, 0.9, 4, -8, -0.35, 0.35, 11.44, 0.25, 3.5, 1.5].map((d, i) => num(b, `w99cc${i}`, d))
		});
	}

	const linkBehaviorTypes = new Map(list(root, 'linkBehaviorTypes').map((t) => [num(t, 'no'), num(t, 'drivBehavDef', 1)] as const));

	const sim = child(root, 'simulation');
	const simulation: SimulationSettings = { period: num(sim, 'simPeriod', 3600), resolution: Math.max(1, num(sim, 'simRes', 10)), randSeed: num(sim, 'randSeed', 42), startTime: num(sim, 'startTm', 0) };

	const skipped = root.children.filter((s) => !KNOWN.has(s.tag) && !IRRELEVANT.has(s.tag) && s.children.length > 0).map((s) => ({ section: s.tag, count: s.children.length }));

	return {
		version: str(root, 'version'),
		links, vehicleTypes, vehicleClasses, modelDistributions, desSpeedDistributions,
		maxAccel: functions('maxAccelerationFunctions'), desAccel: functions('desAccelerationFunctions'),
		maxDecel: functions('maxDecelerationFunctions'), desDecel: functions('desDecelerationFunctions'),
		compositions, inputs, routingDecisions, controllers, signalHeads, detectors, reducedSpeedAreas, conflictAreas,
		drivingBehaviors, linkBehaviorTypes, simulation, skipped
	};
}
