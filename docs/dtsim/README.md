# dtsim

Simulation runner built into autowire. `dt` is the design-test directory: an RTL
design directory (the project) creates `dt/`, which holds its testbench code,
and `dt/config/` holds the dtsim configuration written in TypeScript.

```text
<project>/                 RTL design dir; filelist paths and ${workspace} resolve here
  rtl/ ...
  dt/
    <testbench sources>    TB tops, .svh, UVM env, C++ harness, ...
    config/
      dtsim.config.ts      default config (found upward from CWD)
      *.f / *.lst          filelists (entries relative to <project>)
      hooks.ts             hook functions (any module the config imports)
      .dtsim/dsl/          materialized DSL (deletable cache, do not edit)
    simout/                outputs (git-ignored)
```

## Entry points

`dtsim` is a subcommand of autowire and also a multi-call name of the same file:

```bash
bun index.ts dtsim run <case>              # dev (repository)
autowire dtsim run <case>                  # production: out/autowire or bun out/autowire.js
ln -s /path/to/autowire.js dtsim           # or a symlink to the compiled out/autowire
./dtsim run <case>                         # same subcommands, no "autowire dtsim" prefix
```

The process checks the name it was started under. Bun resolves symlinks in
`process.argv[1]`, so on Linux dtsim reads the exec'd names from
`/proc/self/cmdline` (`bun ./dtsim ...` for the script, `dtsim ...` for the
compiled binary). Without procfs (macOS, Windows) only a copy named `dtsim` /
`dtsim.js` is detected; use `autowire dtsim` there. `autowire.js` carries a
`#!/usr/bin/env bun` shebang and is written executable, so the symlink runs
directly from a shell.

## Commands

```bash
dtsim run test_hello_world            # compile + simulate one case
dtsim run test_hello_world.cosim      # subcase: base + suffix overlay
dtsim run test_bar_basic --num-seeds 5
dtsim run test_hello_world --compile-only
dtsim run test_hello_world --sim-only -d nightly
dtsim plan [group]                    # compile-group plan only
dtsim regr [group]                    # execute a regression (default group: all)
dtsim list
dtsim groups
dtsim results --dir dt/simout/regression [--recheck] [--csv]
dtsim env --case test_bar_basic.cosim [--phase compile] [--show-values]
```

Useful flags: `-s <seed>`, `--seed-file <f>`, `--num-seeds <n>`, `-d <label>`
(outputs under `dt/simout/<label>/`), `-v/--verbose` (stream logs),
`--interactive` (UCLI terminal, single case only), `--plain` (no dashboard),
`--cov`, `--no-cov-merge`, `--no-wave`, `--wave-depth`, `--wave-top`,
`--config <path>` (another config file, e.g. `dt/config/vcs.config.ts`).

## Configuration

Default config: `<project>/dt/config/dtsim.config.ts`, searched upward from the
CWD (stops at a `.git` directory). `--config` selects another file; the project
is always the parent of the config file's `dt/` directory. User configs are
loaded at runtime; the DSL is written to `dt/config/.dtsim/dsl/index.ts` on
every run and config files import it from there. Inside this repository the
demo configs import `src/dtsim/dsl/index.ts` directly (same convention as the
wishbone SoT), so DSL edits reach them without a regenerate step; `docs unpack`
rewrites those imports to the `.dtsim/dsl` copy. No symlink is used: Windows
symlinks need extra privileges and Bun does not follow MSYS ones.

- `Workspace({ tool, filelist, output, tools, launchers, toolOptions, bareDefaults, env, task, waive, hooks, groups, cases })`
- `Case(name, opts)` / `case.SubCase(suffix, opts)` / `Group(name, ids)`
- List fields (`defines`, `compileArgs`, `simArgs`, `grade.*`) append.
  `env` maps merge per key. Bare top-level cases get `bareDefaults`; derived cases do not.
- `filelist` (workspace or case) is a path relative to `dt/config/`. A case
  filelist replaces the workspace one and splits the compile group.
