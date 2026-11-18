# dtsim

TypeScript-configured simulation runner. Single file product: `dtsim.js` (run with Bun).

Layout in this repository:

| Directory | Contents |
|---|---|
| `dtsim/` | Engine: DSL, config loader, env isolation, grader, scheduler, progress, CLI, built-in backends |
| `dt/` | Verification: `bun test dt/`, mock tool binaries in `dt/test_env/bin/` |
| `config/` | Example workspace: `dtsim.config.ts`, `cases/`, `groups.ts` |

## Commands

```bash
bun dtsim/index.ts run test_hello_world            # compile + simulate one case
bun dtsim/index.ts run test_hello_world.cosim      # subcase: base + suffix overlay
bun dtsim/index.ts run test_bar_basic --num-seeds 5
bun dtsim/index.ts run test_hello_world --compile-only
bun dtsim/index.ts run test_hello_world --sim-only -d nightly
bun dtsim/index.ts plan [group]                    # compile-group plan only
bun dtsim/index.ts regr [group]                    # execute a regression
bun dtsim/index.ts list
bun dtsim/index.ts results --dir simout/regression [--recheck] [--csv]
bun dtsim/index.ts env --case test_bar_basic.cosim [--phase compile] [--show-values]
```

Useful flags: `-s <seed>`, `--seed-file <f>`, `--num-seeds <n>`, `-d <label>`,
`-v/--verbose` (stream logs), `--interactive` (UCLI terminal, single case only),
`--plain` (no dashboard), `--cov`, `--no-cov-merge`, `--no-wave`,
`--wave-depth`, `--wave-top`, `--config`, `--root`.

Production bundle: `bun run build:dtsim` writes `dtsim.js`; use `bun dtsim.js ...`
with the same subcommands. The bundle embeds the DSL and both built-in
backends. User configs are loaded at runtime; the DSL is materialized into
`<config dir>/.dtsim/dsl/index.ts` on every run (deletable cache, do not edit).

## Configuration

One `dtsim.config.ts` per workspace. See `config/` for a complete example.

- `Workspace({ tool, filelist, bareDefaults, env, task, waive, patches, hooks, groups, cases })`
- `Case(name, opts)` / `Subcase(base, suffix, opts)` / `Group(name, ids)`
- List fields (`defines`, `compileArgs`, `simArgs`, `grade.*`) append.
  `env` maps merge per key. Bare names get `bareDefaults`; explicit subcases do not.
- `uvm` is only interpreted by the VCS backend; other backends ignore it.

## Simulator backends (plugins)

`vcs` and `verilator` are built in and registered at startup. A workspace can
register its own backend instead of editing the engine:

```ts
const myTool = defineTool({
	kind: "dtsim-tool",
	id: "xcelium",
	passthrough: ["PATH", "XCELIUM_HOME"],
	interactive: false,
	compileErrors: [/Error/],
	simErrors: [/UVM_ERROR/],
	compile: (ctx) => ({ argv: [...], cwd: ctx.dir, log: `${ctx.dir}/compile.log`, logMode: "tee" }),
	simulate: (ctx) => ({ argv: [...], cwd: ctx.dir, log: `${ctx.dir}/sim.log`, logMode: "tee" }),
});
export default Workspace({ tool: "xcelium", tools: [myTool], ... });
```

The engine owns scheduling, grading, and environment assembly. A backend only
supplies argv, log locations, excerpt regexes, and optional helper files
(`writeAux`), fingerprint extras, and per-tool `toolOptions`. Backend ids must
not shadow built-ins. `local` / `lsf` / `slurm` launchers wrap the argv;
`DTSIM_TASK_TYPE` / `DTSIM_TASK_QUEUE` override type and queue only.

## Environment isolation

Children do not inherit the parent shell. A variable reaches the simulator
only when the backend's `passthrough` list or the workspace's
`env.passthrough` names it (trailing `*` allowed). `env.deny` wins over both.
Case `env` entries are explicit assignments; `{ value, scope: "sim" }` skips
compilation and the compile fingerprint. `output_dir`, `verify`, `WORKSPACE`,
`DTSIM_*` are injected per phase. `dtsim env --case ...` shows the result.

## Logs, grading, errors

Logs stay in files by default. Grading reads `sim.log`, not the exit code:
`PASS`, `PASS WITH ERRORS` (exit 0), `FAIL`, `NO SIM LOG`, `ABORTED`.
Waive markers keep their dsim spelling (`DSIM_WAIVE_BEGIN/END/ON/OFF`).
Every seed directory has `run_sim`, `check_result.js`, keyword files,
`.result`, and — for any non-clean result — `error.txt` with a bounded excerpt.
Hooks (`preCompile`, `postCompile`, `preSim`, `postSim`, `onGrade`, `onResult`)
are script files; `onGrade` replaces the built-in grader and is honored by
`results --recheck`.

## Tests

```bash
bun test dt/
bun run build:dtsim
```

Mock binaries simulate compile/sim success, compile failure, runtime errors,
waive regions, urg merge, and Verilator builds. `DTSIM_MOCK_*` switches only
reach the mocks because the test configs list them in `env.passthrough`.
