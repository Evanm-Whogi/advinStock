import type { Client } from 'discord.js';
import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from './persistence';

export type PlanStockEntry = Readonly<{
	key: string;
	categoryId: number;
	categoryName: string;
	categoryDescription?: string;
	categorySubtext?: string;
	locationId: number;
	locationName: string;
	planId: number;
	planName: string;
	stock: number;
	vcpuCores: number;
	memoryMb: number;
	diskGb: number;
	primaryDiskGb?: number;
	hddDiskGb?: number;
	bandwidthGb: number;
	deploymentTime: string;
	price: string;
	whmcsId: number;
	whmcsUrl: string;
}>;

export type StockChange =
	| { kind: 'stock'; before: PlanStockEntry; after: PlanStockEntry }
	| { kind: 'new'; plan: PlanStockEntry }
	| { kind: 'removed'; plan: PlanStockEntry };

export type StockMap = ReadonlyMap<string, PlanStockEntry>;

const PLAN_KEY = (categoryId: number, locationId: number, planId: number) => `${categoryId}:${locationId}:${planId}`;

function numField(obj: Record<string, unknown>, key: string): number {
	const v = obj[key];
	if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
	if (typeof v === 'string' && v.trim() !== '') {
		const n = Number(v);
		return Number.isFinite(n) ? n : 0;
	}
	return 0;
}

function strField(obj: Record<string, unknown>, key: string, fallback = ''): string {
	const v = obj[key];
	if (v === undefined || v === null) return fallback;
	return String(v);
}

function readSpecsFromPlanJson(plan: Record<string, unknown>) {
	return {
		vcpuCores: numField(plan, 'vcpu_cores'),
		memoryMb: numField(plan, 'memory'),
		diskGb: numField(plan, 'disk'),
		primaryDiskGb: numField(plan, 'primary_disk'),
		hddDiskGb: numField(plan, 'hdd_disk'),
		bandwidthGb: numField(plan, 'bandwidth'),
		deploymentTime: strField(plan, 'deployment_time', '—'),
		price: strField(plan, 'price', '—'),
		whmcsId: numField(plan, plan.billing_product_id != null ? 'billing_product_id' : 'whmcs_id'),
		whmcsUrl: strField(plan, plan.billing_url != null ? 'billing_url' : 'whmcs_url', '')
	};
}

export function extractPlanStockMap(data: unknown): StockMap {
	const map = new Map<string, PlanStockEntry>();
	const groups = Array.isArray(data) ? data : data && typeof data === 'object' ? (data as Record<string, unknown>).groups : undefined;

	if (!Array.isArray(groups)) {
		throw new Error('[stock] Unexpected API response: expected { groups: [...] }. Keeping the previous snapshot.');
	}

	for (const rawCat of groups) {
		if (!rawCat || typeof rawCat !== 'object') throw new Error('[stock] Invalid group in API response.');
		const cat = rawCat as Record<string, unknown>;
		const categoryId = Number(cat.id);
		const categoryName = String(cat.name ?? 'Unknown category');
		const locations = cat.locations;
		if (cat.id == null || !Number.isSafeInteger(categoryId) || categoryId <= 0 || !Array.isArray(locations)) throw new Error('[stock] Invalid group ID or locations in API response.');

		for (const rawLoc of locations) {
			if (!rawLoc || typeof rawLoc !== 'object') throw new Error('[stock] Invalid location in API response.');
			const loc = rawLoc as Record<string, unknown>;
			const locationId = Number(loc.id);
			const locationName = String(loc.display_name ?? loc.name ?? 'Unknown location');
			const plans = loc.plans;
			if (loc.id == null || !Number.isSafeInteger(locationId) || locationId <= 0 || !Array.isArray(plans)) throw new Error('[stock] Invalid location ID or plans in API response.');

			for (const rawPlan of plans) {
				if (!rawPlan || typeof rawPlan !== 'object') throw new Error('[stock] Invalid plan in API response.');
				const plan = rawPlan as Record<string, unknown>;
				const planId = Number(plan.id);
				const stockRaw = plan.stock;
				const stock = typeof stockRaw === 'number' ? stockRaw : Number(stockRaw);
				if (
					plan.id == null ||
					!Number.isSafeInteger(planId) ||
					planId <= 0 ||
					!['number', 'string'].includes(typeof stockRaw) ||
					String(stockRaw).trim() === '' ||
					!Number.isSafeInteger(stock) ||
					stock < 0
				) {
					throw new Error('[stock] Invalid plan ID or stock quantity in API response.');
				}
				const key = PLAN_KEY(categoryId, locationId, planId);
				if (map.has(key)) throw new Error(`[stock] Duplicate plan key: ${key}`);
				const specs = readSpecsFromPlanJson(plan);
				map.set(key, {
					key,
					categoryId,
					categoryName,
					categoryDescription: strField(cat, 'description'),
					categorySubtext: strField(cat, 'subtext'),
					locationId,
					locationName,
					planId,
					planName: String(plan.name ?? 'Unknown plan'),
					stock,
					...specs
				});
			}
		}
	}
	return map;
}

