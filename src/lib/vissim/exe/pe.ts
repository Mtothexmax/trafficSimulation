// Minimal reader for 32-bit Windows programs (PE): what is needed to load one
// into the emulator – sections, imports, and the COFF symbol table (the
// controller programs still carry theirs: function addresses by name).

export interface PeSection {
	name: string;
	/** address relative to the image base */
	rva: number;
	virtualSize: number;
	rawOffset: number;
	rawSize: number;
}

export interface PeImport {
	dll: string;
	name: string;
	/** address (absolute) of the import table slot the program calls through */
	slot: number;
}

export interface PeFile {
	imageBase: number;
	sizeOfImage: number;
	entry: number;
	sections: PeSection[];
	imports: PeImport[];
	/** symbol name → absolute address (first definition wins) */
	symbols: Map<string, number>;
	/** the image as it is laid out in memory (section data at their addresses) */
	image: Uint8Array;
}

const latin1 = (b: Uint8Array, from: number, to: number): string => {
	let s = '';
	for (let i = from; i < to && b[i] !== 0; i++) s += String.fromCharCode(b[i]);
	return s;
};

export function parsePe(bytes: Uint8Array): PeFile {
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.length < 0x100 || dv.getUint16(0, true) !== 0x5a4d) throw new Error('Keine Windows-Programmdatei (MZ-Kopf fehlt)');
	const pe = dv.getUint32(0x3c, true);
	if (pe + 0x100 > bytes.length || dv.getUint32(pe, true) !== 0x4550) throw new Error('Keine Windows-Programmdatei (PE-Kopf fehlt)');
	if (dv.getUint16(pe + 4, true) !== 0x14c) throw new Error('Nur 32-Bit-Programme (x86) werden unterstützt');
	const nSections = dv.getUint16(pe + 6, true);
	const symbolTable = dv.getUint32(pe + 12, true);
	const nSymbols = dv.getUint32(pe + 16, true);
	const optSize = dv.getUint16(pe + 20, true);
	const opt = pe + 24;
	if (dv.getUint16(opt, true) !== 0x10b) throw new Error('Nur 32-Bit-Programme (PE32) werden unterstützt');
	const entryRva = dv.getUint32(opt + 16, true);
	const imageBase = dv.getUint32(opt + 28, true);
	const sizeOfImage = dv.getUint32(opt + 56, true);
	const importRva = dv.getUint32(opt + 96 + 8, true);

	const sections: PeSection[] = [];
	const table = opt + optSize;
	for (let i = 0; i < nSections; i++) {
		const o = table + i * 40;
		sections.push({ name: latin1(bytes, o, o + 8), virtualSize: dv.getUint32(o + 8, true), rva: dv.getUint32(o + 12, true), rawSize: dv.getUint32(o + 16, true), rawOffset: dv.getUint32(o + 20, true) });
	}

	const image = new Uint8Array(sizeOfImage);
	image.set(bytes.subarray(0, Math.min(bytes.length, sections.length ? sections[0].rawOffset || 0x400 : 0x400)));
	for (const s of sections) {
		if (!s.rawSize || !s.rawOffset) continue;
		const n = Math.min(s.rawSize, s.virtualSize || s.rawSize, sizeOfImage - s.rva, bytes.length - s.rawOffset);
		if (n > 0) image.set(bytes.subarray(s.rawOffset, s.rawOffset + n), s.rva);
	}
	const iv = new DataView(image.buffer);

	const imports: PeImport[] = [];
	if (importRva) {
		for (let d = importRva; d + 20 <= sizeOfImage; d += 20) {
			const lookup = iv.getUint32(d, true);
			const nameRva = iv.getUint32(d + 12, true);
			const firstThunk = iv.getUint32(d + 16, true);
			if (!nameRva && !firstThunk) break;
			const dll = latin1(image, nameRva, nameRva + 256);
			for (let i = 0; ; i++) {
				const entry = iv.getUint32((lookup || firstThunk) + i * 4, true);
				if (!entry) break;
				const name = entry & 0x80000000 ? `#${entry & 0xffff}` : latin1(image, entry + 2, entry + 2 + 256);
				imports.push({ dll, name, slot: imageBase + firstThunk + i * 4 });
			}
		}
	}

	const symbols = new Map<string, number>();
	if (symbolTable && nSymbols && symbolTable + nSymbols * 18 <= bytes.length) {
		const strings = symbolTable + nSymbols * 18;
		for (let i = 0; i < nSymbols; i++) {
			const o = symbolTable + i * 18;
			let name: string;
			if (dv.getUint32(o, true) === 0) {
				const at = strings + dv.getUint32(o + 4, true);
				name = latin1(bytes, at, Math.min(bytes.length, at + 512));
			} else name = latin1(bytes, o, o + 8);
			const value = dv.getUint32(o + 8, true);
			const section = dv.getInt16(o + 12, true);
			const aux = bytes[o + 17];
			if (section > 0 && section <= sections.length && !symbols.has(name)) symbols.set(name, imageBase + sections[section - 1].rva + value);
			i += aux;
		}
	}

	return { imageBase, sizeOfImage, entry: imageBase + entryRva, sections, imports, symbols, image };
}
