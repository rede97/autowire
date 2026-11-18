// Built-in local launcher: run the command directly on this host.
import type { Launcher } from "../dsl/index.ts";

export const localLauncher: Launcher = {
	kind: "dtsim-launcher",
	id: "local",
	passthrough: [],
	wrap: (argv) => [...argv],
};
