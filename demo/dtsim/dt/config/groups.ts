// Regression groups. Members are case objects, ids, bare base names (expanded
// to their derived cases), or id patterns; unknown ids fail at load time.
// There is no reserved "all" group: use the `*` pattern (top-level cases) or
// `**` (every depth) directly, e.g. `dtsim regr '*'`.
import { Group } from "../../../../src/dtsim/dsl/index.ts";

export const base = Group("base", [
	"test_quick_smoke",
	"test_hello_world",
	"test_bar_basic",
]);

// "chip" is an abstract base: naming it expands to chip.rtl and chip.gate.
export const regrPlanA = Group("regr_plan_a", [
	"test_quick_smoke",
	"test_hello_world",
	"test_bar_basic",
	"chip",
]);

export const cosim = Group("cosim", [
	"test_hello_world.cosim",
	"test_bar_basic.cosim",
]);
