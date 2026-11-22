// What can be read from a controller's supply file (.vsg) without running the
// program: which signal programs it holds and what they are called.
//
// The file is text: named data blocks, each between BOT and EOT, with the
// content as lines "Data=<hex>". Every signal program slot has its own block;
// a slot that was never filled has no name and carries the "empty" mark.

export interface SupplyProgram {
	no: number;
	name: string;
}

const BLOCK = /\/\/\s*AL_sSignalplan\s+Instanz:\s*(\d+)\s*\r?\nBOT([\s\S]*?)EOT/g;
/** where a block's fill mark and its name lie */
const MARK_AT = 6;
const MARK_EMPTY = 0x31;
const NAME_AT = 26;
const NAME_MAX = 30;

/** The signal programs a supply file defines, by number. Empty for a file of another kind. */
export function readSignalPrograms(text: string): SupplyProgram[] {
	const out: SupplyProgram[] = [];
	for (const m of text.matchAll(BLOCK)) {
		const hex = [...m[2].matchAll(/^Data=([0-9A-Fa-f]+)/gm)].map((d) => d[1]).join('');
		const bytes: number[] = [];
		for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
		if (bytes.length <= NAME_AT) continue;
		let name = '';
		for (let i = NAME_AT; i < Math.min(bytes.length, NAME_AT + NAME_MAX) && bytes[i] >= 32; i++) name += String.fromCharCode(bytes[i]);
		name = name.trim();
		if (!name && bytes[MARK_AT] === MARK_EMPTY) continue;
		out.push({ no: +m[1], name });
	}
	return out.sort((a, b) => a.no - b.no);
}

/** The same from the bytes of an uploaded file (the files are Latin-1 text). */
export function readSignalProgramsOf(data: ArrayBuffer): SupplyProgram[] {
	return readSignalPrograms(new TextDecoder('latin1').decode(data));
}
