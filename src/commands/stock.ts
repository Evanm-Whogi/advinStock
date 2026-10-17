import { Command } from '@sapphire/framework';
import { EmbedBuilder, MessageFlags, type ChatInputCommandInteraction, type Message } from 'discord.js';
import { join } from 'node:path';
import { readSnapshotFromDisk, type PlanStockEntry } from '../lib/stockMonitor';
import { buildStockSummaryPages, stockEmbedTextLength, stickyStockManager } from '../lib/stickyStock';

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
		return readSnapshotFromDisk(path, this.container.logger);
	}

	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand((builder) =>
			builder.setName('stock').setDescription('View current in-stock items')
		);
	}

	private async sendStock(messageLike: Message | ChatInputCommandInteraction) {
		const interaction = 'deferReply' in messageLike ? messageLike : null;
		if (interaction) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		const plans = await this.loadStockData();
		if (!plans || ![...plans.values()].some(plan => plan.stock > 0)) {
			const payload = { content: plans ? 'No items currently in stock.' : 'Stock data is temporarily unavailable. Please try again shortly.' };
			if (interaction) await interaction.editReply(payload);
			else await messageLike.reply(payload);
			return;
		}

		const embeds = buildStockSummaryPages(plans)
			.filter(page => (page.embed.data.fields?.length ?? 0) > 0)
			.map(page => page.embed);

		const batches: EmbedBuilder[][] = [];
		let batch: EmbedBuilder[] = [];
		let characters = 0;
		for (const embed of embeds) {
			const size = stockEmbedTextLength(embed);
			if (batch.length > 0 && (batch.length >= 10 || characters + size > 6000)) {
				batches.push(batch);
				batch = [];
				characters = 0;
			}
			batch.push(embed);
			characters += size;
		}
		if (batch.length > 0) batches.push(batch);

		if (interaction) await interaction.editReply({ embeds: batches[0] });
		else await messageLike.reply({ embeds: batches[0] });
		for (const remaining of batches.slice(1)) {
			if ('followUp' in messageLike) {
				await messageLike.followUp({ embeds: remaining, flags: MessageFlags.Ephemeral });
			} else {
				await messageLike.reply({ embeds: remaining });
			}
		}
	}

	public async messageRun(message: Message) {
		await this.sendStock(message);
	}

	public async chatInputRun(interaction: ChatInputCommandInteraction) {
		await this.sendStock(interaction);
	}
}
