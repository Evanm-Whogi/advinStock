import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } from 'discord.js';
import type { PlanStockEntry, StockMap } from './stockData';
import { buildOrderUrl } from './orderUrl';
import { comparePlans, formatPrice } from './stockFormatting';

export function formatStockRow(p: PlanStockEntry): string {
	const name = `[${escapeMarkdown(p.planName.slice(0, 200))}](${buildOrderUrl(p.whmcsId)})`;
	return `**${name}** · ${formatPrice(p.price, 32)}`;
}

export type StockSummaryPage = {
	categoryId: number | null;
	categoryName: string;
	embed: EmbedBuilder;
};

const CATEGORY_ORDER = ['KVM Standard VPS', 'KVM Premium VPS', 'KVM Extreme VPS', 'KVM 9950X VPS', 'KVM Storage VPS'];

export function compareCategories(a: string, b: string): number {
	const rank = (name: string) => {
		const index = CATEGORY_ORDER.indexOf(name);
		return index < 0 ? CATEGORY_ORDER.length : index;
	};
	return rank(a) - rank(b) || a.localeCompare(b);
}

export function stockEmbedTextLength(embed: EmbedBuilder): number {
	const data = embed.data;
	return (
		(data.author?.name?.length ?? 0) +
		(data.title?.length ?? 0) +
		(data.description?.length ?? 0) +
		(data.footer?.text.length ?? 0) +
		(data.fields ?? []).reduce((total, field) => total + field.name.length + field.value.length, 0)
	);
}

