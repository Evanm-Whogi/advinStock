import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, escapeMarkdown, type ButtonInteraction, type Client } from 'discord.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './persistence';
import type { PlanStockEntry } from './stockMonitor';
import { buildOrderUrl } from './orderUrl';

function formatPrice(p: PlanStockEntry): string {
	if (!p.price || p.price === '—') return '—';
	const cleaned = String(p.price).replace(/^\$/u, '').trim().slice(0, 32);
	return `$${cleaned}/mo`;
}

export function formatStockRow(p: PlanStockEntry): string {
	const name = `[${escapeMarkdown(p.planName.slice(0, 200))}](${buildOrderUrl(p.whmcsId)})`;
	return `**${name}** · ${formatPrice(p)}`;
}

export type StockSummaryPage = {
	categoryId: number | null;
	categoryName: string;
	embed: EmbedBuilder;
};

const CATEGORY_ORDER = ['KVM Standard VPS', 'KVM Premium VPS', 'KVM Extreme VPS', 'KVM 9950X VPS', 'KVM Storage VPS'];

function compareCategories(a: string, b: string): number {
	const rank = (name: string) => {
		const index = CATEGORY_ORDER.indexOf(name);
		return index < 0 ? CATEGORY_ORDER.length : index;
	};
	return rank(a) - rank(b) || a.localeCompare(b);
}

export function stockEmbedTextLength(embed: EmbedBuilder): number {
	const data = embed.data;
	return (data.author?.name?.length ?? 0) + (data.title?.length ?? 0) + (data.description?.length ?? 0) + (data.footer?.text.length ?? 0) +
		(data.fields ?? []).reduce((total, field) => total + field.name.length + field.value.length, 0);
}

/** Each category has its own view; large categories get additional pages. */
export function buildStockSummaryPages(map: Map<string, PlanStockEntry>): StockSummaryPage[] {
	const plans = [...map.values()];
	const inStock = plans.filter((p) => p.stock > 0);
	const groups = new Map<number, { name: string; description: string; subtext: string; plans: PlanStockEntry[] }>();
	for (const plan of plans) {
		if (!groups.has(plan.categoryId)) groups.set(plan.categoryId, {
			name: plan.categoryName, description: plan.categoryDescription ?? '', subtext: plan.categorySubtext ?? '', plans: []
		});
		if (plan.stock > 0) groups.get(plan.categoryId)!.plans.push(plan);
	}
	const pages: StockSummaryPage[] = [];
	for (const [categoryId, group] of [...groups.entries()].sort((a, b) => compareCategories(a[1].name, b[1].name))) {
		const categoryPages: EmbedBuilder[] = [];
		let embed = new EmbedBuilder();
		let characters = 0;
		let fieldCount = 0;
		let value = '';
		let fieldName = '';
		const addField = () => {
			if (!value) return;
			const size = fieldName.length + value.length;
			if (fieldCount && (fieldCount >= 25 || characters + size > 5400)) {
				categoryPages.push(embed);
				embed = new EmbedBuilder();
				characters = 0;
				fieldCount = 0;
			}
			embed.addFields({ name: fieldName, value });
			characters += size;
			fieldCount++;
			value = '';
		};
		group.plans.sort((a, b) => a.locationName.localeCompare(b.locationName) || a.planName.localeCompare(b.planName, undefined, { numeric: true }));
		for (const plan of group.plans) {
			const nextFieldName = plan.locationName.slice(0, 256) || 'Unknown location';
			if (fieldName !== nextFieldName) {
				addField();
				fieldName = nextFieldName;
			}
			const row = formatStockRow(plan);
			if (value && value.length + 1 + row.length > 1024) addField();
			value += (value ? '\n' : '') + row;
		}
		addField();
		categoryPages.push(embed);
		for (const [index, categoryPage] of categoryPages.entries()) {
			categoryPage.setTitle(group.name.slice(0, 256) || 'Unknown category')
				.setColor(group.plans.length > 0 ? 0x57f287 : 0xed4245)
				.setFooter({ text: `${group.plans.length} plans in this category · ${inStock.length} of ${plans.length} plans in stock${categoryPages.length > 1 ? ` · Page ${index + 1} of ${categoryPages.length}` : ''}` })
				.setTimestamp();
			const emptyMessage = group.plans.length ? '' : 'No plans are currently in stock in this category.';
			if (emptyMessage) categoryPage.setDescription(emptyMessage);
			const introduction = [group.description, group.subtext].filter(Boolean).join('\n\n');
			const description = [introduction, emptyMessage].filter(Boolean).join('\n\n');
			const baseLength = stockEmbedTextLength(categoryPage) - emptyMessage.length;
			if (description && description.length <= 4096 && baseLength + description.length <= 6000) {
				categoryPage.setDescription(description);
			}
			pages.push({ categoryId, categoryName: group.name, embed: categoryPage });
		}
	}
	if (!pages.length) pages.push({ categoryId: null, categoryName: 'Current Stock', embed: new EmbedBuilder()
		.setTitle('Current Stock').setColor(0xed4245).setDescription('No plans are currently in stock.').setTimestamp() });
	return pages;
}