- `output` moves the output root (default `<project>/dt/simout`), e.g.
  `output: "${workspace}/temp/output"` or `"${SCRATCH}/dtsim"`.
- `uvm` is only interpreted by the VCS backend; other backends ignore it.

### Case trees

A top-level case owns its derived cases. `SubCase` returns the new case, so
derivation nests to any depth, and the id is the dotted path:

```ts
export const hello = Case("test_hello_world", { defines: ["NUM=1"] });
const cosim = hello.SubCase("cosim", { compileArgs: ["-debug_access+all"], env: { INPUT: "input.spf" } });
cosim.SubCase("ss", (parent) => ({ env: { INPUT: String(parent.env?.INPUT).replace(".spf", "_ss.spf") } }));
hello.SubCase("timing", { grade: { error: ["re:ERROR:.*timing violation"] } });
// ids: test_hello_world, test_hello_world.cosim, test_hello_world.cosim.ss, test_hello_world.timing
```

- A case file exports only its top-level cases; dtsim walks `children`.
  Exporting a derived case too is harmless (it registers its root).
- Each level merges onto its parent's merged options with the list / map /
  scalar rules above.
- Options may be a function of the parent's merged options. dtsim calls it
  only when that case is used (`run`, `regr`, `plan`, `env`, a group that
  names it), at most once per load; `list` prints derived ids without
  evaluating them. Deny-list checks run at the same moment, so a bad
  assignment fails the case that has it, not the whole load.
- A suffix may not contain `.` or `/`, may not be `default`, and must be
  unique under its parent (checked when `SubCase` is called).
- `case.descendants()` returns every derived case below it, depth-first in
  declaration order, without evaluating options.
- `group "all"` is the top-level cases. `Group(name, members)` takes, in any
  mix: case objects (`Group("cosim", [aCosim, bCosim])`), exact ids, and id
  patterns where `*` stays inside one id segment and `**` crosses segments
  (`"hello_world_base.*.cosim"`, `"hello_world_base.**"`). Members keep their
  order, patterns expand in tree order, duplicates are dropped. A pattern
  matching nothing, an unknown id, or a case object that is not in an
  exported tree fails when the group is used.

A family of small cases that share modifiers is plain TypeScript:

```ts
const withCosim = (c: CaseDef) => {
	const co = c.SubCase("cosim", { compileArgs: ["-ad=${verify}/abc"], env: { INPUT: { value: "input.spf", scope: "sim" } } });
	for (const k of ["ss", "ff"]) co.SubCase(k, { env: { INPUT: { value: `input_${k}.spf`, scope: "sim" } } });
};
export const base = Case("hello_world_base", { defines: ["NUM=1"] });
for (const [name, opts] of Object.entries({ a: { simArgs: ["+A"] }, b: { simArgs: ["+B"] } }))
	withCosim(base.SubCase(name, opts));
export default Workspace({ tool: "vcs", groups: [Group("cosim_all", ["hello_world_base.*.cosim"])] });
```

Keep sim-only inputs (`INPUT` above) at `scope: "sim"` so corners share the
parent's build.

### Placeholders and paths

One style everywhere: `${name}`. dtsim variables are `${workspace}` (project
root), `${verify}` (`dt/config`), `${output_dir}`, `${case}`, `${seed}`,
`${tool}` (`${WORKSPACE}`, `${project_home}`, `${root}` alias `${workspace}`).

- **Args, env values, generated text** (`expand`): dtsim variables are
  replaced; anything else, including `$HOME`, is left for the shell or
  simulator.
- **Paths** (`resolvePath`): `output`, `filelist`, `cases`, and
  whatever a backend or hook passes to `ctx.resolvePath`. dtsim variables
  first, then variables of the shell that started dtsim (`${HOME}`,
  `${SCRATCH}`); the result is made absolute against `dt/config`. An unknown
  name, a bare `$NAME`, or a per-case name in a workspace-level path
  (`${case}` in `output`) is an error naming the path.

