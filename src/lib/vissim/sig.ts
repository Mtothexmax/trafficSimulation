// Reader for Vissim fixed-time signal programs (.sig, XML) and the signal
// state of every group at a given time.
import { child, kids, list, num, parseXml, str } from './xml';

/** `amberflash`: flashing amber – the signals are off for the traffic, the rules of the road apply. */
export type SignalState = 'red' | 'redamber' | 'green' | 'amber' | 'amberflash' | 'off';

/** `display` codes of the .sig format */
const DISPLAY: Record<number, SignalState> = { 1: 'red', 2: 'redamber', 3: 'green', 4: 'amber' };

interface GroupProgram {
	/** switching commands within the cycle (ms), sorted by time */
	cmds: { at: number; state: SignalState }[];
	/** transition shown after a command before its state: state → duration (ms) */
	transitions: { state: SignalState; duration: number }[];
}

export interface SignalProgram {
	id: number;
	name: string;
	/** ms */
	cycleTime: number;
	offset: number;
	groups: Map<number, GroupProgram>;
}

export interface SigFile {
	/** signal controller number the file belongs to */
	sc: number;
	name: string;
	groupNames: Map<number, string>;
	programs: SignalProgram[];
}

export function parseSig(text: string): SigFile {
	const root = parseXml(text);
	if (root.tag !== 'sc') throw new Error(`Not a Vissim signal program file (root element <${root.tag}>)`);
	const programs: SignalProgram[] = list(root, 'progs').map((p) => {
		const groups = new Map<number, GroupProgram>();
		for (const g of list(p, 'sgs')) {
			groups.set(num(g, 'sg_id'), {
				cmds: kids(child(g, 'cmds'))
					.map((c) => ({ at: num(c, 'begin'), state: DISPLAY[num(c, 'display')] ?? 'off' }))
					.sort((a, b) => a.at - b.at),
				transitions: kids(child(g, 'fixedstates')).map((f) => ({ state: DISPLAY[num(f, 'display')] ?? 'off', duration: num(f, 'duration') }))
			});
		}
		return { id: num(p, 'id'), name: str(p, 'name'), cycleTime: Math.max(1, num(p, 'cycletime')), offset: num(p, 'offset'), groups };
	});
	return { sc: num(root, 'id'), name: str(root, 'name'), groupNames: new Map(list(root, 'sgs').map((g) => [num(g, 'id'), str(g, 'name')])), programs };
}

/**
 * State of one signal group at simulation time `t` (s).
 *
 * A command marks the end of the previous state: at "green" the red ends
 * (red/amber is shown for its fixed duration, then green), at "red" the green
 * ends (amber for its fixed duration, then red).
 */
export function groupState(program: SignalProgram, sg: number, t: number): SignalState {
	const g = program.groups.get(sg);
	if (!g || !g.cmds.length) return 'off';
	const cycle = program.cycleTime;
	const tc = ((((t * 1000 - program.offset) % cycle) + cycle) % cycle);
	// last command at or before tc, wrapping around the cycle
	let cmd = g.cmds[g.cmds.length - 1];
	let since = tc - cmd.at + cycle;
	for (const c of g.cmds) {
		if (c.at <= tc) {
			cmd = c;
			since = tc - c.at;
		}
	}
	const before: SignalState | null = cmd.state === 'green' ? 'redamber' : cmd.state === 'red' ? 'amber' : null;
	const transition = before ? g.transitions.find((x) => x.state === before) : undefined;
	return transition && since < transition.duration ? transition.state : cmd.state;
}
