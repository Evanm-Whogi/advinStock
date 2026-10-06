import { Events, Listener } from '@sapphire/framework';
import type { Message } from 'discord.js';
import { stickyStockManager } from '../lib/stickyStock';

export class StickyStockMessageListener extends Listener<typeof Events.MessageCreate> {
	public constructor(context: Listener.LoaderContext, options: Listener.Options) {
		super(context, {
			...options,
			event: Events.MessageCreate
		});
	}

	public run(message: Message) {
		const channelId = stickyStockManager.channelId;
		if (!channelId || message.channelId !== channelId) return;

		// Ignore our own messages (including the sticky itself and stock alerts)
		// so we never trigger an infinite re-stick loop.
		if (message.author.id === this.container.client.user?.id) return;

		stickyStockManager.scheduleRestick(this.container.client);
	}
}
