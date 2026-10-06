import axios from 'axios';
import { EmbedBuilder, type Client } from 'discord.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stickyStockManager } from './stickyStock';

export type PlanStockEntry = {
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
};

export type StockChange =
	| { kind: 'stock'; before: PlanStockEntry; after: PlanStockEntry }
	| { kind: 'new'; plan: PlanStockEntry }
	| { kind: 'removed'; plan: PlanStockEntry };

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

export function extractPlanStockMap(data: unknown): Map<string, PlanStockEntry> {
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
		if (!Number.isFinite(categoryId) || !Array.isArray(locations)) throw new Error('[stock] Invalid group ID or locations in API response.');

		for (const rawLoc of locations) {
			if (!rawLoc || typeof rawLoc !== 'object') throw new Error('[stock] Invalid location in API response.');
			const loc = rawLoc as Record<string, unknown>;
			const locationId = Number(loc.id);
			const locationName = String(loc.display_name ?? loc.name ?? 'Unknown location');
			const plans = loc.plans;
			if (!Number.isFinite(locationId) || !Array.isArray(plans)) throw new Error('[stock] Invalid location ID or plans in API response.');

			for (const rawPlan of plans) {
				if (!rawPlan || typeof rawPlan !== 'object') throw new Error('[stock] Invalid plan in API response.');
				const plan = rawPlan as Record<string, unknown>;
				const planId = Number(plan.id);
				const stockRaw = plan.stock;
				const stock = typeof stockRaw === 'number' ? stockRaw : Number(stockRaw);
				if (!Number.isFinite(planId) || stockRaw == null || !Number.isFinite(stock) || stock < 0) {
					throw new Error('[stock] Invalid plan ID or stock quantity in API response.');
				}
				const key = PLAN_KEY(categoryId, locationId, planId);
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
					stock: Number.isFinite(stock) ? stock : 0,
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
		Number.isFinite(Number(o.categoryId)) &&
		typeof o.categoryName === 'string' &&
		Number.isFinite(Number(o.locationId)) &&
		typeof o.locationName === 'string' &&
		Number.isFinite(Number(o.planId)) &&
		typeof o.planName === 'string' &&
		Number.isFinite(Number(o.stock))
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
		vcpuCores: Number.isFinite(Number(o.vcpuCores)) ? Number(o.vcpuCores) : 0,
		memoryMb: Number.isFinite(Number(o.memoryMb)) ? Number(o.memoryMb) : 0,
		diskGb: Number.isFinite(Number(o.diskGb)) ? Number(o.diskGb) : 0,
		primaryDiskGb: numField(o, 'primaryDiskGb'),
		hddDiskGb: numField(o, 'hddDiskGb'),
		bandwidthGb: Number.isFinite(Number(o.bandwidthGb)) ? Number(o.bandwidthGb) : 0,
		deploymentTime: typeof o.deploymentTime === 'string' ? o.deploymentTime : '—',
		price: typeof o.price === 'string' ? o.price : String(o.price ?? '—'),
		whmcsId: Number.isFinite(Number(o.whmcsId)) ? Number(o.whmcsId) : 0,
		whmcsUrl: typeof o.whmcsUrl === 'string' ? o.whmcsUrl : ''
	};
}

function parseSnapshotPayload(data: unknown): Map<string, PlanStockEntry> | null {
	if (!data || typeof data !== 'object') return null;
	const plans = (data as { plans?: unknown }).plans;
	if (!Array.isArray(plans)) return null;
	const map = new Map<string, PlanStockEntry>();
	for (const item of plans) {
		if (!isPlanStockEntry(item)) continue;
		const entry = planEntryFromRecord(item as Record<string, unknown>);
		map.set(entry.key, entry);
	}
	return map;
}

async function readSnapshotFromDisk(filePath: string, logger: Client['logger']): Promise<Map<string, PlanStockEntry> | null> {
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

async function writeSnapshotToDisk(filePath: string, map: Map<string, PlanStockEntry>): Promise<void> {
	const plans = [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
	const payload = {
		version: 2,
		savedAt: new Date().toISOString(),
		plans
	};
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export function diffPlanStockMaps(previous: Map<string, PlanStockEntry>, next: Map<string, PlanStockEntry>): StockChange[] {
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

function isRestockChange(change: StockChange): change is Extract<StockChange, { kind: 'stock' }> {
	return change.kind === 'stock' && change.before.stock <= 0 && change.after.stock > 0;
}

function formatPriceForTitle(p: PlanStockEntry): string {
	if (!p.price || p.price === '—') return '—';
	const cleaned = String(p.price).replace(/^\$/u, '').trim();
	return `$${cleaned}/mo`;
}

function formatEmbedTitle(p: PlanStockEntry): string {
	return `${p.planName} · ${p.locationName} · ${p.categoryName} · ${formatPriceForTitle(p)}`;
}

export function formatPlanStorage(p: PlanStockEntry): string {
	if ((p.hddDiskGb ?? 0) > 0) {
		const primary = (p.primaryDiskGb ?? 0) > 0 ? `${p.primaryDiskGb}GB NVMe SSD + ` : '';
		return `${primary}${p.hddDiskGb}GB HDD`;
	}
	return p.diskGb > 0 ? `${p.diskGb}GB NVMe SSD` : '—';
}

function formatEmbedDescriptionBody(p: PlanStockEntry): string {
	const vcpu = p.vcpuCores > 0 ? String(p.vcpuCores) : '—';
	const ram = p.memoryMb > 0 ? `${Math.trunc(p.memoryMb / 1000)}GB` : '—';
	const disk = formatPlanStorage(p);
	const bw = p.bandwidthGb > 0 ? `${Math.trunc(p.bandwidthGb / 1000)}TB` : '—';
	const deploy = p.deploymentTime && p.deploymentTime !== '—' ? p.deploymentTime : '—';
	const specs = [
		`Total vCPU: ${vcpu}`,
		`Memory: ${ram}`,
		`Storage: ${disk}`,
		`Bandwidth: ${bw}`,
		`Deployment Time: ${deploy}`
	].join('\n');
	return `\`\`\`\n${specs}\n\`\`\``;
}

function planForChange(c: StockChange): PlanStockEntry {
	return c.kind === 'stock' ? c.after : c.plan;
}

function changeToEmbedDescription(c: StockChange): string {
	const plan = planForChange(c);
	const specs = formatEmbedDescriptionBody(plan);
	switch (c.kind) {
		case 'stock':
			return `**Stock:** ${c.after.stock > 0 ? 'In Stock' : 'Out of Stock'}\n${specs}`;
		case 'new':
			return `**NEW PRODUCT:** ${c.plan.stock > 0 ? 'In Stock' : 'Out of Stock'}\n${specs}`;
		case 'removed':
			return `**Last known stock:** ${c.plan.stock > 0 ? 'In Stock' : 'Out of Stock'}\n${specs}`;
	}
}

function embedColorForChanges(changes: StockChange[]): number {
	const hasIncrease = changes.some(
		(c) => c.kind === 'stock' && c.after.stock > c.before.stock
	);
	const hasDecrease = changes.some(
		(c) => c.kind === 'stock' && c.after.stock < c.before.stock
	);
	if (hasIncrease && !hasDecrease) return 0x57f287;
	if (hasDecrease && !hasIncrease) return 0xed4245;
	return 0x5865f2;
}

const DESC_LIMIT = 3900;

function chunkDescriptions(lines: string[]): string[] {
	const chunks: string[] = [];
	let current = '';
	for (const line of lines) {
		const addition = (current ? '\n\n' : '') + line;
		if (current.length + addition.length > DESC_LIMIT) {
			if (current) chunks.push(current);
			current = line.length > DESC_LIMIT ? line.slice(0, DESC_LIMIT) : line;
			continue;
		}
		current += addition;
	}
	if (current) chunks.push(current);
	return chunks;
}

export function buildStockChangeEmbeds(changes: StockChange[]): EmbedBuilder[] {
	if (changes.length === 0) return [];
	const color = embedColorForChanges(changes);
	const embeds: EmbedBuilder[] = [];
	for (const c of changes) {
		const plan = planForChange(c);
		const title = formatEmbedTitle(plan);
		const descChunks = chunkDescriptions([changeToEmbedDescription(c)]);
		for (let i = 0; i < descChunks.length; i++) {
			const productUrl = 'https://console.advinservers.com/order';
			const embed = new EmbedBuilder()
				.setColor(color)
				.setTitle(i === 0 ? title : `${title} (continued)`)
				.setDescription(descChunks[i])
				.setTimestamp();
			if (productUrl) embed.setURL(productUrl);
			embeds.push(embed);
		}
	}
	return embeds;
}

export type StockMonitorOptions = {
	url: string;
	channelId: string;
	intervalMs?: number;
	/** Where the last snapshot is stored (default: `<cwd>/data/stock-snapshot.json`). */
	snapshotPath?: string;
};

/**
 * Polls a JSON URL on an interval, persists the last snapshot to disk, and posts embeds when stock (or plan set) changes.
 */
export function startStockMonitor(client: Client, options: StockMonitorOptions): () => void {
	const { url, channelId, intervalMs = 5 * 60 * 1000, snapshotPath = join(process.cwd(), 'data', 'stock-snapshot.json') } =
		options;
	let previous: Map<string, PlanStockEntry> | null = null;
	let hydratedFromDisk = false;
	let timer: ReturnType<typeof setInterval> | null = null;

	stickyStockManager.configure({ channelId });

	const tick = async () => {
		try {
			if (!hydratedFromDisk) {
				hydratedFromDisk = true;
				const fromDisk = await readSnapshotFromDisk(snapshotPath, client.logger);
				if (fromDisk) {
					previous = fromDisk;
					client.logger.info(`[stock] Loaded snapshot from disk (${fromDisk.size} plans): ${snapshotPath}`);
				}
			}

			const { data } = await axios.get<unknown>(url, {
				timeout: 45_000,
				headers: { Accept: 'application/json' },
				validateStatus: (s) => s === 200
			});
			const next = extractPlanStockMap(data);
			stickyStockManager.setLatest(next);

			if (previous === null) {
				previous = next;
				await writeSnapshotToDisk(snapshotPath, next);
				client.logger.info(
					`[stock] Baseline saved (${next.size} plans) → ${snapshotPath}`
				);
				// Make sure the sticky summary exists (edit in place if it already does).
				await stickyStockManager.refresh(client);
				return;
			}

			const changes = diffPlanStockMaps(previous, next);
			previous = next;
			await writeSnapshotToDisk(snapshotPath, next);
			const restockChanges = changes.filter(isRestockChange);

			if (restockChanges.length === 0) {
				// No restock alerts to post, just keep the sticky counts current.
				await stickyStockManager.refresh(client);
				return;
			}

			const channel = await client.channels.fetch(channelId).catch(() => null);
			if (!channel?.isSendable()) {
				client.logger.warn(`[stock] Alert channel not found or not sendable: ${channelId}`);
				return;
			}

			const embeds = buildStockChangeEmbeds(restockChanges);
			for (const embed of embeds) {
				await channel.send({ embeds: [embed] });
			}

			// Re-post the sticky summary so it sits at the bottom, below the alerts.
			await stickyStockManager.refresh(client, true);
		} catch (err) {
			client.logger.error('[stock] Poll failed', err);
		}
	};

	void tick();
	timer = setInterval(() => void tick(), intervalMs);

	return () => {
		if (timer) clearInterval(timer);
		timer = null;
		previous = null;
		hydratedFromDisk = false;
	};
}
