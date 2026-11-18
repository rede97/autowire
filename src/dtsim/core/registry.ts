// Simulator backend registry. Core modules never branch on a tool id; they
// look the id up here and call the SimTool contract.
import { defineTool, type SimTool } from "../dsl/index.ts";
import { vcsTool } from "../tools/vcs.ts";
import { verilatorTool } from "../tools/verilator.ts";

const registry = new Map<string, SimTool>();

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

// Built-ins register on import, so embedders (tests, library use) see the
// same backends as the CLI. User tools register later via Workspace.tools.
registerTool(vcsTool);
registerTool(verilatorTool);
