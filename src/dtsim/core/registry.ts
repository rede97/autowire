// Simulator backend and launcher registries. Core modules never branch on a
// tool or launcher id; they look the id up here and call the plugin contract.
import {
	defineLauncher,
	defineTool,
	type Launcher,
	type SimTool,
} from "../dsl/index.ts";
import { localLauncher } from "../launchers/local.ts";
import { lsfLauncher } from "../launchers/lsf.ts";
import { slurmLauncher } from "../launchers/slurm.ts";
import { vcsTool } from "../tools/vcs.ts";
import { verilatorTool } from "../tools/verilator.ts";

const registry = new Map<string, SimTool>();
const launchers = new Map<string, Launcher>();

export function registerTool(tool: SimTool): void {
	defineTool(tool);
	if (registry.has(tool.id)) {
		throw new Error(`dtsim: tool id "${tool.id}" is already registered`);
	}
	registry.set(tool.id, tool);
}

export function getTool(id: string): SimTool {
	const tool = registry.get(id);
	if (!tool) {
		const known = [...registry.keys()].sort().join(", ");
		throw new Error(`dtsim: unknown tool "${id}" (registered: ${known})`);
	}
	return tool;
}

export function registeredTools(): string[] {
	return [...registry.keys()].sort();
}

export function registerLauncher(launcher: Launcher): void {
	defineLauncher(launcher);
	if (launchers.has(launcher.id)) {
		throw new Error(
			`dtsim: launcher id "${launcher.id}" is already registered`,
		);
	}
	launchers.set(launcher.id, launcher);
}

export function getLauncher(id: string): Launcher {
	const launcher = launchers.get(id);
	if (!launcher) {
		const known = [...launchers.keys()].sort().join(", ");
		throw new Error(`dtsim: unknown task type "${id}" (launchers: ${known})`);
	}
	return launcher;
}

// Built-ins register on import, so embedders (tests, library use) see the
// same backends as the CLI. User tools and launchers register later via
// Workspace.tools / Workspace.launchers.
registerTool(vcsTool);
registerTool(verilatorTool);
registerLauncher(localLauncher);
registerLauncher(lsfLauncher);
registerLauncher(slurmLauncher);
