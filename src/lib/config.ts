import { dirname, join, resolve } from 'node:path';

export const DEFAULT_POLL_INTERVAL_MS = 300_000;
export const defaultSnapshotPath = (): string => join(process.cwd(), 'data', 'stock-snapshot.json');
export const stickyStatePath = (snapshotPath: string): string => join(dirname(snapshotPath), 'sticky-stock.json');

export type Config = Readonly<{
	token: string;
	url: string;
	channelId: string | undefined;
	intervalMs: number;
	snapshotPath: string;
}>;

export function readConfig(env: NodeJS.ProcessEnv = process.env, warn: (message: string) => void = console.warn): Config {
	const parsed = Number(env.STOCK_POLL_INTERVAL_MS);
	const validInterval = Number.isSafeInteger(parsed) && parsed >= 10_000 && parsed <= 2_147_483_647;
	if (env.STOCK_ALERT_CHANNEL_ID && env.STOCK_POLL_INTERVAL_MS && !validInterval) {
		warn('[stock] STOCK_POLL_INTERVAL_MS must be an integer from 10000 to 2147483647; using default 5 minutes.');
	}
	return Object.freeze({
		token: env.DISCORD_TOKEN?.trim() ?? '',
		url: env.STOCK_JSON_URL || 'https://console.advinservers.com/api/v1/public/stock',
		channelId: env.STOCK_ALERT_CHANNEL_ID || undefined,
		intervalMs: validInterval ? parsed : DEFAULT_POLL_INTERVAL_MS,
		snapshotPath: resolve(env.STOCK_SNAPSHOT_PATH || defaultSnapshotPath())
	});
}

let config: Config | undefined;
export function getConfig(): Config {
	return (config ??= readConfig());
}
