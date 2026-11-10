import type { PlanStockEntry } from './stockData';

export function formatPrice(price: string, limit?: number): string {
	if (!price || price === '—') return '—';
	const cleaned = price.replace(/^\$/u, '').trim();
	return `$${limit === undefined ? cleaned : cleaned.slice(0, limit)}`;
}

export function comparePlans(a: PlanStockEntry, b: PlanStockEntry): number {
	return (
		a.locationName.localeCompare(b.locationName) || a.planName.localeCompare(b.planName, undefined, { numeric: true })
	);
}
