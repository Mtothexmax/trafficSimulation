// Procedural asphalt textures (colour, normal map, paint laid over the asphalt).
// Same generator as in trafficBuilder's topology preview.
import * as THREE from 'three';

/** Edge length (m) one tile of the asphalt textures covers, and its resolution (≈ 4 mm per pixel). */
export const ASPHALT_TILE_M = 2.5;
/** How strongly the asphalt grain shows through the paint (1 = as on the bare
 * asphalt): white markings look worn, the red cycle surface stays calm. */
export const MARKING_GRAIN = 6.5;
const ASPHALT_SIZE = 1024;

export interface AsphaltSet {
	/** colour map */
	map: THREE.CanvasTexture;
	/** tangent-space normal map of the grain */
	normal: THREE.CanvasTexture;
	/** Road paint of a colour laid over the asphalt with the "overlay" blend
	 * mode: the grain of the surface shows through the paint. */
	paint(color: string, grain: number): THREE.CanvasTexture;
}

/** Procedural asphalt: a seamless height field (fine aggregate grain on top of
 * some larger unevenness) from which the colour map and a normal map are
 * derived. Deterministic, so the road looks the same on every load. */
export function asphaltTextures(base: string, size = ASPHALT_SIZE): AsphaltSet {
	let seed = 20240607;
	const rnd = (): number => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return (seed >>> 8) / 16777216;
	};
	const at = (x: number, y: number): number => ((y + size) % size) * size + ((x + size) % size);
	/** seamless value noise with `cells` cells across the tile */
	const valueNoise = (cells: number): Float32Array => {
		const grid = new Float32Array(cells * cells);
		for (let i = 0; i < grid.length; i++) grid[i] = rnd();
		const out = new Float32Array(size * size);
		const step = cells / size;
		for (let y = 0; y < size; y++) {
			const fy = y * step;
			const y0 = Math.floor(fy);
			const ty = fy - y0;
			const sy = ty * ty * (3 - 2 * ty);
			for (let x = 0; x < size; x++) {
				const fx = x * step;
				const x0 = Math.floor(fx);
				const tx = fx - x0;
				const sx = tx * tx * (3 - 2 * tx);
				const a = grid[(y0 % cells) * cells + (x0 % cells)];
				const b = grid[(y0 % cells) * cells + ((x0 + 1) % cells)];
				const c = grid[((y0 + 1) % cells) * cells + (x0 % cells)];
				const d = grid[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
				out[y * size + x] = a + (b - a) * sx + (c - a + (a - b + d - c) * sx) * sy;
			}
		}
		return out;
	};
	// aggregate: white noise, softened once so single stones are 2–3 px (≈ 1 cm)
	const white = new Float32Array(size * size);
	for (let i = 0; i < white.length; i++) white[i] = rnd();
	const grain = new Float32Array(size * size);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			grain[y * size + x] = (white[at(x, y)] * 4 + white[at(x - 1, y)] + white[at(x + 1, y)] + white[at(x, y - 1)] + white[at(x, y + 1)]) / 8;
		}
	}
	const pebbles = valueNoise(256); // 4 px ≈ 1.5 cm
	const lumps = valueNoise(48); // ≈ 8 cm
	const height = new Float32Array(size * size);
	for (let i = 0; i < height.length; i++) height[i] = 0.7 * grain[i] + 0.2 * pebbles[i] + 0.1 * lumps[i];

	const colour = new Uint8ClampedArray(size * size * 4);
	const hex = parseInt(base.slice(1), 16);
	const rgb = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
	for (let i = 0; i < height.length; i++) {
		let k = (height[i] - 0.5) * 30;
		// single light stones and dark pits
		if (white[i] > 0.988) k += 6;
		else if (white[i] < 0.012) k -= 5;
		colour[i * 4] = rgb[0] + k;
		colour[i * 4 + 1] = rgb[1] + k;
		colour[i * 4 + 2] = rgb[2] + k * 1.03;
		colour[i * 4 + 3] = 255;
	}
	const normal = new Uint8ClampedArray(size * size * 4);
	const strength = 5;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const dx = (height[at(x + 1, y)] - height[at(x - 1, y)]) * strength;
			const dy = (height[at(x, y + 1)] - height[at(x, y - 1)]) * strength;
			const len = Math.hypot(dx, dy, 1);
			const i = (y * size + x) * 4;
			normal[i] = (-dx / len) * 127.5 + 127.5;
			normal[i + 1] = (-dy / len) * 127.5 + 127.5;
			normal[i + 2] = (1 / len) * 127.5 + 127.5;
			normal[i + 3] = 255;
		}
	}
	const texture = (data: Uint8ClampedArray, srgb: boolean): THREE.CanvasTexture => {
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = size;
		canvas.getContext('2d')!.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, size, size), 0, 0);
		const tex = new THREE.CanvasTexture(canvas);
		tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
		if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
		tex.anisotropy = 8;
		tex.repeat.set(1 / ASPHALT_TILE_M, 1 / ASPHALT_TILE_M);
		return tex;
	};
	return {
		map: texture(colour, true),
		normal: texture(normal, false),
		paint(color: string, grain: number): THREE.CanvasTexture {
			const h = parseInt(color.slice(1), 16);
			const top = [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
			const out = new Uint8ClampedArray(colour.length);
			for (let i = 0; i < colour.length; i += 4) {
				for (let c = 0; c < 3; c++) {
					// `grain`: how strongly the asphalt grain shows through the paint (1 = as on the bare asphalt)
					const a = Math.min(1, Math.max(0, 0.56 + ((colour[i + c] - rgb[c]) / 255) * grain));
					// overlay blend: multiply in the dark half, screen in the light half
					out[i + c] = (a < 0.5 ? 2 * a * top[c] : 1 - 2 * (1 - a) * (1 - top[c])) * 255;
				}
				out[i + 3] = 255;
			}
			return texture(out, true);
		}
	};
}