/** Each category has its own view; large categories get additional pages. */
export function buildStockSummaryPages(map: StockMap): StockSummaryPage[] {
	const plans = [...map.values()];
	const inStock = plans.filter((p) => p.stock > 0);
	const groups = new Map<number, { name: string; description: string; subtext: string; plans: PlanStockEntry[] }>();
	for (const plan of plans) {
		if (!groups.has(plan.categoryId))
			groups.set(plan.categoryId, {
				name: plan.categoryName,
				description: plan.categoryDescription ?? '',
				subtext: plan.categorySubtext ?? '',
				plans: []
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
		group.plans.sort((a, b) => comparePlans(a, b));
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
			categoryPage
				.setTitle(group.name.slice(0, 256) || 'Unknown category')
				.setColor(group.plans.length > 0 ? 0x57f287 : 0xed4245)
				.setFooter({
					text: `${group.plans.length} plans in this category · ${inStock.length} of ${plans.length} plans in stock${categoryPages.length > 1 ? ` · Page ${index + 1} of ${categoryPages.length}` : ''}`
				})
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
	if (!pages.length)
		pages.push({
			categoryId: null,
			categoryName: 'Current Stock',
			embed: new EmbedBuilder()
				.setTitle('Current Stock')
				.setColor(0xed4245)
				.setDescription('No plans are currently in stock.')
				.setTimestamp()
		});
	return pages;
}

export function buildStockPageButtons(page: number, pages: StockSummaryPage[]): ActionRowBuilder<ButtonBuilder>[] {
	const categories = [
		...new Map(pages.filter((p) => p.categoryId !== null).map((p) => [p.categoryId, p])).values()
	].sort((a, b) => compareCategories(a.categoryName, b.categoryName));
	const rows: ActionRowBuilder<ButtonBuilder>[] = [];
	const categoryIndex = categories.findIndex((category) => category.categoryId === pages[page].categoryId);
	const firstCategory = Math.floor(Math.max(0, categoryIndex) / 20) * 20;
	for (let i = firstCategory; i < Math.min(categories.length, firstCategory + 20); i += 5) {
		rows.push(
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				...categories.slice(i, i + 5).map((category) =>
					new ButtonBuilder()
						.setCustomId(`stock:category:${category.categoryId}`)
						.setLabel(category.categoryName.replace(/ VPS$/u, '').slice(0, 80) || 'Category')
						.setStyle(category.categoryId === pages[page].categoryId ? ButtonStyle.Primary : ButtonStyle.Secondary)
				)
			)
		);
	}
	const previous = page > 0 && (categories.length > 20 || pages[page - 1].categoryId === pages[page].categoryId);
	const next = page + 1 < pages.length && (categories.length > 20 || pages[page + 1].categoryId === pages[page].categoryId);
	if (previous || next)
		rows.push(
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(stockPageId(Math.max(0, page - 1), pages))
					.setLabel('Previous')
					.setStyle(ButtonStyle.Secondary)
					.setDisabled(!previous),
				new ButtonBuilder()
					.setCustomId(stockPageId(Math.min(pages.length - 1, page + 1), pages))
					.setLabel('Next')
					.setStyle(ButtonStyle.Secondary)
					.setDisabled(!next)
			)
		);
	return rows;
}

/** A complete, non-interactive channel summary, split only at Discord's message limits. */
export function buildStockTrackerMessages(map: StockMap) {
	const groups = new Map<number, { name: string; plans: PlanStockEntry[] }>();
	let inStock = 0;
	for (const plan of map.values()) {
		if (plan.stock <= 0) continue;
		if (!groups.has(plan.categoryId)) groups.set(plan.categoryId, { name: plan.categoryName, plans: [] });
		groups.get(plan.categoryId)!.plans.push(plan);
		inStock++;
	}
	const descriptions: string[] = [];
	let description = '';
	const addCategory = (text: string) => {
		if (description && description.length + text.length + 2 > 4096) {
			descriptions.push(description);
			description = '';
		}
		description += (description ? '\n\n' : '') + text;
	};
	for (const group of [...groups.values()].sort((a, b) => compareCategories(a.name, b.name))) {
		const name = escapeMarkdown(group.name.slice(0, 240)).replace(/[\r\n]+/gu, ' ') || 'Other products';
		group.plans.sort((a, b) => comparePlans(a, b));
		let section = '';
		let previousLocation: string | null = null;
		for (const plan of group.plans) {
			const location = escapeMarkdown(plan.locationName.slice(0, 120)).replace(/[\r\n]+/gu, ' ') || 'Unknown location';
			const heading = `**${name} · ${location}**`;
			if (previousLocation !== plan.locationName) {
				if (section) addCategory(section);
				section = heading;
			}
			const row = formatStockRow(plan);
			if (section.length + row.length + 1 > 4096) {
				addCategory(section);
				section = `${heading} (continued)`;
			}
			section += `\n${row}`;
			previousLocation = plan.locationName;
		}
		if (section) addCategory(section);
	}
	if (description) descriptions.push(description);
	if (!descriptions.length) descriptions.push('No plans are currently in stock.');
	return descriptions.map((text, index) => ({
		content: '',
		embeds: [
			new EmbedBuilder()
				.setTitle(index ? 'Current Stock (continued)' : 'Current Stock')
				.setDescription(text)
				.setColor(inStock ? 0x57f287 : 0xed4245)
				.setFooter({ text: `${inStock} of ${map.size} plans in stock` })
				.setTimestamp()
		],
		components: []
	}));
}

export function buildStockLauncher() {
	return {
		content: 'Browse current stock privately.',
		embeds: [],
		components: [
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder().setCustomId('stock:open').setLabel('View stock').setStyle(ButtonStyle.Primary)
			)
		]
	};
}

export function buildStockView(map: StockMap) {
	return stockPageView(buildStockSummaryPages(map));
}

export function stockPageView(pages: StockSummaryPage[], page = defaultStockPage(pages)) {
	return { embeds: [EmbedBuilder.from(pages[page].embed.toJSON())], components: buildStockPageButtons(page, pages) };
}

/** Encode the destination in the button so each private message carries its own state. */
function stockPageId(page: number, pages: StockSummaryPage[]): string {
	const categoryId = pages[page].categoryId;
	const offset = pages.slice(0, page).filter((candidate) => candidate.categoryId === categoryId).length;
	return `stock:page:${categoryId}:${offset}`;
}

export function isStockNavigation(customId: string): boolean {
	return /^stock:(?:open|category:\d+|page:\d+:\d+|previous|next)$/u.test(customId);
}

export function defaultStockPage(pages: StockSummaryPage[]): number {
	return Math.max(
		0,
		pages.findIndex((page) => page.categoryName === 'KVM Standard VPS')
	);
}