export function buildStockPageButtons(page: number, pages: StockSummaryPage[]): ActionRowBuilder<ButtonBuilder>[] {
	const categories = [...new Map(pages.filter(p => p.categoryId !== null).map(p => [p.categoryId, p])).values()]
		.sort((a, b) => compareCategories(a.categoryName, b.categoryName));
	const rows: ActionRowBuilder<ButtonBuilder>[] = [];
	const categoryIndex = categories.findIndex(category => category.categoryId === pages[page].categoryId);
	const firstCategory = Math.floor(Math.max(0, categoryIndex) / 20) * 20;
	for (let i = firstCategory; i < Math.min(categories.length, firstCategory + 20); i += 5) {
		rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...categories.slice(i, i + 5).map(category =>
			new ButtonBuilder().setCustomId(`stock:category:${category.categoryId}`)
				.setLabel(category.categoryName.replace(/ VPS$/u, '').slice(0, 80) || 'Category')
				.setStyle(category.categoryId === pages[page].categoryId ? ButtonStyle.Primary : ButtonStyle.Secondary)
		)));
	}
	const previous = page > 0 && (categories.length > 20 || pages[page - 1].categoryId === pages[page].categoryId);
	const next = page + 1 < pages.length && (categories.length > 20 || pages[page + 1].categoryId === pages[page].categoryId);
	if (previous || next) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId('stock:previous').setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(!previous),
		new ButtonBuilder().setCustomId('stock:next').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(!next)
	));
	return rows;
}

type StickyState = {
	channelId: string;
	messageId: string;
};

async function readState(path: string, logger: Client['logger']): Promise<StickyState | null> {
	try {
		const raw = await readFile(path, 'utf8');
		const parsed = JSON.parse(raw) as Partial<StickyState>;
		if (parsed && typeof parsed.channelId === 'string' && typeof parsed.messageId === 'string') {
			return { channelId: parsed.channelId, messageId: parsed.messageId };
		}
		return null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('[sticky] Could not read state', error);
		return null;
	}
}

function isUnknownMessage(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 10008;
}

async function writeState(path: string, state: StickyState): Promise<void> {
	await writeJsonAtomic(path, state);
}

/**
 * Manages a single "sticky" stock-summary embed that lives at the bottom of the
 * alert channel. It can be edited in place (to refresh counts) or re-posted
 * (deleted + re-sent) so it drops back to the bottom below newer messages.
 */
export class StickyStockManager {
	private channel: string | null = null;
	private statePath = join(process.cwd(), 'data', 'sticky-stock.json');
	private messageId: string | null = null;
	private latest: Map<string, PlanStockEntry> | null = null;
	private hydrated = false;
	private pages: StockSummaryPage[] | null = null;
	private page = 0;
	private selectedCategoryId: number | null = null;

	private queue: Promise<void> = Promise.resolve();
	private restickTimer: ReturnType<typeof setTimeout> | null = null;

	public get channelId(): string | null {
		return this.channel;
	}

	public configure(options: { channelId: string; statePath?: string }): void {
		if (this.channel !== options.channelId || (options.statePath && options.statePath !== this.statePath)) {
			this.hydrated = false;
			this.messageId = null;
			this.page = 0;
			this.selectedCategoryId = null;
		}
		this.channel = options.channelId;
		if (options.statePath) this.statePath = options.statePath;
	}

	/** Store the newest stock snapshot used to render the sticky embed. */
	public setLatest(map: Map<string, PlanStockEntry>): void {
		this.latest = map;
		this.pages = null;
	}

	public getLatest(): Map<string, PlanStockEntry> | null {
		return this.latest;
	}

	private getPages(): StockSummaryPage[] {
		return this.pages ??= buildStockSummaryPages(this.latest ?? new Map());
	}

