import { Events, Listener } from '@sapphire/framework';
import { startStockMonitor } from '../lib/stockMonitor';

export class ReadyStockMonitorListener extends Listener<typeof Events.ClientReady> {
	public constructor(context: Listener.LoaderContext, options: Listener.Options) {
		super(context, {
			...options,
			event: Events.ClientReady,
			once: true
		});
	}

	public run() {
		this.container.client.user?.setPresence({
			activities: [{ name: 'Watching Stock plateau at zero', type: 3 }],
			status: 'online'
		});

		const url = process.env.STOCK_JSON_URL || 'https://console.advinservers.com/api/v1/public/stock';
		const channelId = process.env.STOCK_ALERT_CHANNEL_ID;
		if (!channelId) {
			this.container.logger.warn(
				'[stock] Set STOCK_ALERT_CHANNEL_ID in .env to enable stock polling.'
			);
			return;
		}

		const intervalRaw = process.env.STOCK_POLL_INTERVAL_MS;
		let intervalMs = 5 * 60 * 1000; // Default to 5 minutes
		if (intervalRaw) {
			const parsed = Number(intervalRaw);
			if (Number.isFinite(parsed) && parsed >= 10_000) {
				intervalMs = parsed;
			} else {
				this.container.logger.warn(
					'[stock] STOCK_POLL_INTERVAL_MS invalid or < 10000; using default 5 minutes.'
				);
			}
		}

		const snapshotPath = process.env.STOCK_SNAPSHOT_PATH;

		startStockMonitor(this.container.client, {
			url,
			channelId,
			intervalMs,
			...(snapshotPath ? { snapshotPath } : {})
		});
		this.container.logger.info('[stock] Polling started.');
	}
}
