import { SapphireClient } from '@sapphire/framework';
import { GatewayIntentBits } from 'discord.js';
import { join } from 'node:path';
import 'dotenv/config';
import { shutdownAndDestroy } from './lib/lifecycle';
import { getConfig } from './lib/config';

async function main(): Promise<void> {
	const { token } = getConfig();
	if (!token) throw new Error('DISCORD_TOKEN is required.');

	const client = new SapphireClient({
		intents: [GatewayIntentBits.MessageContent, GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
		loadMessageCommandListeners: true,
		defaultPrefix: '!',
		baseUserDirectory: join(__dirname),
		allowedMentions: { parse: [] }
	});

	let stopping = false;
	const stop = async (signal: string) => {
		if (stopping) return;
		stopping = true;

		client.logger.info(`[bot] Received ${signal}; shutting down.`);
		const timeout = setTimeout(() => process.exit(1), 15_000);
		timeout.unref();

		try {
			await shutdownAndDestroy(() => client.destroy());
		} catch (error) {
			client.logger.error('[bot] Shutdown failed', error);
			process.exitCode = 1;
		} finally {
			clearTimeout(timeout);
		}
	};

	process.once('SIGINT', () => { void stop('SIGINT') });
	process.once('SIGTERM', () => { void stop('SIGTERM') });
	client.on('error', (error) => client.logger.error('[bot] Discord client error', error));

	try {
		await client.login(token);
	} catch (error) {
		await client.destroy();
		throw error;
	}
}

void main().catch((error) => {
	console.error('[bot] Startup failed:', error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