	public async stop(): Promise<void> {
		this.channel = null;
		if (this.restickTimer) clearTimeout(this.restickTimer);
		this.restickTimer = null;
		await this.queue;
	}

	private async hydrate(client: Client): Promise<void> {
		if (this.hydrated) return;
		this.hydrated = true;
		const state = await readState(this.statePath, client.logger);
		if (state && state.channelId === this.channel) {
			this.messageId = state.messageId;
		}
	}

	/** Serialize all Discord mutations so edits/reposts never race each other. */
	private run<T>(task: () => Promise<T>): Promise<T> {
		const result = this.queue.then(task, task);
		this.queue = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	}

	/**
	 * Refresh the sticky embed.
	 * @param restick when true, delete the existing message and re-send so it
	 *                drops to the bottom of the channel; otherwise edit in place.
	 */
	public async refresh(client: Client, restick = false): Promise<void> {
		if (!this.channel || !this.latest) return;
		if (restick && this.restickTimer) {
			clearTimeout(this.restickTimer);
			this.restickTimer = null;
		}
		await this.run(async () => {
			if (!this.channel || !this.latest) return;
			await this.hydrate(client);
			const channel = await client.channels.fetch(this.channel);
			if (!channel?.isSendable()) {
				client.logger.warn(`[sticky] Channel not found or not sendable: ${this.channel}`);
				return;
			}

			const pages = this.getPages();
			this.page = Math.min(this.page, pages.length - 1);
			if (pages[this.page].categoryId !== this.selectedCategoryId) {
				const selected = pages.findIndex(p => p.categoryId === this.selectedCategoryId);
				const defaultPage = pages.findIndex(p => p.categoryName === 'KVM Standard VPS');
				this.page = selected >= 0 ? selected : Math.max(0, defaultPage);
			}
			this.selectedCategoryId = pages[this.page].categoryId;
			const payload = { embeds: [pages[this.page].embed], components: buildStockPageButtons(this.page, pages) };

			if (!restick && this.messageId) {
				const existing = await channel.messages.fetch(this.messageId).catch(error => {
					if (!isUnknownMessage(error)) throw error;
					return null;
				});
				if (existing) {
					await existing.edit(payload);
					return;
				}
			}

			if (this.messageId) {
				await channel.messages.delete(this.messageId).catch(error => {
					if (!isUnknownMessage(error)) throw error;
				});
				this.messageId = null;
			}

			const sent = await channel.send(payload);
			this.messageId = sent.id;
			await writeState(this.statePath, { channelId: this.channel, messageId: sent.id }).catch((err) =>
				client.logger.warn('[sticky] Failed to persist sticky state', err)
			);
		});
	}

	/** Button handling stays available across restarts and sticky reposts. */
	public async handlePagination(interaction: ButtonInteraction): Promise<void> {
		if (!interaction.customId.startsWith('stock:category:') && !['stock:previous', 'stock:next'].includes(interaction.customId)) return;
		if (interaction.channelId !== this.channel || interaction.message.id !== this.messageId || !this.latest) {
			await interaction.reply({ content: 'This stock summary has moved. Use the latest summary in the channel.', flags: MessageFlags.Ephemeral });
			return;
		}
		await interaction.deferUpdate();
		await this.run(async () => {
			if (!this.latest || interaction.message.id !== this.messageId) return;
			const pages = this.getPages();
			if (interaction.customId.startsWith('stock:category:')) {
				const categoryId = Number(interaction.customId.slice('stock:category:'.length));
				const selected = pages.findIndex(p => p.categoryId === categoryId);
				if (selected < 0) return;
				this.page = selected;
			} else {
				const target = this.page + (interaction.customId === 'stock:next' ? 1 : -1);
				if (!pages[target]) return;
				this.page = target;
			}
			this.selectedCategoryId = pages[this.page].categoryId;
			await interaction.editReply({ embeds: [pages[this.page].embed], components: buildStockPageButtons(this.page, pages) });
		});
	}

	/** Debounced re-post to the bottom, used when other messages arrive. */
	public scheduleRestick(client: Client, delayMs = 1500): void {
		if (!this.channel || !this.latest) return;
		if (this.restickTimer) clearTimeout(this.restickTimer);
		this.restickTimer = setTimeout(() => {
			this.restickTimer = null;
			void this.refresh(client, true).catch(error => client.logger.error('[sticky] Refresh failed', error));
		}, delayMs);
	}
}

export const stickyStockManager = new StickyStockManager();