(Generating or patching sources before a compile is a `preCompile` hook; see
[Hooks](#hooks).)

## Filelists

Filelist entries are relative to the project root, the same rule as
`autowire.toml` filelists, including nested `-f`. Before compiling, dtsim
writes `<compile dir>/filelist.f`: nested `-f` / `-F` inlined, file entries,
`+incdir+` directories and `-v` / `-y` arguments made absolute, other options
kept as written, `$VAR` entries left for the tool. A missing nested filelist
or a cycle fails the run before the tool starts. Backends receive this flat
file as `ctx.filelist`.

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

Built-in `toolOptions`:

| Backend | Option | Default | Meaning |
|---|---|---|---|
| verilator | `top` | `top` | `--top-module`; executable `V<top>` |
| verilator | `mdir` | `obj_dir` | `-Mdir` inside the compile dir |
| verilator | `main` | `true` | `true`: `--binary`. `false`: `--cc --exe --build` for a C++ harness; the `.cpp` files and `--timing` go in `compileArgs` |
| vcs | `ntbOpts` | `uvm` | `-ntb_opts` value, e.g. `uvm-1.2`; `""` leaves `-ntb_opts` out |
| vcs | `flags` | built-in list | replaces the built-in compile flags (`-xlrm nettype_array -lca -kdb ...`, written for a newer VCS); `-f`, `-l`, defines and `compileArgs` still follow |

The engine owns scheduling, grading, and environment assembly. A backend only
supplies argv, log locations, excerpt regexes, optional helper files
(`writeAux`), its `compileKey`, and per-tool `toolOptions`. Backend ids must
not shadow built-ins.

### Which cases share a build

In a regression, cases with equal compile keys share one compile directory.
dtsim computes a generic key (tool id, defines as a set, `compileArgs` in
order, compile-scope `env`, case `filelist`) and hands it to the backend's
`compileKey(c, base)`, which returns the final key: `base` unchanged, `base`
plus what else its build depends on, or a key of its own when the simulator
knows better (for example a backend whose defines are runtime parameters can
leave them out). `sim`-scoped env, `simArgs`, `uvm` and seeds never split a
build unless the backend puts them in the key. `dtsim plan` prints the groups.

| Backend | Key |
|---|---|
| `vcs` | base + `ntbOpts` + compile `flags` |
| `verilator` | base + `top` + `mdir` + `main` |

## Launchers (plugins)

A launcher decides how a compile or sim command runs; the scheduler decides
when (`task.maxSlots`, `task.maxCompiles` never reach the launcher). Same
shape as a simulator backend: `local`, `lsf` and `slurm` are built in, a
workspace registers more with `defineLauncher` + `Workspace({ launchers })`,
and `task.type` picks one by id.

```ts
// A site submit wrapper that blocks until the job ends and returns its exit code.
const grid = defineLauncher({
	kind: "dtsim-launcher",
	id: "grid",
	passthrough: ["GRID_*"],
	wrap: (argv, ctx) => ["grid_run", "--name", ctx.jobName, ...(ctx.queue ? ["--pool", ctx.queue] : []), "--", ...argv],
});
export default Workspace({ tool: "vcs", launchers: [grid], task: { type: "grid", queue: "eda", maxSlots: 16, maxCompiles: 4 }, ... });
```

`wrap(argv, ctx)` receives the already-built tool argv (`bash <seed dir>/run_sim`
for a sim) and returns the argv to spawn; the wrapped command must exit with
the job's exit code (interactive / blocking submission). `ctx` carries
`phase`, `jobName` (`compile_<base>` or `<case>_<seed>`), `caseId`, `seed`,
`cwd`, `queue`, `interactive` (`run --interactive`) and `options`
(`task.options`, free-form). The launcher's `passthrough` names are copied into
the child environment like a backend's.

| Launcher | Wraps as | `passthrough` | `task.options` |
|---|---|---|---|
| `local` | the command itself | none | ignored |
| `lsf` | `bsub -I -J <job> [-q <queue>] <args> <cmd>` | `LSF_*`, `LSB_*` | `args: string[]`, e.g. `["-R", "rusage[mem=8000]"]` |
| `slurm` | `srun --pty [--qos <queue>] --job-name <job> <args> <cmd>` | `SLURM_*` | `args: string[]`, e.g. `["--partition", "eda"]` |

`DTSIM_TASK_TYPE` / `DTSIM_TASK_QUEUE` override the launcher id and queue
only. An unknown id, from the config or the override, fails before any output
directory is created. Launcher ids must not shadow built-ins.

## Environment isolation

Children do not inherit the parent shell. A variable reaches the simulator
only when the backend's `passthrough` list or the workspace's
`env.passthrough` names it (trailing `*` allowed). `env.deny` wins over both.
Case `env` entries are explicit assignments; `{ value, scope: "sim" }` skips
compilation and the compile key. `output_dir`, `verify`, `WORKSPACE`,
`DTSIM_*` are injected per phase. `dtsim env --case ...` shows the result.

## Logs, grading, errors

Logs stay in files by default. Grading reads `sim.log`, not the exit code:
`PASS`, `PASS WITH ERRORS` (exit 0), `FAIL`, `NO SIM LOG`, `ABORTED`.
Waive markers keep their dsim spelling (`DSIM_WAIVE_BEGIN/END/ON/OFF`).
Every seed directory has `run_sim`, `check_result.js`, keyword files,
`.result`, `git_rev` (revision of the repo holding `dt/config`), and, for any
non-clean result, `error.txt` with a bounded excerpt. A tool that cannot be
started at all reports `dtsim: cannot start <tool>` on stderr.

## Hooks

Hooks are TypeScript functions in the config, called in the dtsim process at
fixed points of every compile and every seed. Each stage takes one function or
a list run in order. dtsim does not care what a hook does; to run a program,
use `ctx.sh`.

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function spiceDeck(ctx: HookContext) {
	const deck = await readFile(ctx.resolvePath("${verify}/cosim/spice/input.sp"), "utf8");
	await writeFile(join(ctx.dir, "input.sp"), ctx.expand(deck));
}
async function firmware(ctx: HookContext) {
	await ctx.sh(`make -C "${ctx.workspace}/fw/${ctx.env.FW}"`);
}
async function uvmSummary(ctx: HookContext): Promise<HookStatus> {
	const log = await readFile(ctx.log, "utf8");
	return /UVM_ERROR :\s+0\b/.test(log) ? "PASS" : "FAIL";
}
export default Workspace({ ..., hooks: { preCompile: [spiceDeck], preSim: firmware, onGrade: uvmSummary } });
```

Every stage gets the same `HookContext`:

| Field | Meaning |
|---|---|
| `stage` | `preCompile` `postCompile` `preSim` `postSim` `onGrade` `onResult` |
| `caseId`, `baseId` | case id and its top-level case |
| `dir` | compile dir (compile stages) or seed dir (sim stages); equals `${output_dir}` |
| `seed` | sim stages only |
| `log` | compile log (compile stages) or sim log (sim stages) |
| `status` | onResult only: the final status |
| `verify`, `workspace`, `tool` | `dt/config`, project root, backend id |
| `caseOpts` | merged `defines`, `compileArgs`, `simArgs`, `env`, `uvm`, `toolOptions`, `filelist`, placeholders intact |
| `env` | the isolated environment of this phase's tool command |
| `expand(text)`, `resolvePath(text)` | see [Placeholders and paths](#placeholders-and-paths) |
| `sh(cmd, { timeoutSec? })` | runs `bash -c cmd` in `dir` with `env` (plus `DTSIM_HOOK=<stage>`); output appended to `<dir>/hook-<stage>.log`; returns stdout; a non-zero exit throws |

A throw (or rejected promise) fails that compile or seed: the stack is
appended to `hook-<stage>.log` and `error.txt` says `phase: hook`. The rest
of that stage's list is skipped. Exceptions: `onResult` errors are only
logged, and `onGrade` grades `FAIL` when it throws or returns something
other than a hook status. Statuses are the const object `Status` from the DSL
(`Status.Pass`, `Status.PassWithErrors`, `Status.Fail`, `Status.NoSimLog`;
`Status.Aborted` is dtsim's own); the plain strings (`"PASS"`, ...) are the
same values. Hooks run in the
dtsim process, so `process.env` is dtsim's own environment; `ctx.env` is what
the tool sees. In a regression, compile stages run once per compile group
and `ctx` describes the group's first case.

| Stage | Runs | Typical use | Demo |
|---|---|---|---|
| `preCompile` | per compile dir, before the filelist is flattened and the tool runs | generate or patch sources, prebuild a C model | soc: sdspi patch via `ctx.sh`; dtsim: SPICE deck, `gen_stamp.svh` |
| `postCompile` | after the compile tool exits | compile-log policy, archive the build | dtsim: fail on more than `DTSIM_DEMO_MAX_WARN` warnings |
| `preSim` | per seed, before `run_sim` | per-seed input: firmware, memory image, stimulus | soc: firmware + SD image; dtsim: `stim.hex` from the seed |
| `postSim` | per seed, before grading | golden-model compare (throw to fail), metrics, wave conversion | dtsim: `metrics.json` |
| `onGrade` | per seed, instead of keyword grading; also `results --recheck` | a pass rule keywords cannot express | hbm: UVM report summary |
| `onResult` | per seed, after the status is final | results database, notifications, cleanup on PASS | dtsim: `results.csv`, drop waves of passing seeds |

## Windows (MSYS2 UCRT64)

Run dtsim from a UCRT64 shell (`docs/dev/windows-msys2.md`). Windows cannot
exec shebang scripts, so dtsim runs an extensionless `#!` command (the UCRT64
`verilator` perl wrapper, the demo fake tools) through the named
interpreter found on the child `PATH`. Environment names match
case-insensitively, `SYSTEMROOT` / `TEMP` / `COMSPEC` and friends always reach
the child, and `run_sim` exports `PATH` in MSYS form.

## Demos

| Demo | Config | Wrapper | Tools |
|---|---|---|---|
| `demo/dtsim` | `dt/config/dtsim.config.ts` (VCS + LSF, cases, groups, waive, hooks for every stage in `hooks.ts`) | `demo/dtsim/run.sh <dtsim args>` | fake `vcs` / `simv` / `urg` / `verdi` / `verilator` / `bsub` / `srun` in `dt/bin/` |
| `demo/soc` | `dt/config/dtsim.config.ts` (Verilator: `basic_smoke`, `regfile_smoke`, `sd_sha256`, `tb_mod`, `sv_reg_smoke`; groups `smoke`, `sd`) and `dt/config/vcs.config.ts` (VCS: `basic_smoke`, `regfile_smoke`) | `dt/verilator/run.sh [--regfile\|--sd\|--tb-mod\|--sv-reg]`, `dt/vcs/run.sh [case]` | Verilator 5 + RISC-V GCC; VCS |
| `demo/hbm` | `dt/config/dtsim.config.ts` (VCS + UVM-1.2, six `hbm_*_test` cases, `onGrade` on the UVM summary) | `dt/vcs/run.sh [test ...]` | VCS |

Both VCS configs set `toolOptions.flags` to the flags of the old `run.sh`
scripts: VCS O-2018.09 reads `-xlrm nettype_array` as a source file.

The wrappers call `bun ../../index.ts dtsim` inside the repository and
`dtsim` on `PATH` elsewhere; `DTSIM="..."` overrides both. Each soc case
builds its firmware in the `preSim` hook; the `preCompile` hook applies the
sdspi patch.

## Tests

```bash
bun test test/dtsim/
```

The tests create temporary `<project>/dt/config/` workspaces and put
`demo/dtsim/dt/bin` first on `PATH`. The fake tools simulate compile/sim
success, compile failure, runtime errors, waive regions, urg merge, and
Verilator builds. `DTSIM_MOCK_*` switches only reach them because the test
configs list them in `env.passthrough`.