function isPlanStockEntry(x: unknown): x is PlanStockEntry {
	if (!x || typeof x !== 'object') return false;
	const o = x as Record<string, unknown>;
	return (
		typeof o.key === 'string' &&
		typeof o.categoryId === 'number' &&
		Number.isSafeInteger(o.categoryId) &&
		o.categoryId > 0 &&
		typeof o.categoryName === 'string' &&
		typeof o.locationId === 'number' &&
		Number.isSafeInteger(o.locationId) &&
		o.locationId > 0 &&
		typeof o.locationName === 'string' &&
		typeof o.planId === 'number' &&
		Number.isSafeInteger(o.planId) &&
		o.planId > 0 &&
		typeof o.planName === 'string' &&
		typeof o.stock === 'number' &&
		Number.isSafeInteger(o.stock) &&
		o.stock >= 0 &&
		o.key === PLAN_KEY(o.categoryId, o.locationId, o.planId)
	);
}

function planEntryFromRecord(o: Record<string, unknown>): PlanStockEntry {
	const categoryId = Number(o.categoryId);
	const locationId = Number(o.locationId);
	const planId = Number(o.planId);
	const stock = Number(o.stock);
	const key = typeof o.key === 'string' ? o.key : PLAN_KEY(categoryId, locationId, planId);
	return {
		key,
		categoryId,
		categoryName: String(o.categoryName),
		categoryDescription: strField(o, 'categoryDescription'),
		categorySubtext: strField(o, 'categorySubtext'),
		locationId,
		locationName: String(o.locationName),
		planId,
		planName: String(o.planName),
		stock,
		vcpuCores: numField(o, 'vcpuCores'),
		memoryMb: numField(o, 'memoryMb'),
		diskGb: numField(o, 'diskGb'),
		primaryDiskGb: numField(o, 'primaryDiskGb'),
		hddDiskGb: numField(o, 'hddDiskGb'),
		bandwidthGb: numField(o, 'bandwidthGb'),
		deploymentTime: typeof o.deploymentTime === 'string' ? o.deploymentTime : '—',
		price: typeof o.price === 'string' ? o.price : String(o.price ?? '—'),
		whmcsId: numField(o, 'whmcsId'),
		whmcsUrl: typeof o.whmcsUrl === 'string' ? o.whmcsUrl : ''
	};
}

export function parseSnapshotPayload(data: unknown): StockMap | null {
	if (!data || typeof data !== 'object') return null;
	const plans = (data as { plans?: unknown }).plans;
	if (!Array.isArray(plans)) return null;
	const map = new Map<string, PlanStockEntry>();
	for (const item of plans) {
		if (!isPlanStockEntry(item) || map.has(item.key)) return null;
		const entry = planEntryFromRecord(item as Record<string, unknown>);
		map.set(entry.key, entry);
	}
	return map;
}

export async function readSnapshotFromDisk(filePath: string, logger: Client['logger']): Promise<StockMap | null> {
	try {
		const raw = await readFile(filePath, 'utf8');
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			logger.warn(`[stock] Snapshot is not valid JSON (will rebaseline if needed): ${filePath}`);
			return null;
		}
		const map = parseSnapshotPayload(parsed);
		if (map === null) {
			logger.warn(`[stock] Snapshot has invalid shape (expected { plans: [...] }): ${filePath}`);
		}
		return map;
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		if (err.code === 'ENOENT') return null;
		logger.warn(`[stock] Could not read snapshot: ${filePath}`, e);
		return null;
	}
}

export async function writeSnapshotToDisk(filePath: string, map: StockMap): Promise<void> {
	const plans = [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
	const payload = {
		version: 2,
		savedAt: new Date().toISOString(),
		plans
	};
	await writeJsonAtomic(filePath, payload);
}

export function diffPlanStockMaps(previous: StockMap, next: StockMap): StockChange[] {
	const changes: StockChange[] = [];

	for (const [key, after] of next) {
		const before = previous.get(key);
		if (!before) {
			changes.push({ kind: 'new', plan: after });
			continue;
		}
		if (before.stock !== after.stock) {
			changes.push({ kind: 'stock', before, after });
		}
	}

	for (const [key, plan] of previous) {
		if (!next.has(key)) {
			changes.push({ kind: 'removed', plan });
		}
	}

	return changes;
}

/** Compare normalized entries by identity, independently of API iteration order. */
export function stockMapsEqual(previous: StockMap, next: StockMap): boolean {
	if (previous.size !== next.size) return false;
	for (const [key, entry] of previous) {
		const other = next.get(key);
		if (!other) return false;
		for (const field of Object.keys(entry) as (keyof PlanStockEntry)[]) {
			if (entry[field] !== other[field]) return false;
		}
		for (const field of Object.keys(other) as (keyof PlanStockEntry)[]) {
			if (entry[field] !== other[field]) return false;
		}
	}
	return true;
}
