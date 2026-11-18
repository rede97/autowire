// Running a grader. Status comes from the log content, never from the
// simulator exit code; the verdict belongs to the case's grader
// (DefaultGrader unless the config sets another).
import { appendFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
	GradeContext,
	GradeOutcome,
	Grader,
	GradeStatus,
} from "../dsl/index.ts";
import { errorText, shellFor } from "./hooks.ts";

const GRADE_STATUSES: readonly string[] = [
	"PASS",
	"PASS WITH ERRORS",
	"FAIL",
	"NO SIM LOG",
] satisfies readonly GradeStatus[];

export type Graded = {
	status: GradeStatus;
	note?: string;
	/** Report rows for the `run` summary and error.txt. */
	details?: ReadonlyArray<readonly [string, string]>;
	/** Log lines error.txt should show. */
	highlight?: readonly string[];
};

function normalize(value: unknown): Graded | undefined {
	const out: Partial<GradeOutcome> | undefined =
		typeof value === "string"
			? { status: value as GradeStatus }
			: typeof value === "object" && value !== null
				? (value as GradeOutcome)
				: undefined;
	if (!out?.status || !GRADE_STATUSES.includes(out.status)) return undefined;
	return {
		status: out.status,
		...(typeof out.note === "string" && out.note ? { note: out.note } : {}),
		...(Array.isArray(out.details) ? { details: out.details } : {}),
		...(Array.isArray(out.highlight) ? { highlight: out.highlight } : {}),
	};
}

/** Run `grader` on one seed. A missing log is NO SIM LOG without calling it;
 *  a throw or an unknown status grades FAIL with the reason in grade.log. */
export async function runGrader(
	grader: Grader,
	base: Omit<GradeContext, "sh">,
): Promise<Graded> {
	if (!existsSync(base.log)) return { status: "NO SIM LOG" };
	const log = join(base.dir, "grade.log");
	rmSync(log, { force: true }); // created on first write only
	const ctx: GradeContext = {
		...base,
		sh: shellFor(base, log, { DTSIM_GRADER: grader.name }),
	};
	try {
		const value = await grader.grade(ctx);
		const graded = normalize(value);
		if (graded) return graded;
		appendFileSync(
			log,
			`grader ${grader.name} returned ${JSON.stringify(value)}; graded FAIL\n`,
		);
	} catch (error) {
		appendFileSync(log, `grader ${grader.name} threw:\n${errorText(error)}\n`);
	}
	return {
		status: "FAIL",
		note: `grader ${grader.name} failed, see grade.log`,
	};
}
