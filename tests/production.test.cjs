const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, readdir, rm, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
	extractPlanStockMap,
	parseSnapshotPayload,
	buildStockChangeEmbeds,
	startStockMonitor
} = require('../dist/lib/stockMonitor');
const {
	buildStockSummaryPages,
	buildStockPageButtons,
	stockEmbedTextLength,
	buildStockView,
	buildStockLauncher,
	buildStockTrackerMessages,
	StickyStockManager
} = require('../dist/lib/stickyStock');
const { writeJsonAtomic } = require('../dist/lib/persistence');

const logger = { info() {}, warn() {}, error() {} };
const api = (stock = 0) => ({
	groups: [
		{
			id: '5',
			name: 'KVM Extreme VPS',
			locations: [
				{
					id: 33,
					name: 'Kansas City',
					plans: [{ id: '61', name: 'KVM Extreme 1', stock, price: '8.00', billing_product_id: 425 }]
				}
			]
		}
	]
});
const plan = () => [...extractPlanStockMap(api()).values()][0];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
	const deadline = Date.now() + 2000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, 'condition timed out');
		await delay(5);
	}
}
async function directory(t) {
	const path = await mkdtemp(join(tmpdir(), 'advinstock-test-'));
	t.after(() => rm(path, { recursive: true, force: true }));
	return path;
}

test('reject malformed API data rather than publish false stock transitions', () => {
	for (const invalid of [null, '', ' ', false, -1, 1.5, Infinity]) {
		assert.throws(() => extractPlanStockMap(api(invalid)));
	}
	for (const id of [null, '', false, -1, 1.5]) {
		const data = api();
		data.groups[0].locations[0].plans[0].id = id;
		assert.throws(() => extractPlanStockMap(data));
	}
	const duplicate = api();
	duplicate.groups[0].locations[0].plans.push(duplicate.groups[0].locations[0].plans[0]);
	assert.throws(() => extractPlanStockMap(duplicate));
	assert.equal(extractPlanStockMap(api('3')).values().next().value.stock, 3);
});

test('reject the whole snapshot if entries are corrupt or duplicated', () => {
	const p = plan();
	assert.equal(parseSnapshotPayload({ plans: [p] }).size, 1);
	for (const plans of [[p, null], [p, p], [{ ...p, key: 'wrong' }], [{ ...p, stock: null }]]) {
		assert.equal(parseSnapshotPayload({ plans }), null);
	}
});

test('alerts preserve PID and AID and fit Discord text limits', () => {
	const p = { ...plan(), planName: 'a'.repeat(1000), deploymentTime: 'b'.repeat(10000) };
	const embed = buildStockChangeEmbeds([{ kind: 'new', plan: p }])[0];
	assert.equal(embed.data.url, 'https://console.advinservers.com/order?pid=425&aid=109');
	assert.ok(embed.data.title.length <= 256);
	assert.ok(embed.data.description.length <= 4096);
	embed.toJSON();
});

test('large summaries keep every plan and stay within embed and component limits', () => {
	const plans = new Map();
	for (let category = 1; category <= 26; category++) {
		for (let i = 0; i < 90; i++) {
			const key = `${category}:33:${i + 1}`;
			plans.set(key, {
				...plan(),
				key,
				planId: i + 1,
				stock: 1,
				categoryId: category,
				categoryName: 'C'.repeat(300) + category,
				locationName: 'L'.repeat(300),
				planName: `item-${i}-` + '[x]'.repeat(200),
				categoryDescription: 'D'.repeat(4000)
			});
		}
	}
	const pages = buildStockSummaryPages(plans);
	let rows = 0;
	for (const [index, { embed }] of pages.entries()) {
		assert.ok(stockEmbedTextLength(embed) <= 6000);
		assert.ok(embed.data.fields.length <= 25);
		for (const field of embed.data.fields) {
			assert.ok(field.value.length <= 1024);
			assert.ok(field.name.length <= 256);
			rows += field.value.split('\n').length;
		}
		embed.toJSON();
		const buttons = buildStockPageButtons(index, pages);
		assert.ok(buttons.length <= 5);
		for (const row of buttons) row.toJSON();
		if (index < pages.length - 1)
			assert.ok(
				buttons.some((row) => row.components.some((button) => button.data.label === 'Next' && !button.data.disabled))
			);
	}
	assert.equal(rows, plans.size);
});

