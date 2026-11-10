import { Events, Listener } from '@sapphire/framework';
import { MessageFlags, type Interaction } from 'discord.js';
import { isStockNavigation, stickyStockManager } from '../lib/stickyStock';

export class StockPaginationListener extends Listener<typeof Events.InteractionCreate> {
	public constructor(context: Listener.LoaderContext, options: Listener.Options) {
		super(context, { ...options, event: Events.InteractionCreate });
	}

	public async run(interaction: Interaction) {
		if (!interaction.isButton()) return;
		if (!isStockNavigation(interaction.customId)) return;
		try {
			await stickyStockManager.handlePagination(interaction);
		} catch (error) {
			this.container.logger.error('[stock] Pagination failed', error);
			const reply = {
				content: 'Stock data is temporarily unavailable. Please try again shortly.',
				flags: MessageFlags.Ephemeral
			} as const;
			try {
				if (interaction.deferred || interaction.replied) await interaction.followUp(reply);
				else await interaction.reply(reply);
			} catch (replyError) {
				this.container.logger.warn('[stock] Could not report pagination failure', replyError);
			}
		}
	}
}
