import { Command } from '@sapphire/framework';
import { MessageFlags, type ChatInputCommandInteraction, type Message } from 'discord.js';
import { join } from 'node:path';
import { readSnapshotFromDisk, type PlanStockEntry } from '../lib/stockMonitor';
import { buildStockLauncher, buildStockView, stickyStockManager } from '../lib/stickyStock';

export class StockCommand extends Command {
	public constructor(context: Command.LoaderContext, options: Command.Options) {
		super(context, {
			...options,
			name: 'stock',
			aliases: ['inventory'],
			description: 'View current in-stock items.'
		});
	}

	private async loadStockData(): Promise<Map<string, PlanStockEntry> | null> {
		const latest = stickyStockManager.getLatest();
		if (latest) return latest;
		const path = process.env.STOCK_SNAPSHOT_PATH || join(process.cwd(), 'data', 'stock-snapshot.json');
		const plans = await readSnapshotFromDisk(path, this.container.logger);
		if (plans) stickyStockManager.setLatest(plans);
		return plans;
	}

	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand((builder) =>
			builder.setName('stock').setDescription('View current in-stock items')
		);
	}

	public async messageRun(message: Message) {
		const plans = await this.loadStockData();
		await message.reply(plans ? buildStockLauncher() : {
			content: 'Stock data is temporarily unavailable. Please try again shortly.'
		});
	}

	public async chatInputRun(interaction: ChatInputCommandInteraction) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		const plans = await this.loadStockData();
		await interaction.editReply(plans ? buildStockView(plans) : {
			content: 'Stock data is temporarily unavailable. Please try again shortly.'
		});
	}
}
