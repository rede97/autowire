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
      hooks/               hook scripts
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
every run and config files import it from there.

- `Workspace({ tool, filelist, tools, toolOptions, bareDefaults, env, task, waive, patches, hooks, groups, cases })`
- `Case(name, opts)` / `Subcase(base, suffix, opts)` / `Group(name, ids)` / `Hook(path, opts)`
- List fields (`defines`, `compileArgs`, `simArgs`, `grade.*`) append.
  `env` maps merge per key. Bare names get `bareDefaults`; explicit subcases do not.
- `filelist` (workspace or case) is a path relative to `dt/config/`. A case
  filelist replaces the workspace one and splits the compile group.
- `uvm` is only interpreted by the VCS backend; other backends ignore it.
- Placeholders in args, env values, filelists and patches: `${workspace}`
  (project root), `${verify}` (`dt/config`), `${output_dir}`, `${case}`,
  `${seed}`, `${tool}`.

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
`.result`, `git_rev` (revision of the repo holding `dt/config`), and, for any
non-clean result, `error.txt` with a bounded excerpt. A tool that cannot be
started at all reports `dtsim: cannot start <tool>` on stderr.
Hooks (`preCompile`, `postCompile`, `preSim`, `postSim`, `onGrade`, `onResult`)
are script files relative to `dt/config/`; `onGrade` replaces the built-in
grader and is honored by `results --recheck`.

## Windows (MSYS2 UCRT64)

Run dtsim from a UCRT64 shell (`docs/dev/windows-msys2.md`). Windows cannot
exec shebang scripts, so dtsim runs an extensionless `#!` command (the UCRT64
`verilator` perl wrapper, hook scripts, the demo fake tools) through the named
interpreter found on the child `PATH`. Environment names match
case-insensitively, `SYSTEMROOT` / `TEMP` / `COMSPEC` and friends always reach
the child, and `run_sim` exports `PATH` in MSYS form.

## Demos

| Demo | Config | Wrapper | Tools |
|---|---|---|---|
| `demo/dtsim` | `dt/config/dtsim.config.ts` (VCS + LSF, cases, groups, waive, patches) | `demo/dtsim/run.sh <dtsim args>` | fake `vcs` / `simv` / `urg` / `verdi` / `verilator` / `bsub` / `srun` in `dt/bin/` |
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