test('atomic JSON replacement leaves complete data and no temporary files', async (t) => {
	const path = await directory(t);
	const file = join(path, 'state.json');
	await writeJsonAtomic(file, { version: 1 });
	await Promise.all(Array.from({ length: 10 }, (_, i) => writeJsonAtomic(file, { version: i })));
	assert.equal(typeof JSON.parse(await readFile(file, 'utf8')).version, 'number');
	assert.deepEqual(await readdir(path), ['state.json']);
});

test('sticky edit errors surface and do not silently replace the message', async (t) => {
	const path = await directory(t);
	const statePath = join(path, 'sticky.json');
	await writeJsonAtomic(statePath, { channelId: 'channel', messageId: 'message' });
	const manager = new StickyStockManager();
	manager.configure({ channelId: 'channel', statePath });
	manager.setLatest(extractPlanStockMap(api(1)));
	let sends = 0;
	const client = {
		logger,
		channels: {
			fetch: async () => ({
				isSendable: () => true,
				messages: {
					fetch: async () => ({
						edit: async () => {
							throw new Error('Forbidden');
						}
					})
				},
				send: async () => {
					sends++;
				}
			})
		}
	};
	await assert.rejects(manager.refresh(client), /Forbidden/);
	assert.equal(sends, 0);
	await manager.stop();
});

test('polls never overlap and stopping prevents subsequent polling', async (t) => {
	const path = await directory(t);
	let calls = 0;
	let release;
	const fetchStock = async () => {
		calls++;
		return new Promise((resolve) => {
			release = () => resolve(api());
		});
	};
	const stop = startStockMonitor(
		{ logger },
		{
			url: 'unused',
			channelId: 'channel',
			intervalMs: 5,
			snapshotPath: join(path, 'stock.json'),
			manager: new StickyStockManager(),
			fetchStock
		}
	);
	await until(() => calls === 1);
	await delay(30);
	assert.equal(calls, 1);
	const stopped = stop();
	release();
	await stopped;
	await delay(20);
	assert.equal(calls, 1);
});

test('failed alerts are retried before committing and unchanged polls skip disk writes', async (t) => {
	const path = await directory(t);
	const snapshotPath = join(path, 'stock.json');
	await writeJsonAtomic(snapshotPath, { plans: [...extractPlanStockMap(api()).values()] });
	const fetchStock = async () => api(1);
	let attempts = 0;
	let alerts = 0;
	const channel = {
		isSendable: () => true,
		messages: { fetch: async () => ({ edit: async () => {} }) },
		send: async (payload) => {
			if (payload.embeds[0]?.data.url) {
				attempts++;
				if (attempts === 1) {
					assert.equal(JSON.parse(await readFile(snapshotPath, 'utf8')).plans[0].stock, 0);
					throw new Error('temporary send failure');
				}
				alerts++;
			}
			return { id: 'sticky' };
		}
	};
	const stop = startStockMonitor(
		{ logger, channels: { fetch: async () => channel } },
		{ url: 'unused', channelId: 'channel', intervalMs: 10, snapshotPath, manager: new StickyStockManager(), fetchStock }
	);
	t.after(stop);
	await until(() => alerts === 1);
	await delay(30);
	assert.equal(JSON.parse(await readFile(snapshotPath, 'utf8')).plans[0].stock, 1);
	const mtime = (await stat(snapshotPath)).mtimeMs;
	await delay(40);
	assert.equal((await stat(snapshotPath)).mtimeMs, mtime);
	assert.equal(attempts, 2);
	await stop();
});

async function navigationFixture(t) {
	const path = await directory(t);
	const manager = new StickyStockManager();
	manager.configure({ channelId: 'channel', statePath: join(path, 'sticky.json') });
	const plans = new Map();
	for (const [categoryId, categoryName] of [
		[1, 'KVM Standard VPS'],
		[2, 'KVM Premium VPS']
	]) {
		for (let i = 1; i <= 60; i++) {
			const key = `${categoryId}:33:${i}`;
			plans.set(key, {
				...plan(),
				key,
				categoryId,
				categoryName,
				planId: i,
				stock: 1,
				planName: `item ${i} ` + 'x'.repeat(190)
			});
		}
	}
	manager.setLatest(plans);
	let publicPayload;
	let publicEdits = 0;
	let publicSends = 0;
	const client = {
		logger,
		channels: {
			fetch: async () => ({
				isSendable: () => true,
				messages: {
					fetch: async () => ({
						edit: async (payload) => {
							publicEdits++;
							publicPayload = payload;
						}
					}),
					delete: async () => {}
				},
				send: async (payload) => {
					publicPayload = payload;
					publicSends++;
					return { id: `shared-${publicSends}` };
				}
			})
		}
	};
	await manager.refresh(client);
	t.after(() => manager.stop());
	return {
		manager,
		client,
		plans,
		get publicPayload() {
			return publicPayload;
		},
		get publicEdits() {
			return publicEdits;
		}
	};
}

