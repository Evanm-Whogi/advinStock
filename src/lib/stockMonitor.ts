import axios from 'axios';
import type { Client } from 'discord.js';

import { stickyStockManager, type StickyStockManager } from './stickyStock';
import {diffPlanStockMaps, extractPlanStockMap, readSnapshotFromDisk, stockMapsEqual, writeSnapshotToDisk, type StockChange, type StockMap} from './stockData';
import { buildStockChangeEmbeds } from './stockAlerts';
import { DEFAULT_POLL_INTERVAL_MS, defaultSnapshotPath, stickyStatePath } from './config';

// Preserve existing imports while consumers migrate to the focused modules.
export * from './stockData';
export { buildStockChangeEmbeds, formatPlanStorage } from './stockAlerts';

function isRestockChange(change: StockChange): change is Extract<StockChange, { kind: 'stock' }> {
	return change.kind === 'stock' && change.before.stock <= 0 && change.after.stock > 0;
}

export type StockMonitorOptions = {
	url: string;
	channelId: string;
	intervalMs?: number;
	/** Where the last snapshot is stored (default: `<cwd>/data/stock-snapshot.json`). */
	snapshotPath?: string;
	manager?: StickyStockManager;
	fetchStock?: (url: string, signal: AbortSignal) => Promise<unknown>;
};

/**
 * Polls a JSON URL on an interval, persists the last snapshot to disk, and alerts when an existing plan transitions from zero stock to available.
 */
export function startStockMonitor(client: Client, options: StockMonitorOptions): () => Promise<void> {
	const {
		url,
		channelId,
		intervalMs = DEFAULT_POLL_INTERVAL_MS,
		snapshotPath = defaultSnapshotPath(),
		manager = stickyStockManager,
		fetchStock = fetchStockJson
	} = options;
	let previous: StockMap | null = null;
	let hydratedFromDisk = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;
	let activeTick: Promise<void>;
	const controller = new AbortController();

	manager.configure({ channelId, statePath: stickyStatePath(snapshotPath) });

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

			const data = await fetchStock(url, controller.signal);
			if (stopped) return;
			const next = extractPlanStockMap(data);
			manager.setLatest(next);

			if (previous === null) {
				await writeSnapshotToDisk(snapshotPath, next);
				previous = next;
				client.logger.info(`[stock] Baseline saved (${next.size} plans) → ${snapshotPath}`);
				// Make sure the sticky summary exists (edit in place if it already does).
				await manager.refresh(client);
				return;
			}

			const changes = diffPlanStockMaps(previous, next);
			const changed = !stockMapsEqual(previous, next);
			const restockChanges = changes.filter(isRestockChange);

			if (restockChanges.length === 0) {
				if (changed) await writeSnapshotToDisk(snapshotPath, next);
				previous = next;
				// No restock alerts to post, just keep the sticky counts current.
				await manager.refresh(client);
				return;
			}

			const channel = await client.channels.fetch(channelId);
			if (!channel?.isSendable()) {
				client.logger.warn(`[stock] Alert channel not found or not sendable: ${channelId}`);
				return;
			}

			const embeds = buildStockChangeEmbeds(restockChanges);
			for (const embed of embeds) {
				if (stopped) return;
				await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
			}
			// Commit only after delivery so failed alerts are retried on the next poll.
			await writeSnapshotToDisk(snapshotPath, next);
			previous = next;

			// Re-post the sticky summary so it sits at the bottom, below the alerts.
			await manager.refresh(client, true);
		} catch (err) {
			if (!stopped) client.logger.error('[stock] Poll failed', err);
		}
	};

	const poll = async () => {
		await tick();
		if (!stopped) timer = setTimeout(() => { activeTick = poll() }, intervalMs);
	};
	activeTick = poll();

	return async () => {
		stopped = true;
		controller.abort();
		if (timer) clearTimeout(timer);
		await activeTick;
		await manager.stop();
	};
}

async function fetchStockJson(url: string, signal: AbortSignal): Promise<unknown> {
	const { data } = await axios.get<unknown>(url, {
		timeout: 45_000,
		signal,
		maxContentLength: 5 * 1024 * 1024,
		headers: { Accept: 'application/json' },
		validateStatus: (status) => status === 200
	});
	return data;
}
