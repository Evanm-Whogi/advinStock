const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, readdir, rm, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const axios = require('axios');
const { extractPlanStockMap, parseSnapshotPayload, buildStockChangeEmbeds, startStockMonitor } = require('../dist/lib/stockMonitor');
const { buildStockSummaryPages, buildStockPageButtons, stockEmbedTextLength, StickyStockManager } = require('../dist/lib/stickyStock');
const { writeJsonAtomic } = require('../dist/lib/persistence');

const logger = { info() {}, warn() {}, error() {} };
const api = (stock = 0) => ({ groups: [{ id: '5', name: 'KVM Extreme VPS', locations: [{ id: 33, name: 'Kansas City', plans: [{ id: '61', name: 'KVM Extreme 1', stock, price: '8.00', billing_product_id: 425 }] }] }] });
const plan = () => [...extractPlanStockMap(api()).values()][0];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
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
			plans.set(key, { ...plan(), key, planId: i + 1, stock: 1, categoryId: category,
				categoryName: 'C'.repeat(300) + category, locationName: 'L'.repeat(300),
				planName: `item-${i}-` + '[x]'.repeat(200), categoryDescription: 'D'.repeat(4000) });
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
		if (index < pages.length - 1) assert.ok(buttons.some(row => row.components.some(button => button.data.custom_id === 'stock:next' && !button.data.disabled)));
	}
	assert.equal(rows, plans.size);
});

test('atomic JSON replacement leaves complete data and no temporary files', async t => {
	const path = await directory(t);
	const file = join(path, 'state.json');
	await writeJsonAtomic(file, { version: 1 });
	await Promise.all(Array.from({ length: 10 }, (_, i) => writeJsonAtomic(file, { version: i })));
	assert.equal(typeof JSON.parse(await readFile(file, 'utf8')).version, 'number');
	assert.deepEqual(await readdir(path), ['state.json']);
});

test('sticky edit errors surface and do not silently replace the message', async t => {
	const path = await directory(t);
	const statePath = join(path, 'sticky.json');
	await writeJsonAtomic(statePath, { channelId: 'channel', messageId: 'message' });
	const manager = new StickyStockManager();
	manager.configure({ channelId: 'channel', statePath });
	manager.setLatest(extractPlanStockMap(api(1)));
	let sends = 0;
	const client = { logger, channels: { fetch: async () => ({ isSendable: () => true,
		messages: { fetch: async () => ({ edit: async () => { throw new Error('Forbidden'); } }) },
		send: async () => { sends++; }
	}) } };
	await assert.rejects(manager.refresh(client), /Forbidden/);
	assert.equal(sends, 0);
	await manager.stop();
});

test('polls never overlap and stopping prevents subsequent polling', async t => {
	const path = await directory(t);
	const originalGet = axios.default.get;
	let calls = 0;
	let release;
	axios.default.get = async () => {
		calls++;
		return new Promise(resolve => { release = () => resolve({ data: api() }); });
	};
	t.after(() => { axios.default.get = originalGet; });
	const stop = startStockMonitor({ logger }, { url: 'unused', channelId: 'channel', intervalMs: 5, snapshotPath: join(path, 'stock.json') });
	await until(() => calls === 1);
	await delay(30);
	assert.equal(calls, 1);
	const stopped = stop();
	release();
	await stopped;
	await delay(20);
	assert.equal(calls, 1);
});

test('failed alerts are retried before committing and unchanged polls skip disk writes', async t => {
	const path = await directory(t);
	const snapshotPath = join(path, 'stock.json');
	await writeJsonAtomic(snapshotPath, { plans: [...extractPlanStockMap(api()).values()] });
	const originalGet = axios.default.get;
	axios.default.get = async () => ({ data: api(1) });
	t.after(() => { axios.default.get = originalGet; });
	let attempts = 0;
	let alerts = 0;
	const channel = { isSendable: () => true,
		messages: { fetch: async () => ({ edit: async () => {} }) },
		send: async payload => {
			if (payload.embeds[0].data.url) {
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
	const stop = startStockMonitor({ logger, channels: { fetch: async () => channel } }, { url: 'unused', channelId: 'channel', intervalMs: 10, snapshotPath });
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
