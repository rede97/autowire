// Shared Wishbone tag domains used by the demo SoC fabrics.

import { ShadowDomain } from "../../../src/plugins/wishbone-regfile/dsl.ts";

/** Four shadow banks selected by the smoke regfile BANKSEL field. */
export const bank = ShadowDomain(
	"bank",
	4,
	2,
	"Demo SoC shadow bank selection",
);
