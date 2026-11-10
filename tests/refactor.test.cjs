const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, readFile, stat, mkdir, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { readConfig, stickyStatePath } = require('../dist/lib/config');
const { extractPlanStockMap, stockMapsEqual, writeSnapshotToDisk } = require('../dist/lib/stockData');
const { StickyStockManager } = require('../dist/lib/stickyStock');
const { startStockMonitor } = require('../dist/lib/stockMonitor');
const { onShutdown, shutdownAndDestroy } = require('../dist/lib/lifecycle');
const { StockPaginationListener } = require('../dist/listeners/stockPagination');

const logger = { info() {}, warn() {}, error() {} };
const api = (stock = 1) => ({
	groups: [
		{
			id: 1,
			name: 'KVM Standard VPS',
			locations: [
				{
					id: 1,
					name: 'Location',
					plans: [
						{ id: 1, name: 'Plan 1', stock, price: '8.00', billing_product_id: 425 },
						{ id: 2, name: 'Plan 2', stock: 0 }
					]
				}
			]
		}
	]
});
const stockMap = (stock = 1) => extractPlanStockMap(api(stock));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
	const deadline = Date.now() + 2000;
	while (!(await predicate())) {
		assert.ok(Date.now() < deadline, 'condition timed out');
		await delay(5);
	}
}
async function fixture(t) {
	const dir = await mkdtemp(join(tmpdir(), 'stock-refactor-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const manager = new StickyStockManager();
	manager.configure({ channelId: 'channel', statePath: join(dir, 'sticky-stock.json') });
	manager.setLatest(stockMap());
	let edits = 0;
	let sends = 0;
	let failEdit = false;
	const messages = new Map();
	const channel = {
		isSendable: () => true,
		messages: {
			async fetch(options) {
				assert.equal(options.force, true);
				if (!messages.has(options.message)) throw Object.assign(new Error('Unknown message'), { code: 10008 });
				return {
					async edit(payload) {
						edits++;
						if (failEdit) throw new Error('Edit failed');
						messages.set(options.message, payload);
					}
				};
			},
			async delete(id) {
				messages.delete(id);
			}
		},
		async send(payload) {
			const id = `message-${++sends}`;
			messages.set(id, payload);
			return { id };
		}
	};
	const client = { logger, channels: { fetch: async () => channel } };
	t.after(() => manager.stop());
	return {
		dir,
		manager,
		client,
		messages,
		channel,
		get edits() {
			return edits;
		},
		get sends() {
			return sends;
		},
		set failEdit(value) {
			failEdit = value;
		}
	};
}

test('configuration preserves defaults, bounds, disabled polling, and shared state paths', () => {
	const warnings = [];
	const read = (env) => readConfig(env, (message) => warnings.push(message));
	assert.equal(read({}).intervalMs, 300000);
	assert.equal(read({}).channelId, undefined);
	for (const value of ['9999', '2147483648', 'abc', '1.5']) {
		assert.equal(read({ STOCK_ALERT_CHANNEL_ID: 'channel', STOCK_POLL_INTERVAL_MS: value }).intervalMs, 300000);
	}
	assert.equal(warnings.length, 4);
	for (const value of ['10000', '2147483647'])
		assert.equal(read({ STOCK_POLL_INTERVAL_MS: value }).intervalMs, Number(value));
	const config = read({ DISCORD_TOKEN: ' token ', STOCK_SNAPSHOT_PATH: './data/custom.json' });
	assert.equal(config.token, 'token');
	assert.equal(stickyStatePath(config.snapshotPath), join(process.cwd(), 'data', 'sticky-stock.json'));
});

test('stock comparison ignores ordering and detects every normalized field change', () => {
	const original = stockMap();
	assert.ok(stockMapsEqual(original, new Map([...original].reverse())));
	const entry = original.values().next().value;
	for (const field of Object.keys(entry)) {
		const changed = new Map(original);
		changed.set(entry.key, {
			...entry,
			[field]: typeof entry[field] === 'number' ? entry[field] + 1 : `${entry[field]} changed`
		});
		assert.equal(stockMapsEqual(original, changed), false, field);
	}
});

test('unchanged summaries skip edits, recover deleted messages, and still repost explicitly', async (t) => {
	const f = await fixture(t);
	await f.manager.refresh(f.client);
	const original = [...f.messages.keys()][0];
	f.manager.setLatest(new Map([...stockMap()].reverse()));
	await f.manager.refresh(f.client);
	assert.equal(f.sends, 1);
	assert.equal(f.edits, 0);
	f.messages.delete(original);
	await f.manager.refresh(f.client);
	assert.equal(f.sends, 2);
	await f.manager.refresh(f.client, true);
	assert.equal(f.sends, 3);
	assert.equal(f.messages.size, 1);
});

test('caches own their inventory, clone outgoing embeds, and invalidate for metadata and stock', async (t) => {
	const f = await fixture(t);
	const input = stockMap();
	f.manager.setLatest(input);
	const first = f.manager.buildView();
	first.embeds[0].setTitle('changed by caller');
	input.clear();
	const exposed = f.manager.getLatest();
	exposed.clear();
	assert.equal(f.manager.buildView().embeds[0].data.title, 'KVM Standard VPS');
	await f.manager.refresh(f.client);
	for (const patch of [
		{ price: '9.00' },
		{ categoryDescription: 'New introduction' },
		{ vcpuCores: 8 },
		{ stock: 0 }
	]) {
		const next = new Map(f.manager.getLatest());
		const entry = next.get('1:1:1');
		next.set(entry.key, { ...entry, ...patch });
		f.manager.setLatest(next);
		const view = f.manager.buildView();
		if (patch.price) assert.match(view.embeds[0].data.fields[0].value, /9.00/);
		if (patch.categoryDescription) assert.match(view.embeds[0].data.description, /New introduction/);
		if (patch.vcpuCores) assert.equal(f.manager.getLatest().get(entry.key).vcpuCores, 8);
		await f.manager.refresh(f.client);
	}
	assert.equal(f.edits, 2, 'price and availability affect the public summary');
});

test('failed summary edits are retried without replacing the existing message', async (t) => {
	const f = await fixture(t);
	await f.manager.refresh(f.client);
	f.manager.setLatest(stockMap(0));
	f.failEdit = true;
	await assert.rejects(f.manager.refresh(f.client), /Edit failed/);
	f.failEdit = false;
	await f.manager.refresh(f.client);
	await f.manager.refresh(f.client);
	assert.equal(f.edits, 2);
	assert.equal(f.sends, 1);
});

test('reordered polling does not write snapshots or edit summaries', async (t) => {
	const f = await fixture(t);
	const path = join(f.dir, 'stock.json');
	await writeSnapshotToDisk(path, stockMap());
	const before = await readFile(path, 'utf8');
	const mtime = (await stat(path)).mtimeMs;
	let calls = 0;
	const stop = startStockMonitor(f.client, {
		url: 'unused',
		channelId: 'channel',
		intervalMs: 5,
		snapshotPath: path,
		manager: f.manager,
		fetchStock: async () => {
			calls++;
			const data = api();
			if (calls % 2) data.groups[0].locations[0].plans.reverse();
			return data;
		}
	});
	t.after(stop);
	await until(() => calls >= 3);
	await stop();
	assert.equal(await readFile(path, 'utf8'), before);
	assert.equal((await stat(path)).mtimeMs, mtime);
	assert.equal(f.edits, 0);
});

test('failed snapshot commits retry alerts while observed inventory stays current', async (t) => {
	const f = await fixture(t);
	const path = join(f.dir, 'stock.json');
	await writeSnapshotToDisk(path, stockMap(0));
	let alerts = 0;
	let unblock;
	const blocked = new Promise((resolve) => {
		unblock = resolve;
	});
	const send = f.channel.send;
	f.channel.send = async (payload) => {
		if (payload.embeds[0]?.data.url) {
			alerts++;
			if (alerts === 1) {
				await rm(path);
				await mkdir(path);
			}
		}
		return send(payload);
	};
	let calls = 0;
	const stop = startStockMonitor(f.client, {
		url: 'unused',
		channelId: 'channel',
		intervalMs: 5,
		snapshotPath: path,
		manager: f.manager,
		fetchStock: async () => {
			if (++calls > 1) await blocked;
			return api();
		}
	});
	t.after(stop);
	await until(() => calls >= 2);
	assert.equal(f.manager.getLatest().get('1:1:1').stock, 1);
	await rm(path, { recursive: true });
	await writeFile(path, JSON.stringify({ plans: [...stockMap(0).values()] }));
	unblock();
	await until(async () => JSON.parse(await readFile(path, 'utf8')).plans[0].stock === 1);
	await stop();
	assert.equal(alerts, 2);
});

test('independent monitors keep separate inventory, timers, and mutation queues', async (t) => {
	const a = await fixture(t);
	const b = await fixture(t);
	let callsA = 0;
	let callsB = 0;
	const options = { url: 'unused', channelId: 'channel', intervalMs: 5 };
	const stopA = startStockMonitor(a.client, {
		...options,
		snapshotPath: join(a.dir, 'stock.json'),
		manager: a.manager,
		fetchStock: async () => {
			callsA++;
			return api(1);
		}
	});
	const stopB = startStockMonitor(b.client, {
		...options,
		snapshotPath: join(b.dir, 'stock.json'),
		manager: b.manager,
		fetchStock: async () => {
			callsB++;
			return api(0);
		}
	});
	t.after(stopA);
	t.after(stopB);
	await until(() => callsA >= 2 && callsB >= 2);
	await stopA();
	const stoppedCalls = callsA;
	const otherCalls = callsB;
	await until(() => callsB > otherCalls);
	assert.equal(callsA, stoppedCalls);
	assert.equal(a.manager.getLatest().get('1:1:1').stock, 1);
	assert.equal(b.manager.getLatest().get('1:1:1').stock, 0);
	await stopB();
});

test('shutdown waits for all cleanup and destroys the client after synchronous failure', async () => {
	const events = [];
	onShutdown(() => {
		events.push('failed');
		throw new Error('cleanup failure');
	});
	onShutdown(async () => {
		await delay(10);
		events.push('drained');
	});
	await assert.rejects(
		shutdownAndDestroy(() => {
			events.push('destroyed');
		}),
		AggregateError
	);
	assert.deepEqual(events, ['failed', 'drained', 'destroyed']);
});

test('pagination failures get a private error reply after acknowledgement', async () => {
	const { stickyStockManager } = require('../dist/lib/stickyStock');
	const original = stickyStockManager.handlePagination;
	stickyStockManager.handlePagination = async () => {
		throw new Error('Discord failed');
	};
	try {
		const replies = [];
		await StockPaginationListener.prototype.run.call(
			{ container: { logger } },
			{
				isButton: () => true,
				customId: 'stock:open',
				deferred: true,
				followUp: async (payload) => replies.push(payload)
			}
		);
		assert.equal(replies.length, 1);
		assert.match(replies[0].content, /temporarily unavailable/);
	} finally {
		stickyStockManager.handlePagination = original;
	}
});

test('polling preserves baseline, new-product, quantity-change, and restock alert rules', async (t) => {
	const f = await fixture(t);
	let alerts = 0;
	const send = f.channel.send;
	f.channel.send = async (payload) => {
		if (payload.embeds[0]?.data.url) alerts++;
		return send(payload);
	};
	const quantities = [0, 0, 2, 3, 0, 1];
	let calls = 0;
	const stop = startStockMonitor(f.client, {
		url: 'unused',
		channelId: 'channel',
		intervalMs: 5,
		snapshotPath: join(f.dir, 'stock.json'),
		manager: f.manager,
		fetchStock: async () => {
			const data = api(quantities[Math.min(calls, quantities.length - 1)]);
			if (calls++ > 0) data.groups[0].locations[0].plans.push({ id: 3, name: 'New plan', stock: 1 });
			return data;
		}
	});
	t.after(stop);
	await until(() => calls > quantities.length);
	await stop();
	assert.equal(alerts, 2);
});

test('stopping aborts an in-flight fetch and prevents further polls', async (t) => {
	const f = await fixture(t);
	let calls = 0;
	let aborted = false;
	const stop = startStockMonitor(f.client, {
		url: 'unused',
		channelId: 'channel',
		intervalMs: 5,
		snapshotPath: join(f.dir, 'stock.json'),
		manager: f.manager,
		fetchStock: async (_url, signal) => {
			calls++;
			return new Promise((_resolve, reject) =>
				signal.addEventListener(
					'abort',
					() => {
						aborted = true;
						reject(new Error('aborted'));
					},
					{ once: true }
				)
			);
		}
	});
	await until(() => calls === 1);
	await stop();
	await delay(15);
	assert.equal(aborted, true);
	assert.equal(calls, 1);
});

test('sticky shutdown drains a Discord send already in progress', async (t) => {
	const f = await fixture(t);
	let release;
	const sent = new Promise((resolve) => {
		release = resolve;
	});
	let started = false;
	const send = f.channel.send;
	f.channel.send = async (payload) => {
		started = true;
		await sent;
		return send(payload);
	};
	const refresh = f.manager.refresh(f.client);
	await until(() => started);
	let stopped = false;
	const stop = f.manager.stop().then(() => {
		stopped = true;
	});
	await delay(5);
	assert.equal(stopped, false);
	release();
	await Promise.all([refresh, stop]);
	assert.equal(f.messages.size, 1);
});
