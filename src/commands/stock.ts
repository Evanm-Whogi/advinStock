import { Command } from '@sapphire/framework';
import type { ChatInputCommandInteraction, Message } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlanStockEntry } from '../lib/stockMonitor';
import { buildStockSummaryPages, stockEmbedTextLength } from '../lib/stickyStock';

type Plan = PlanStockEntry;

export class StockCommand extends Command {
	public constructor(context: Command.LoaderContext, options: Command.Options) {
		super(context, {
			...options,
			name: 'stock',
			aliases: ['inventory'],
			description: 'View current in-stock items.'
		});
	}

	private async loadStockData(): Promise<Plan[]> {
		try {
			const dataPath = process.env.STOCK_SNAPSHOT_PATH || join(process.cwd(), 'data', 'stock-snapshot.json');
			const fileContent = await readFile(dataPath, 'utf-8');
			const data = JSON.parse(fileContent);
			return Array.isArray(data.plans) ? data.plans : [];
		} catch (error) {
			console.error('Error loading stock data:', error);
			return [];
		}
	}

	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand((builder) =>
			builder.setName('stock').setDescription('View current in-stock items')
		);
	}

	private async sendStock(messageLike: Message | ChatInputCommandInteraction) {
		const plans = await this.loadStockData();
		const inStockPlans = plans.filter((plan) => plan.stock > 0);

		if (inStockPlans.length === 0) {
			const payload = { content: 'No items currently in stock.', ephemeral: true };
			await messageLike.reply(payload);
			return;
		}

		const embeds = buildStockSummaryPages(new Map(plans.map(plan => [plan.key, plan])))
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

		await messageLike.reply({ embeds: batches[0], ephemeral: true });
		for (const remaining of batches.slice(1)) {
			if ('followUp' in messageLike) {
				await messageLike.followUp({ embeds: remaining, ephemeral: true });
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
