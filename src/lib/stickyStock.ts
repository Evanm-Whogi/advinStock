import { EmbedBuilder, MessageFlags, type ButtonInteraction, type Client } from 'discord.js';
import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from './persistence';
import { stockMapsEqual, type StockMap } from './stockData';
import {buildStockSummaryPages, buildStockTrackerMessages, defaultStockPage, isStockNavigation, stockPageView, type StockSummaryPage} from './stockView';
import { stickyStatePath, defaultSnapshotPath } from './config';

export * from './stockView';

type StickyState = {
	channelId: string;
	messageId: string;
	messageIds?: string[];
};

async function readState(path: string, logger: Client['logger']): Promise<StickyState | null> {
	try {
		const raw = await readFile(path, 'utf8');
		const parsed = JSON.parse(raw) as Partial<StickyState>;
		if (parsed && typeof parsed.channelId === 'string' && typeof parsed.messageId === 'string') {
			return {
				channelId: parsed.channelId,
				messageId: parsed.messageId,
				messageIds:
					Array.isArray(parsed.messageIds) && parsed.messageIds.every((id) => typeof id === 'string')
						? parsed.messageIds
						: [parsed.messageId]
			};
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

/**
 * Keeps the full category summary below alerts. Tabbed tables are private replies.
 */
export class StickyStockManager {
	private channel: string | null = null;
	private statePath = stickyStatePath(defaultSnapshotPath());
	private messageIds: string[] = [];
	private latest: StockMap | null = null;
	private hydrated = false;
	private pages: StockSummaryPage[] | null = null;
	private tracker: { payload: ReturnType<typeof buildStockTrackerMessages>[number]; signature: string }[] | null = null;
	private readonly delivered = new Map<string, string>();

	private queue: Promise<void> = Promise.resolve();
	private restickTimer: ReturnType<typeof setTimeout> | null = null;

	public get channelId(): string | null {
		return this.channel;
	}

	public configure(options: { channelId: string; statePath?: string }): void {
		if (this.channel !== options.channelId || (options.statePath && options.statePath !== this.statePath)) {
			this.hydrated = false;
			this.messageIds = [];
			this.delivered.clear();
		}
		this.channel = options.channelId;
		if (options.statePath) this.statePath = options.statePath;
	}

	/** Store the newest stock snapshot used to render the sticky embed. */
	public setLatest(map: StockMap): void {
		if (this.latest && stockMapsEqual(this.latest, map)) return;
		// Own the snapshot so callers cannot invalidate caches by mutating their input.
		this.latest = new Map([...map].map(([key, entry]) => [key, Object.freeze({ ...entry })]));
		this.pages = null;
		this.tracker = null;
	}

	public getLatest(): StockMap | null {
		return this.latest ? new Map(this.latest) : null;
	}

	private getPages(): StockSummaryPage[] {
		return (this.pages ??= buildStockSummaryPages(this.latest ?? new Map()));
	}

	public buildView() {
		return stockPageView(this.getPages());
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
			this.messageIds = state.messageIds ?? [state.messageId];
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

			const channelId = this.channel;
			const persist = async () => {
				await writeJsonAtomic(this.statePath, {
					channelId,
					messageId: this.messageIds[0] ?? '',
					messageIds: this.messageIds
				}).catch((error) => client.logger.warn('[sticky] Failed to persist sticky state', error));
			};
			const remove = async (id: string) => {
				await channel.messages.delete(id).catch((error) => {
					if (!isUnknownMessage(error)) throw error;
				});
				this.delivered.delete(id);
				this.messageIds = this.messageIds.filter((messageId) => messageId !== id);
				await persist();
			};
			if (restick) for (const id of [...this.messageIds]) await remove(id);

			const payloads = (this.tracker ??= buildStockTrackerMessages(this.latest).map((payload) => ({
				payload,
				signature: JSON.stringify({
					...payload,
					embeds: payload.embeds.map((embed) => ({ ...embed.toJSON(), timestamp: undefined }))
				})
			})));
			for (const [index, { payload, signature }] of payloads.entries()) {
				const id = this.messageIds[index];
				const existing = id ? await channel.messages.fetch({ message: id, force: true }).catch((error) => {
						if (!isUnknownMessage(error)) throw error;
						return null;
					})
					: null;
				const outgoing = () => ({
					...payload,
					embeds: payload.embeds.map((embed) => EmbedBuilder.from(embed.toJSON()))
				});
				if (existing) {
					if (this.delivered.get(id) !== signature) {
						await existing.edit(outgoing());
						this.delivered.set(id, signature);
					}
				} else {
					const sent = await channel.send(outgoing());
					if (id) this.delivered.delete(id);
					this.delivered.set(sent.id, signature);
					this.messageIds[index] = sent.id;
					await persist();
				}
			}
			for (const id of this.messageIds.slice(payloads.length)) await remove(id);
		});
	}

	/** Public buttons open a private view; its buttons update only that private message. */
	public async handlePagination(interaction: ButtonInteraction): Promise<void> {
		if (!isStockNavigation(interaction.customId)) return;
		const privateView = interaction.message.flags.has(MessageFlags.Ephemeral);
		const launcher = interaction.customId === 'stock:open';
		if (!this.latest ||(!privateView && !launcher && (interaction.channelId !== this.channel || !this.messageIds.includes(interaction.message.id)))) {
			await interaction.reply({
				content: 'This stock summary has moved. Use the latest summary in the channel.',
				flags: MessageFlags.Ephemeral
			});
			return;
		}

		if (privateView) await interaction.deferUpdate();
		else await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const pages = this.getPages();
		let page = defaultStockPage(pages);
		const target = /^stock:(category|page):(\d+)(?::(\d+))?$/u.exec(interaction.customId);
		if (target) {
			const categoryId = Number(target[2]);
			const offset = Number(target[3] ?? 0);
			const categoryPages = pages
				.map((candidate, index) => ({ candidate, index }))
				.filter(({ candidate }) => candidate.categoryId === categoryId);
			if (categoryPages.length) page = categoryPages[Math.min(offset, categoryPages.length - 1)].index;
		} else if (!launcher) {
			// Older shared messages may still have relative previous/next buttons until refreshed.
			const source = interaction.message.embeds[0];
			const categoryPage = pages.findIndex((candidate) => candidate.embed.data.title === source?.title);
			const offset = Number(/ · Page (\d+) of /u.exec(source?.footer?.text ?? '')?.[1] ?? 1) - 1;
			const current = categoryPage < 0 ? page : categoryPage + offset;
			page = Math.max(0, Math.min(pages.length - 1, current + (interaction.customId === 'stock:next' ? 1 : -1)));
		}
		await interaction.editReply(stockPageView(pages, page));
	}

	/** Debounced re-post to the bottom, used when other messages arrive. */
	public scheduleRestick(client: Client, delayMs = 1500): void {
		if (!this.channel || !this.latest) return;
		if (this.restickTimer) clearTimeout(this.restickTimer);
		this.restickTimer = setTimeout(() => {
			this.restickTimer = null;
			void this.refresh(client, true).catch((error) => client.logger.error('[sticky] Refresh failed', error));
		}, delayMs);
	}
}

export const stickyStockManager = new StickyStockManager();
