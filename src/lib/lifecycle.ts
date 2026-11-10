type ShutdownTask = () => void | Promise<void>;

const tasks = new Set<ShutdownTask>();

export function onShutdown(task: ShutdownTask): void {
	tasks.add(task);
}

export async function shutdown(): Promise<void> {
	const pending = [...tasks];
	tasks.clear();
	const results = await Promise.allSettled(pending.map(async (task) => task()));
	const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason as unknown);
	if (failures.length) throw new AggregateError(failures, 'Shutdown tasks failed.');
}

/** Destroy the Discord client even when a cleanup task fails. */
export async function shutdownAndDestroy(destroy: ShutdownTask): Promise<void> {
	try {
		await shutdown();
	} finally {
		await destroy();
	}
}
