// Built-in grader: pass / error / expect keywords on sim.log, with waive
// regions. The verdict itself lives in core/grade.ts (`ctx.keywords()`), so
// user graders can start from the same result.
import { defineGrader } from "../dsl/index.ts";

export const keywordsGrader = defineGrader({
	kind: "dtsim-grader",
	id: "keywords",
	grade: (ctx) => ctx.keywords(),
});
