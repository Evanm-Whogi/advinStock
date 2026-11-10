import { Command } from '@sapphire/framework';
import { MessageFlags, type ChatInputCommandInteraction, type Message } from 'discord.js';
import { getConfig } from '../lib/config';
import { readSnapshotFromDisk, type StockMap } from '../lib/stockData';
import { buildStockLauncher, stickyStockManager } from '../lib/stickyStock';

export class StockCommand extends Command {
	private readonly manager = stickyStockManager;
	public constructor(context: Command.LoaderContext, options: Command.Options) {
		super(context, {
			...options,
			name: 'stock',
			aliases: ['inventory'],
			description: 'View current in-stock items.'
		});
	}

	private async loadStockData(): Promise<StockMap | null> {
		const latest = this.manager.getLatest();
		if (latest) return latest;
		const path = getConfig().snapshotPath;
		const plans = await readSnapshotFromDisk(path, this.container.logger);
		if (plans) this.manager.setLatest(plans);
		return plans;
	}

	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand((builder) =>
			builder.setName('stock').setDescription('View current in-stock items')
		);
	}

	public async messageRun(message: Message) {
		const plans = await this.loadStockData();
		await message.reply(
			plans ? buildStockLauncher() : {content: 'Stock data is temporarily unavailable. Please try again shortly.'}
		);
	}

	public async chatInputRun(interaction: ChatInputCommandInteraction) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		const plans = await this.loadStockData();
		await interaction.editReply(
			plans ? this.manager.buildView() : { content: 'Stock data is temporarily unavailable. Please try again shortly.'}
		);
	}
}
