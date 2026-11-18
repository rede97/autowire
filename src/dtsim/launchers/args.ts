// task.options.args for the built-in cluster launchers: extra flags placed
// between the launcher's own flags and the wrapped command.
export function launcherArgs(
	id: string,
	options: Record<string, unknown>,
): string[] {
	const args = options.args;
	if (args === undefined) return [];
	if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
		throw new Error(`dtsim: ${id} task.options.args must be a string array`);
	}
	return args;
}
