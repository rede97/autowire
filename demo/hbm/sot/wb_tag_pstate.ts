// Shared shadow domain for the HBM demo (contract: docs/plugins/wishbone-bus.md 2.1).
// Declared once here; imported by every table that replicates on it and by the
// fabric that carries its TGA slice. 4 pstates -> TGA[1:0].

import { ShadowDomain } from "../../../src/plugins/wishbone-regfile/dsl.ts";

export const pstate = ShadowDomain(
	"pstate",
	4,
	"1:0",
	"Power state: frequency point / operating mode bank",
);