function navigationInteraction(userId, customId, payload, { privateView = false, messageId = 'shared-1' } = {}) {
	const calls = [];
	return {
		user: { id: userId },
		customId,
		channelId: 'channel',
		message: {
			id: messageId,
			flags: { has: () => privateView },
			embeds: payload.embeds.map((embed) => embed.toJSON())
		},
		calls,
		async deferReply(options) {
			calls.push(['deferReply', options]);
		},
		async deferUpdate() {
			calls.push(['deferUpdate']);
		},
		async reply(options) {
			calls.push(['reply', options]);
		},
		async editReply(options) {
			this.payload = options;
			calls.push(['editReply', options]);
		}
	};
}
function pageButton(payload, label) {
	return payload.components.flatMap((row) => row.components).find((button) => button.data.label === label).data
		.custom_id;
}

test('two users browse independent private categories and pages without editing the shared summary', async (t) => {
	const { MessageFlags } = require('discord.js');
	const fixture = await navigationFixture(t);
	const shared = fixture.publicPayload;
	const alice = navigationInteraction('alice', 'stock:category:2', shared);
	const bob = navigationInteraction('bob', 'stock:category:1', shared);
	await Promise.all([fixture.manager.handlePagination(alice), fixture.manager.handlePagination(bob)]);
	for (const interaction of [alice, bob]) {
		assert.deepEqual(interaction.calls[0], ['deferReply', { flags: MessageFlags.Ephemeral }]);
	}
	assert.equal(alice.payload.embeds[0].data.title, 'KVM Premium VPS');
	assert.equal(bob.payload.embeds[0].data.title, 'KVM Standard VPS');
	const aliceNext = navigationInteraction('alice', pageButton(alice.payload, 'Next'), alice.payload, {
		privateView: true,
		messageId: 'alice-view'
	});
	await fixture.manager.handlePagination(aliceNext);
	assert.deepEqual(aliceNext.calls[0], ['deferUpdate']);
	assert.match(aliceNext.payload.embeds[0].data.footer.text, /Page 2 of/);
	assert.equal(aliceNext.payload.embeds[0].data.title, 'KVM Premium VPS');
	assert.match(bob.payload.embeds[0].data.footer.text, /Page 1 of/);
	const bobNext = navigationInteraction('bob', pageButton(bob.payload, 'Next'), bob.payload, {
		privateView: true,
		messageId: 'bob-view'
	});
	await fixture.manager.handlePagination(bobNext);
	assert.equal(bobNext.payload.embeds[0].data.title, 'KVM Standard VPS');
	assert.match(bobNext.payload.embeds[0].data.footer.text, /Page 2 of/);
	const aliceBack = navigationInteraction('alice', pageButton(aliceNext.payload, 'Previous'), aliceNext.payload, {
		privateView: true,
		messageId: 'alice-view'
	});
	await fixture.manager.handlePagination(aliceBack);
	assert.match(aliceBack.payload.embeds[0].data.footer.text, /Page 1 of/);
	assert.equal(fixture.publicEdits, 0);
	assert.equal(shared.components.length, 0);
	assert.ok(shared.embeds[0].data.description);
});

test('private navigation survives shared-message reposts and shrinking categories', async (t) => {
	const fixture = await navigationFixture(t);
	const alice = navigationInteraction('alice', 'stock:category:2', fixture.publicPayload);
	await fixture.manager.handlePagination(alice);
	const nextId = pageButton(alice.payload, 'Next');
	await fixture.manager.refresh(fixture.client, true);
	fixture.manager.setLatest(new Map([...fixture.plans].filter(([, p]) => p.categoryId === 2 && p.planId === 1)));
	const next = navigationInteraction('alice', nextId, alice.payload, { privateView: true, messageId: 'alice-view' });
	await fixture.manager.handlePagination(next);
	assert.equal(next.payload.embeds[0].data.title, 'KVM Premium VPS');
	assert.equal(next.payload.embeds[0].data.fields.length, 1);
	const stale = navigationInteraction('bob', 'stock:category:1', fixture.publicPayload, { messageId: 'shared-1' });
	await fixture.manager.handlePagination(stale);
	assert.equal(stale.calls[0][0], 'reply');
	assert.match(stale.calls[0][1].content, /summary has moved/);
});

