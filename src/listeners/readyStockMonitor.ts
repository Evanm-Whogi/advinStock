import { Events, Listener } from '@sapphire/framework';
import { startStockMonitor } from '../lib/stockMonitor';
import { getConfig } from '../lib/config';
import { onShutdown } from '../lib/lifecycle';

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

		const { url, channelId, intervalMs, snapshotPath } = getConfig();
		if (!channelId) {
			this.container.logger.warn('[stock] Set STOCK_ALERT_CHANNEL_ID in .env to enable stock polling.');
			return;
		}

		const stop = startStockMonitor(this.container.client, {
			url,
			channelId,
			intervalMs,
			snapshotPath
		});
		onShutdown(stop);
		this.container.logger.info(`[stock] Polling started; interval ${intervalMs}ms.`);
	}
}
