import { Events, Listener } from '@sapphire/framework';
import type { Interaction } from 'discord.js';
import { stickyStockManager } from '../lib/stickyStock';

export class StockPaginationListener extends Listener<typeof Events.InteractionCreate> {
	public constructor(context: Listener.LoaderContext, options: Listener.Options) {
		super(context, { ...options, event: Events.InteractionCreate });
	}

	public async run(interaction: Interaction) {
		if (!interaction.isButton()) return;
		if (!interaction.customId.startsWith('stock:category:') && !['stock:previous', 'stock:next'].includes(interaction.customId)) return;
		try {
			await stickyStockManager.handlePagination(interaction);
		} catch (error) {
			this.container.logger.error('[stock] Pagination failed', error);
		}
	}
}