test('legacy shared next buttons open a private reply', async (t) => {
	const fixture = await navigationFixture(t);
	const next = navigationInteraction('alice', 'stock:next', buildStockView(fixture.plans));
	await fixture.manager.handlePagination(next);
	assert.equal(next.calls[0][0], 'deferReply');
	assert.match(next.payload.embeds[0].data.footer.text, /Page 2 of/);
	assert.equal(fixture.publicEdits, 0);
});

test('the command launcher opens one private table and its tabs update that same table', async (t) => {
	const { MessageFlags } = require('discord.js');
	const fixture = await navigationFixture(t);
	const launcher = buildStockLauncher();
	const open = navigationInteraction('alice', pageButton(launcher, 'View stock'), launcher);
	await fixture.manager.handlePagination(open);
	assert.deepEqual(open.calls[0], ['deferReply', { flags: MessageFlags.Ephemeral }]);
	assert.equal(open.payload.embeds.length, 1);
	assert.equal(open.payload.embeds[0].data.title, 'KVM Standard VPS');
	const tab = navigationInteraction('alice', 'stock:category:2', open.payload, {
		privateView: true,
		messageId: 'private-table'
	});
	await fixture.manager.handlePagination(tab);
	assert.deepEqual(tab.calls[0], ['deferUpdate']);
	assert.equal(tab.payload.embeds[0].data.title, 'KVM Premium VPS');
	assert.equal(fixture.publicEdits, 0);
});

test('/stock opens a private table directly and its tabs work outside the alert channel', async (t) => {
	const { StockCommand } = require('../dist/commands/stock');
	const { MessageFlags } = require('discord.js');
	const fixture = await navigationFixture(t);
	const calls = [];
	let payload;
	await StockCommand.prototype.chatInputRun.call(
		{ manager: fixture.manager, loadStockData: async () => fixture.plans },
		{
			async deferReply(options) {
				calls.push(options);
			},
			async editReply(options) {
				payload = options;
			}
		}
	);
	assert.deepEqual(calls, [{ flags: MessageFlags.Ephemeral }]);
	assert.equal(payload.embeds.length, 1);
	assert.equal(payload.embeds[0].data.title, 'KVM Standard VPS');
	const tab = navigationInteraction('alice', 'stock:category:2', payload, {
		privateView: true,
		messageId: 'slash-reply'
	});
	tab.channelId = 'another-channel';
	await fixture.manager.handlePagination(tab);
	assert.equal(tab.calls[0][0], 'deferUpdate');
	assert.equal(tab.payload.embeds[0].data.title, 'KVM Premium VPS');
});

test('tracker summary shows category and location headings with bold linked plans and prices', () => {
	const make = (overrides) => ({ ...plan(), stock: 1, ...overrides });
	const plans = new Map([
		['b', make({ categoryId: 2, categoryName: 'KVM Premium VPS', planName: 'KVM Premium 1' })],
		[
			'a10',
			make({
				categoryId: 1,
				categoryName: 'KVM Standard VPS',
				planName: 'KVM Standard 10',
				locationName: 'Los Angeles, CA'
			})
		],
		[
			'a1',
			make({
				categoryId: 1,
				categoryName: 'KVM Standard VPS',
				planName: 'KVM Standard 1',
				locationName: 'Los Angeles, CA',
				whmcsId: 243
			})
		],
		['empty', make({ categoryId: 3, categoryName: 'KVM Extreme VPS', stock: 0 })]
	]);
	const messages = buildStockTrackerMessages(plans);
	assert.equal(messages.length, 1);
	assert.deepEqual(messages[0].components, []);
	const embed = messages[0].embeds[0];
	assert.equal(embed.data.title, 'Current Stock');
	assert.match(embed.data.description, /^\*\*KVM Standard VPS · Los Angeles, CA\*\*/);
	assert.ok(embed.data.description.includes('**KVM Premium VPS · Kansas City**'));
	assert.ok(!embed.data.description.includes('KVM Extreme VPS'));
	assert.match(
		embed.data.description,
		/Los Angeles, CA\*\*\n\*\*\[KVM Standard 1\]\(https:\/\/console.advinservers.com\/order\?pid=243&aid=109\)\*\* · \$8.00\n\*\*\[KVM Standard 10\]/
	);
	assert.ok(!embed.data.description.includes('No plans currently in stock.'));
	embed.toJSON();
});

