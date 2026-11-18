// Regression groups. Members are string ids; unknown ids fail at load time.
import { Group } from "./.dtsim/dsl/index.ts";

export const base = Group("base", [
	"test_quick_smoke",
	"test_hello_world",
	"test_bar_basic",
]);

export const regrPlanA = Group("regr_plan_a", [
	"test_quick_smoke",
	"test_hello_world",
	"test_bar_basic",
	"test_full_chip",
]);

export const cosim = Group("cosim", [
	"test_hello_world.cosim",
	"test_bar_basic.cosim",
	"test_full_chip.cosim",
]);
