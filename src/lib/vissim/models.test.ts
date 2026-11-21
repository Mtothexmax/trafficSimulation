import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { buildModels } from './models';

describe('generated 3D models', () => {
	const models = buildModels();

	it('builds every model with a plausible size', () => {
		const length = (name: string): number => +models.get(name)!.length.toFixed(1);
		expect([...models.keys()].sort()).toEqual(['bus', 'cyclist', 'estate', 'hatchback', 'motorcyclist', 'pedestrian', 'sedan', 'suv', 'tram', 'truck', 'van']);
		expect(length('sedan')).toBeCloseTo(4.6, 1);
		expect(length('truck')).toBeCloseTo(7.6, 1);
		expect(length('bus')).toBeCloseTo(12, 0);
		expect(length('tram')).toBeCloseTo(24, 0);
		expect(length('cyclist')).toBeGreaterThan(1.5);
		expect(length('motorcyclist')).toBeCloseTo(2, 0);
	});

	it('stands on the ground, centred, with white tint materials for the renderer to colour', () => {
		for (const [name, model] of models) {
			let minY = Infinity, minX = Infinity, maxX = -Infinity, triangles = 0;
			for (const part of model.parts) {
				const pos = part.geometry.getAttribute('position');
				triangles += pos.count / 3;
				for (let i = 0; i < pos.count; i++) {
					minY = Math.min(minY, pos.getY(i));
					minX = Math.min(minX, pos.getX(i));
					maxX = Math.max(maxX, pos.getX(i));
				}
			}
			expect(minY, name).toBeCloseTo(0, 5);
			expect(minX + maxX, name).toBeCloseTo(0, 5);
			expect(triangles, name).toBeGreaterThan(100);
			expect(triangles, name).toBeLessThan(2500);
			expect(model.parts.some((p) => p.material.name.startsWith('tint_')), name).toBe(true);
		}
	});

	it('turns every face outwards (boxes: normals point away from the centre)', () => {
		// the lorry's box body is the largest part of its `cargo` material: all its normals point away from its middle
		const cargo = models.get('truck')!.parts.find((p) => p.material.name === 'cargo')!.geometry;
		cargo.computeBoundingBox();
		const c = cargo.boundingBox!.getCenter(new Vector3());
		const pos = cargo.getAttribute('position');
		const normal = cargo.getAttribute('normal');
		for (let i = 0; i < pos.count; i += 3) {
			const mx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3 - c.x;
			const my = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3 - c.y;
			const mz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3 - c.z;
			expect(mx * normal.getX(i) + my * normal.getY(i) + mz * normal.getZ(i)).toBeGreaterThan(0);
		}
	});
});