test('overflowing tracker summaries retain every row within Discord limits', () => {
	const plans = new Map();
	for (let i = 1; i <= 180; i++)
		plans.set(String(i), {
			...plan(),
			stock: 1,
			planName: `Product ${i} ` + 'x'.repeat(150),
			locationName: 'y'.repeat(120),
			categoryId: Math.ceil(i / 60),
			categoryName: `Category ${Math.ceil(i / 60)}`
		});
	const messages = buildStockTrackerMessages(plans);
	assert.ok(messages.length > 1);
	let count = 0;
	for (const message of messages) {
		assert.deepEqual(message.components, []);
		assert.equal(message.embeds.length, 1);
		const embed = message.embeds[0];
		assert.ok(stockEmbedTextLength(embed) <= 6000);
		assert.ok(embed.data.description.length <= 4096);
		count += embed.data.description.split('](https://console.advinservers.com/order?').length - 1;
		embed.toJSON();
	}
	assert.equal(count, plans.size);
	const empty = buildStockTrackerMessages(new Map());
	assert.equal(empty.length, 1);
	assert.match(empty[0].embeds[0].data.description, /No plans/);
});

test('tracker refresh replaces the old launcher and removes overflow messages after stock shrinks', async (t) => {
	const path = await directory(t);
	const statePath = join(path, 'sticky.json');
	await writeJsonAtomic(statePath, { channelId: 'channel', messageId: 'old-launcher' });
	const manager = new StickyStockManager();
	manager.configure({ channelId: 'channel', statePath });
	const large = new Map(
		Array.from({ length: 80 }, (_, i) => [
			String(i),
			{ ...plan(), stock: 1, planName: `Product ${i} ` + 'x'.repeat(150) }
		])
	);
	manager.setLatest(large);
	const messages = new Map([['old-launcher', buildStockLauncher()]]);
	let nextId = 0;
	const client = {
		logger,
		channels: {
			fetch: async () => ({
				isSendable: () => true,
				messages: {
					fetch: async ({ message: id }) => ({
						edit: async (payload) => {
							messages.set(id, payload);
						}
					}),
					delete: async (id) => {
						messages.delete(id);
					}
				},
				send: async (payload) => {
					const id = `extra-${++nextId}`;
					messages.set(id, payload);
					return { id };
				}
			})
		}
	};
	t.after(() => manager.stop());
	await manager.refresh(client);
	assert.ok(messages.size > 1);
	assert.deepEqual(messages.get('old-launcher').components, []);
	assert.ok(messages.get('old-launcher').embeds[0].data.description);
	assert.equal(JSON.parse(await readFile(statePath, 'utf8')).messageIds.length, messages.size);
	manager.setLatest(extractPlanStockMap(api(1)));
	await manager.refresh(client);
	assert.deepEqual([...messages.keys()], ['old-launcher']);
	assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')).messageIds, ['old-launcher']);
});

test('Extreme VPS stays under one heading beyond the old field limit and empty categories disappear', () => {
	const plans = new Map(
		Array.from({ length: 18 }, (_, index) => [
			String(index),
			{
				...plan(),
				stock: 1,
				categoryName: 'KVM Extreme VPS',
				planName: `KVM Extreme ${index + 1}`
			}
		])
	);
	plans.set('empty', { ...plan(), categoryId: 1, categoryName: 'KVM Standard VPS', stock: 0 });
	const messages = buildStockTrackerMessages(plans);
	assert.equal(messages.length, 1);
	const text = messages[0].embeds[0].data.description;
	assert.ok(text.length > 1024);
	assert.equal(text.match(/KVM Extreme VPS/gu).length, 1);
	assert.ok(!text.includes('continued'));
	assert.ok(!text.includes('KVM Standard VPS'));
	assert.equal(text.split('](https://console.advinservers.com/order?').length - 1, 18);
	const unavailable = buildStockTrackerMessages(new Map([['empty', { ...plan(), stock: 0 }]]));
	assert.equal(unavailable.length, 1);
	assert.equal(unavailable[0].embeds[0].data.description, 'No plans are currently in stock.');
});
