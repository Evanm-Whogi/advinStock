import { EmbedBuilder } from 'discord.js';
import type { PlanStockEntry, StockChange } from './stockData';
import { buildOrderUrl } from './orderUrl';
import { formatPrice } from './stockFormatting';

function formatEmbedTitle(p: PlanStockEntry): string {
	return `${p.planName} · ${p.locationName} · ${p.categoryName} · ${formatPrice(p.price)}`;
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
	const hasIncrease = changes.some((c) => c.kind === 'stock' && c.after.stock > c.before.stock);
	const hasDecrease = changes.some((c) => c.kind === 'stock' && c.after.stock < c.before.stock);
	if (hasIncrease && !hasDecrease) return 0x57f287;
	if (hasDecrease && !hasIncrease) return 0xed4245;
	return 0x5865f2;
}

export function buildStockChangeEmbeds(changes: StockChange[]): EmbedBuilder[] {
	const color = embedColorForChanges(changes);
	return changes.map((change) => {
		const plan = planForChange(change);
		return new EmbedBuilder()
			.setColor(color)
			.setTitle(formatEmbedTitle(plan).slice(0, 256))
			.setDescription(changeToEmbedDescription(change).slice(0, 4096))
			.setURL(buildOrderUrl(plan.whmcsId))
			.setTimestamp();
	});
}
