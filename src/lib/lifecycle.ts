type ShutdownTask = () => void | Promise<void>;

const tasks = new Set<ShutdownTask>();

export function onShutdown(task: ShutdownTask): void {
	tasks.add(task);
}

export async function shutdown(): Promise<void> {
	const pending = [...tasks];
	tasks.clear();
	await Promise.all(pending.map(task => task()));
}
