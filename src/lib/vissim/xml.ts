// Minimal XML reader for Vissim files (.inpx, .sig): elements and attributes
// only – these files carry no text content we need. Dependency-free so the
// same code runs in the app and in tests.

export interface XmlNode {
	tag: string;
	attrs: Record<string, string>;
	children: XmlNode[];
}

const TOKEN = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' };

function decode(s: string): string {
	if (!s.includes('&')) return s;
	return s.replace(/&#x([0-9a-fA-F]+);|&#(\d+);|&(?:lt|gt|quot|apos|amp);/g, (m, hex, dec) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(+dec) : ENTITIES[m]));
}

/** Parses an XML document and returns its root element. Throws on malformed nesting. */
export function parseXml(text: string): XmlNode {
	const holder: XmlNode = { tag: '#document', attrs: {}, children: [] };
	const stack: XmlNode[] = [holder];
	TOKEN.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = TOKEN.exec(text))) {
		if (m[1]) {
			const open = stack.pop();
			if (!open || open.tag !== m[1] || !stack.length) throw new Error(`XML: unexpected </${m[1]}>`);
		} else if (m[2]) {
			const node: XmlNode = { tag: m[2], attrs: {}, children: [] };
			if (m[3]) {
				ATTR.lastIndex = 0;
				let a: RegExpExecArray | null;
				while ((a = ATTR.exec(m[3]))) node.attrs[a[1]] = decode(a[2] ?? a[3] ?? '');
			}
			stack[stack.length - 1].children.push(node);
			if (!m[4]) stack.push(node);
		}
	}
	if (stack.length !== 1) throw new Error(`XML: <${stack[stack.length - 1].tag}> is not closed`);
	if (holder.children.length !== 1) throw new Error('XML: expected exactly one root element');
	return holder.children[0];
}

export const child = (n: XmlNode | undefined, tag: string): XmlNode | undefined => n?.children.find((c) => c.tag === tag);
export const kids = (n: XmlNode | undefined, tag?: string): XmlNode[] => (n ? (tag ? n.children.filter((c) => c.tag === tag) : n.children) : []);
/** Children of a list element: `list(root, 'links')` → the `<link>` nodes. */
export const list = (n: XmlNode | undefined, tag: string): XmlNode[] => kids(child(n, tag));
export function num(n: XmlNode | undefined, attr: string, fallback = 0): number {
	const v = n?.attrs[attr];
	if (v === undefined || v === '') return fallback;
	const x = Number(v);
	return Number.isFinite(x) ? x : fallback;
}
export const str = (n: XmlNode | undefined, attr: string, fallback = ''): string => n?.attrs[attr] ?? fallback;
export const bool = (n: XmlNode | undefined, attr: string, fallback = false): boolean => (n?.attrs[attr] === undefined ? fallback : n.attrs[attr] === 'true');
/** `<x><intObjectRef key="1"/>…</x>` → [1, …] */
export const refs = (n: XmlNode | undefined): number[] => kids(n, 'intObjectRef').map((r) => num(r, 'key'));
