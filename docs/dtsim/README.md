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
dtsim run test_bar_basic --random 5       # config-registered seed option
dtsim run test_hello_world --compile-only
dtsim run test_hello_world --sim-only -d nightly
dtsim plan [group]                    # compile-group plan only
dtsim regr [group]                    # execute a regression (default: * = top-level cases)
dtsim list [case] [-L n] [--all]      # case trees (default 2 levels; a case scopes)
dtsim groups
dtsim results --dir dt/simout/regression [--recheck] [--csv]
dtsim env --case test_bar_basic.cosim [--phase compile] [--show-values]
```

Useful flags: `-d <label>` (outputs under `dt/simout/<label>/`),
`-v/--verbose` (stream logs), `--interactive` (UCLI terminal, single case
only), `--plain` (no dashboard). The TypeScript config path comes from
`[dtsim] config` in `autowire.toml` (default `dt/config/dtsim.config.ts`).
dtsim has no built-in seed flags: configs register their own options with
`EnvVarDoc.flags` and construct `WorkspaceOpts.seeds`. 选仿真器、波形、覆盖率不用内置 CLI flag，
由 config 决定（见 [多仿真器](#多仿真器)、[顶层模块与波形](#顶层模块与波形)）。

### Output

stdout 只放计划与结果：`run` 的 Run / Summary 键值表,`regr` 的 Regression / Summary 键值表、计划树、
结果树,`list` 的派生用例树,`groups` 与 `env` 的表格。`results` 打印
Status / Seed dir 表，最后一行 `PASS=n FAIL=n` 保持纯文本供脚本 grep；`--csv`
仍是 `dir,status` 行。进度只写 stderr。颜色跟随 chalk 的终端检测；写入
`regression.txt` / `result.txt` 的文本去掉颜色。

`dtsim regr` 的输出顺序：

1. **Regression 表**：group、仿真器、启动器（如 `lsf (queue normal, -R rusage[mem=4000])`，
   `$DTSIM_TASK_QUEUE` 也列出）、任务数（`3 compiles, 5 sims`）、slot 数、label、输出目录。
2. **计划树**（`dtsim plan` 打印同一份，并写入 `regression.txt`）：每个编译节点
   `compile <名字>  top <top>, wave <...>, N cases` 下面是 `defines` 节点（每行一个宏定义，没有宏时省略）
   和它的 sim 用例；每个 sim 下面每行一个参数：seed（超过 8 个折叠）、UVM test、
   simArgs（plusargs）、`env K=V`。完整的编译命令不进计划，见编译目录里的
   `run_compile`。编译组名字默认是 `build<序号>_<top>`（序号按本次计划的顺序：成员多的在前，
   位数随组数，至少两位），后端的 `buildName` 可以另给；编译目录与集群作业名都是
   `compile_<名字>`，重名加 `-2`、`-3`。

   ```text
   compile build04_tb_chip  top tb_chip, wave off, 1 case
   ├─ defines
   │  ├─ NUM=1
   │  └─ FULL_CHIP=1
   └─ sim chip.rtl
      ├─ seed 1553122393
      └─ test full_chip_test
   ```
3. **运行中（TTY）**：stderr 上每个仍在进行的编译组一棵树，多棵并列：编译节点
   `[spinner|状态] [耗时] compile <名字> <日志> <大小>`，子节点是正在跑的 sim（同样的列），
   其余折叠成 `… N waiting, M done`；超过终端高度时只画前面几组并注明还有几组。
   最后一行是进度条和总计（`<进度条>  compile 1/3  sim 2/5  running 3  00:14`）。
   进度条分两层：每个编译组占 1/N，组内每个 sim 占该段的 1/k，所以一组 sim 全部跑完
   正好盖满这一组的长度。编译层从左到右：已编译蓝 `█`、编译失败灰 `█`（这一段作废）、
   编译中默认前景色 `░`、待编译灰 `░`。sim 层从左边盖在已编译区上：PASS 绿 `█`、
   PASS WITH ERRORS 黄 `█`、其他状态红 `█`，未跑完的地方露出编译层。编译失败而跳过的
   sim 不画。宽度取终端剩余列数，10 到 60 格。
4. 每个 compile / sim 完成或失败时在上方留一行：`<状态> <耗时> <compile|sim 名字>  <日志路径> (大小)`，
   像 `echo` 一样整行写出，dtsim 不插换行：长路径由终端软换行，调整窗口后会重新排版，复制时路径完整；编译失败跳过的 sim 写 `skipped: compile failed`。
   非 TTY（`--plain`、管道、LSF / CI 日志）只有这些行。一个用例有多个 seed 时 sim
   名字带 `seed N`。
5. 全部完成后：结果树（用例 → seed → 状态）和 **Summary 表**：Compiles 一格先 `FAIL`
   再 `OK`，Sims 一格先 `FAIL`（及其他失败状态）再 `PASS WITH ERRORS` / `PASS`，计数为 0
   时显示为灰色；另有总数、耗时、`result.txt` 与 `dresults` 路径。

`dtsim run` 在 stderr 上实时显示当前用例的状态，各列对齐：

```text
▶      start  compile                D:\...\compile.log
── cmd ──────────────────────────────────────────────
verilator --binary --top-module tb_top ...
─────────────────────────────────────────────────────
⠹      00:07  compile                compile.log     3.3 KiB      ← 运行中
              <日志最后一行>
OK     00:07  compile                compile.log     3.9 KiB      ← 结束
PASS   00:00  grade
```

- compile / sim 开始时打印日志路径，以及实际提交的命令：命令夹在两条与终端等宽的分割线之间，
  上分割线内嵌标题 `cmd`，没有左右边框，便于框选复制；程序名粗体青色，`-` / `+` 开头的选项黄色，其余灰色。
- 运行中：`[spinner] [已运行时间] [步骤] <日志> <大小>`，下一行是该日志的最后一行（只读
  文件末尾 4 KB，每 250 ms 刷新）。日志还没落盘
  或 NFS 还没同步时大小显示 `-`。步骤有 `preCompile`、`compile`、`postCompile`、
  `preSim`、`sim`、`postSim`、`grade`、`onResult`（不带 seed，seed 在 Run / Summary
  表里）；hook 步骤只在配置了该阶段的 hook 时出现。
- 结束：`[状态] [耗时] [步骤] <日志> <大小>`，状态粗体着色（`OK` 蓝、`PASS` 绿、
  `PASS WITH ERRORS` 黄、`FAIL` / `exit N` 红）。sim 的状态是退出码，判定看 grade 行。
- 大小用二进制单位：`512 B`、`3.3 KiB`、`1.2 MiB`。

`-v` 在终端上同时显示状态和日志：正在运行的 compile / sim 日志新写入的行实时打印在
面板上方（像 `tail -f`，直接读日志文件，所以 VCS `-l` 这种工具自己写的日志也能
跟），面板留在最下面。

stderr 不是终端（LSF 日志、管道）或 `--plain` 时输出精简：没有 spinner，命令打印
成一行 `$ ...`，只有 compile / sim / grade 的开始与结束行，hook 步骤只在失败时出现；
此时 `-v` 照旧把子进程输出直接写出。`--interactive` 不显示这些。demo 的
`dt/*/run.sh` 不强制 `--plain`，多余参数原样交给 `dtsim run`（如
`./dt/verilator/run.sh -v`）。

所有框线表格(Run / Summary、Regression、`results`、`groups`、`env`)按当前终端宽度排版:
窄了把空余宽度给最宽的列、整表填满终端宽,宽了最宽的列自动折行使整表不超宽(列不窄于表头);非终端(管道/文件)保持自然宽度(100 列封顶、不补空格);框线灰色,表头粗体青色,键值表的键青色,状态粗体着色。

每个回归根目录里生成的 `dresults` 只是转发：用生成它的那个 dtsim（`bun <entry>
dtsim` 或编译版 `autowire dtsim`）执行 `results --dir <该目录>`，参数原样传递
（`--recheck`、`--csv`），输出与 `dtsim results` 相同。`$DTSIM_BIN` 可替换记录的
命令（例如目录搬到另一台机器后）。

## Configuration

Config selection: `[dtsim] config` in `autowire.toml` when it is set, or when
the default `dt/config/dtsim.config.ts` next to the toml exists; otherwise
dtsim searches upward from CWD for `dt/config/dtsim.config.ts`. The file must
live in `<project>/dt/config/` (anything else is an error), and the project is
the parent of its `dt/` directory. Only `autowire dtsim …` and the `dtsim`
entry load the config; `dtsim --help`, `help`, `--version` and `results --dir`
(without `--recheck`) work without one. dtsim reads the registry before
parsing its commands, so `EnvVarDoc.flags` become real Commander options of
run / regr / plan / list / groups / env; a flag sets its variable only when
given on the command line, and a clash with a built-in option is a config
error. `--config` and built-in seed flags are not provided. User configs are
loaded at runtime; the DSL (`index.ts` plus the built-in tools and launchers
it re-exports) is written to `dt/config/.dtsim/dsl/` on every run and config
files import `.dtsim/dsl/index.ts`. Inside this repository the demo configs
import `src/dtsim/dsl/index.ts` directly (same convention as the wishbone
SoT), so DSL edits reach them without a regenerate step; `docs unpack`
rewrites those imports to the `.dtsim/dsl` copy. No symlink is used: Windows
symlinks need extra privileges and Bun does not follow MSYS ones.

- `Workspace(opts)`（静态配置，没有注册的环境变量）或
  `Workspace(regEnv, opts | ((mode) => opts))`：`regEnv` 是 config 注册的环境变量（见下），
  第二个参数是静态 opts 或 `(mode: "run" | "regr") => opts` 的回调。`tools`（非空列表）、
  `task.launcher`、`grader` 都是值（`VcsTool(...)`、`LsfLauncher(...)`、`DefaultGrader(...)`），不是 id。
- **工厂回调**：dtsim 加载时以 mode 调用它，返回完整 `WorkspaceOpts`。config 的逻辑写在这里：
  按 mode 或注册的变量设置 `wave`（例如单跑 dump、回归不 dump）、算 `task.maxSlots`、调整 `tools`
  顺序以强制某个仿真器。注册的 CLI flag 在回调运行前已写进环境变量，所以读 flag 的代码必须在回调里，
  不能放在模块顶层。字段：`tools`、`top`、`wave`、`waveDepth`、`waveScope`、`filelists`、`output`、
  `seeds`、`grader`、`bareDefaults`、`env`、`task`、`hooks`、`groups`、`cases`。
- `Case(name, opts)` / `case.SubCase(suffix, opts)` / `Group(name, ids)`
- List fields (`defines`, `compileArgs`, `simArgs`, `filelists`) append.
  `env` maps merge per key; `grader` is replaced (use `.extend()` to append keywords).
- `bareDefaults` is the lowest-priority case options: the case's own options
  merge on top (lists after it, its scalars win), and derived cases inherit it
  through their parent like any other option. Below it sit the workspace's
  `top` / `wave` / `waveDepth` / `waveScope` defaults.
- `filelists` (workspace or case) are paths relative to `dt/config/`; see
  [Filelists](#filelists).
- Cases are found among a config / case module's exports: a `Case` value, or
  `Case` values inside an exported array, `Set` or `Map`. Other objects are not
  searched.
- `output` moves the output root (default `<project>/dt/simout`), e.g.
  `output: "${workspace}/temp/output"` or `"${SCRATCH}/dtsim"`.
- `uvm` is only interpreted by the VCS backend; other backends ignore it.
- `regEnv`（`Workspace` 第一个参数）登记 config 支持的环境变量，形如
  `{ name, values?, default?, desc?, flags?, set? }`。`dtsim env` 末尾列出
  "Config environment variables" 表；带 `flags`（如 `"--wave"`、`"--random <n>"`）的项同时是
  run / regr / plan / list / groups / env 的 CLI 选项，传入时 dtsim 在调用回调前设置该变量
  （见 demo/dtsim 的 `WAVE` / `SEEDS` / `RANDOM`）。

### Case trees

A top-level case owns its derived cases. `SubCase` returns the new case, so
derivation nests to any depth, and the id is the dotted path:

```ts
export const hello = Case("test_hello_world", { defines: ["NUM=1"] });
const cosim = hello.SubCase("cosim", { compileArgs: ["-debug_access+all"], env: { INPUT: "input.spf" } });
cosim.SubCase("ss", (parent) => ({ env: { INPUT: String(parent.env?.INPUT).replace(".spf", "_ss.spf") } }));
hello.SubCase("timing", { grader: helloGrader.extend({ error: ["re:ERROR:.*timing violation"] }) });
// ids: test_hello_world, test_hello_world.cosim, test_hello_world.cosim.ss, test_hello_world.timing
```

- A case file exports only its top-level cases; dtsim walks `children`.
  Exporting a derived case too is harmless (it registers its root).
- `abstract: true` marks a base used only for derivation, like a C++ virtual
  class: dtsim never runs it, it is left out of `*` and `<base>.*` group hits
  (a base you name in a group expands to its derived cases instead), and naming
  it to run errors. The flag is node-level — derived cases inherit the base's
  options but are concrete themselves.
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
- There is no reserved `all` group. A group argument that contains `*` is a
  pattern itself: `*` = the top-level cases (the former `all`), `**` = every
  depth. `Group(name, members)` takes, in any mix: case objects
  (`Group("cosim", [aCosim, bCosim])`), exact ids, bare base names, and id
  patterns (`*` stays inside one id segment, `**` crosses). An abstract base —
  named directly, matched by a pattern, or passed as an object — expands to the
  concrete cases it fronts, never the base. Members keep their order, patterns
  expand in tree order, duplicates drop. A pattern matching nothing, an unknown
  id, or a case object outside an exported tree fails when the group is used.

A family of small cases that share modifiers is plain TypeScript:

```ts
const withCosim = (c: CaseDef) => {
	const co = c.SubCase("cosim", { compileArgs: ["-ad=${verify}/abc"], env: { INPUT: { value: "input.spf", scope: "sim" } } });
	for (const k of ["ss", "ff"]) co.SubCase(k, { env: { INPUT: { value: `input_${k}.spf`, scope: "sim" } } });
};
// `abstract: true`: a base only derived from, never run (excluded from `*`).
export const base = Case("hello_world_base", { abstract: true, defines: ["NUM=1"] });
for (const [name, opts] of Object.entries({ a: { simArgs: ["+A"] }, b: { simArgs: ["+B"] } }))
	withCosim(base.SubCase(name, opts));
export default Workspace({ tools: [VcsTool()], groups: [Group("cosim_all", ["hello_world_base.*.cosim"])] });
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
- **Paths** (`resolvePath`): `output`, `filelists`, `cases`, and
  whatever a backend or hook passes to `ctx.resolvePath`. dtsim variables
  first, then variables of the shell that started dtsim (`${HOME}`,
  `${SCRATCH}`); the result is made absolute against `dt/config`. An unknown
  name, a bare `$NAME`, or a per-case name in a workspace-level path
  (`${case}` in `output`) is an error naming the path.

(Generating or patching sources before a compile is a `preCompile` hook; see
[Hooks](#hooks).)

## Filelists

dtsim never reads a filelist. `Workspace({ filelists })` lists the ones every
case compiles (default: none); a case's `filelists` (and each derived level,
`byTool`, `bareDefaults`) append to them, so a case extends the workspace set
with its own. Each becomes one `-f <absolute path>` on the compile command.
The compile runs in the compile dir, as the sims run in their seed dirs, so
everything the simulator writes (VCS `csrc` / `simv` / `ucli.key`, Verilator
`obj_dir`) stays under `dt/simout/` and the project root gets no files.
Relative filelist entries therefore resolve against the compile dir: name
sources as `$WORKSPACE/...` (dtsim sets `WORKSPACE` to the project root in
every compile and sim environment), or with your own variable passed through
`env.passthrough`, or absolute. Nested `-f`, `-F` (relative to its own file)
and `$VAR` are the simulator's standard handling. `autowire analysis` also
expands `$WORKSPACE`, so an analysis filelist nested in a simulation one
(demo/soc `-f $WORKSPACE/rtl/soc.f`) uses the same form. Only one check runs
before the tool: every listed filelist exists (after `preCompile`, which may
generate one). Backends get the list as `ctx.filelists`.

## Simulator backends

`tools` lists backend values; the first one whose `probe` passes is selected
(see [多仿真器](#多仿真器)). Built in: `VcsTool(opts)` and `VerilatorTool(opts)`.
A case's `toolOptions` overrides the factory options for that case (for
example Verilator `main`), merged per key; with several tools, put it under
`byTool.<tool>`. The top module and waves are case options, not backend
options (see [顶层模块与波形](#顶层模块与波形)). A custom backend is
`defineTool(...)`:

```ts
const xcelium = defineTool({
	name: "xcelium",
	passthrough: ["PATH", "XCELIUM_HOME"],
	compileErrors: [/Error/],
	simErrors: [/UVM_ERROR/],
	compile: (ctx) => ({ argv: [...], cwd: ctx.dir, log: `${ctx.dir}/compile.log`, logMode: "tee" }),
	simulate: (ctx) => ({ argv: [...], cwd: ctx.dir, log: `${ctx.dir}/sim.log`, logMode: "tee" }),
});
export default Workspace({ tools: [xcelium], ... });
```

Built-in options (factory argument, or case `toolOptions` where noted):

| Backend | Option | Default | Meaning |
|---|---|---|---|
| `VerilatorTool` | `mdir` | `obj_dir` | `-Mdir` inside the compile dir; the executable is `<mdir>/V<top>` |
| `VerilatorTool` | `main` | `true` | `true`: `--binary`. `false`: `--cc --exe --build` for a C++ harness; the `.cpp` files and `--timing` go in `compileArgs` |
| `VerilatorTool` | `command` | `verilator` | the compiler to run, e.g. `verilator_bin` or a full path |
| `VcsTool` | `ntbOpts` | `uvm` | `-ntb_opts` value, e.g. `uvm-1.2`; `""` leaves `-ntb_opts` out |
| `VcsTool` | `flags` | built-in list | a string array (e.g. from `vcsBaseFlags(...)`). Replaces the built-in compile flags (`-xlrm nettype_array -lca -kdb ...`); `-f`, `-Mdir`, `-o`, `-l`, defines and `compileArgs` still follow |
| `VcsTool` | `command` | `vcs` | the compiler to run, e.g. a wrapper or a full path; `process.env.VCS ?? "vcs"` reads an env var |
| `VcsTool` | `casePlusarg` | `"TEST"` | `+<name>=<case id>` on every simv run; `false` sends none (the child always has `$DTSIM_CASE`) |

Both backends compile the case's `top` (VCS `-top`, Verilator `--top-module`).

The engine owns scheduling, grading, and environment assembly. A backend only
supplies argv, log locations, excerpt regexes, optional helper files
(`writeAux`), its `compileKey`, and how it reads `toolOptions`. `name` is part
of the compile key and the per-tool output dir; `interactive` (default
`false`) forwards the first Ctrl+C of `run --interactive` to the child.
`seedArg` is the word `run_sim` appends to carry the seed, with `$SEED` for
the value (`run_sim -s <seed>` overrides it); the default is
`+ntb_random_seed=$SEED` (VCS). `VerilatorTool` sends `+verilator+seed+<seed>`,
with seed 0 sent as 1 because Verilator reads 0 as "pick a random seed"; a
C++ harness must hand argv to `contextp->commandArgs()` for it to apply.
The context carries the case's `top`, `wave` and `cov` (`ctx.caseOpts.top`,
`ctx.caseOpts.wave` = `{ enabled, depth, scope }`, `ctx.caseOpts.cov` =
`{ enabled, metrics }`). A backend that collects coverage also supplies
`coverage: { db(dir), merge(ctx), mergeAll?(ctx) }`: where a build's database
is and the argv of its per-build and regression-wide merge, which dtsim writes
as scripts and never runs (see [覆盖率](#覆盖率)); without it a case's `cov` is
ignored and the Run / Regression tables show `off (<tool> collects no coverage)`.

### Base flags

`vcsBaseFlags(opts)` and `verilatorBaseFlags(opts)` return a portable compile
baseline a config spreads instead of listing every flag. SystemVerilog is
mandatory (`-sverilog` / `--sv`) and VCS is always `-full64`; the options cover
timescale, jobs and debug access, and `add` appends project flags, so one call
is base-plus-overlay:

```ts
VcsTool({ flags: [...vcsBaseFlags({ timescale: "1ns/1ps", jobs: 8 }), "+notimingcheck"] })
// Verilator reads flags from a case's compileArgs (or byTool.verilator):
compileArgs: [...verilatorBaseFlags({ timing: true, jobs: 8 }), "-Wno-WIDTHEXPAND"]
```

`vcsBaseFlags` → `-full64 -sverilog` plus `-kdb`（默认开，`kdb: false` 可关）、
`-timescale=`、`-j<jobs>`、可选 `debugaccess: "all" | "pp" | "r" | "w" | "f" | "drivers"`
→ `-debug_access+<level>`。`verilatorBaseFlags` → `--sv` plus `--timing`、`--timescale`、
`-j <jobs>`。用展开把返回值传给 `VcsTool({ flags })` 或 case 的 `compileArgs`。
波形开启时 VCS 后端自己补 `-debug_access+all`（flags 里没有 `-debug_acc*` 时）和 `-kdb`（`run_verdi` 需要）。

### 多仿真器

`tools: [VerilatorTool(), VcsTool(...)]` 配几个后端。每个后端有 `probe`（需在 PATH 上的
可执行文件，VCS→`vcs`、Verilator→`verilator`），dtsim 并发探测、按 `tools` 顺序自动选中
第一个可用的（没有 `--tool` / `$DTSIM_TOOL`）。要强制某个后端，在 config 工厂回调里调整
`tools` 顺序或过滤（例如按 `SIM_TOOL` 环境变量把某个提到最前）。

- **Case `tools: ["verilator"]`**：该用例只能跑在这些仿真器上（派生用例继承，
  `bareDefaults.tools` 是裸顶层用例的缺省）。`run` / `env` 选了不支持的仿真器直接报错；
  `regr` / `plan` 跳过并打印 `Skipped (not for vcs): ...`；一组里没有可跑的用例时
  `regr` 报错；`groups` 列出每组可跑与跳过的数量；`list` 显示 `tools ...`。
- **`byTool: { vcs: {...}, verilator: {...} }`**：选中某个仿真器时，在这一层的选项之上
  再合并对应的那份（列表追加、map 合并、标量覆盖，和派生同样的规则），可写
  `filelists`、`compileArgs`、`grader`、`toolOptions` 等，不能再写 `tools` / `byTool`。
  每一层（根、各级派生、`bareDefaults`）都可以有自己的 `byTool`。键名必须是配置里的
  仿真器名。
- **输出**：配置了多个仿真器时输出放到 `dt/simout/<tool>/`（`<tool>/<case>/`、
  `<tool>/regression/`），切换仿真器不会互相覆盖。只有一个时仍是 `dt/simout/`。
  回归目录的 `dresults` 记下该次的仿真器，`--recheck` 用它的 grader。

demo/soc 用一份配置跑 Verilator（C++ harness）与 VCS（纯 SV aw-tb-mod dump），两边的顶层都是 `tb_top`：差异在
`basic_smoke` / `regfile_smoke` 的 `byTool.verilator` 与 `bareDefaults.byTool`，
`sd_sha256` / `tb_mod` / `sv_reg_smoke` 写 `tools: ["verilator"]`。

### 顶层模块与波形

顶层模块和波形是 Workspace 默认值加 case 继承，规则和其他标量选项一样（派生用例继承父用例，
自己写的值覆盖）：

| 选项 | Workspace 默认 | 含义 |
|---|---|---|
| `top` | `"tb_top"` | 顶层模块：VCS `-top`、Verilator `--top-module`，也是 `run_verdi` 的 `-top` |
| `wave` | `false` | 波形开关 |
| `waveDepth` | `0`（全部层级） | dump 深度 |
| `waveScope` | 该 case 的 `top` | dump 范围 |

常规 bench 只有一个 `tb_top`，什么都不用写。UVM 等复杂场景里某些 case 用另一个顶层时，
在 case（或抽象基 case）上写 `top: "tb_chip"`，派生用例跟着继承；case 只写 `waveScope` /
`waveDepth` 时开关仍沿用 workspace 的 `wave`。`top` 进入编译 key，顶层不同的用例各自编译；
`wave` 打开时 `waveDepth` / `waveScope` 也进入编译 key（dump 是编译进去的），关闭时不影响分组。

- VCS：wave 开启时编译目录写 `dump.tcl`（`fsdbDumpvars <depth> <scope> "+all"`），simv 用
  `-ucli -i dump.tcl` 运行，每个 seed 写 `<case id>.fsdb` 和 `run_verdi`；`dump.tcl` 用
  `$env(output_dir)/$env(DTSIM_CASE).fsdb` 定位波形，`run_verdi` 用同一对变量拼 `-ssf`，
  所以同一编译组的每个 case 都有自己的文件名；flags 里没有 debug access
  时补 `-debug_access+all`，没有 `-kdb` 时补 `-kdb`。关闭时不写 `dump.tcl`，simv 不加 `-ucli`
  （`--interactive` 只加 `-ucli`）。
- Verilator：wave 开启时加 `--trace-fst` 并编译一个绑定到 `top` 的 `dtsim_wave.sv`
  （`$dumpvars(depth, scope)`），仿真参数 `+DTSIM_WAVE_FILE=<seed dir>/<case id>.fst`
  指定输出，每个 seed 写 `<case id>.fst`；C++ harness 需调用
  `VerilatedContext::traceEverOn(true)`。
- 让用户从命令行开波形：注册 `{ name: "WAVE", flags: "--wave" }`，回调里写
  `wave: process.env.WAVE === "1"`（demo/hbm、demo/soc）。

### 覆盖率

覆盖率和波形一样是 Workspace 默认值加 case 继承（`bareDefaults` / `byTool` 也可写），不读环境变量：

| 选项 | 在哪写 | 默认 | 含义 |
|---|---|---|---|
| `cov` | Workspace / Case | `false` | 覆盖率开关 |
| `covMetrics` | Workspace / Case | `"line+cond+fsm+tgl+branch+assert"` | 指标（VCS `-cm` 语法） |

`cov` 打开时它和 `covMetrics` 进入编译 key（覆盖率是编译进去的），所以开与不开、指标不同的用例各自编译；
关闭时不影响分组。只有实现了 `coverage` 的后端会收集：目前是 VCS，Verilator 忽略 `cov`，
Run / Regression 表的 `Coverage` 行写明 `off (verilator collects no coverage)`。

dtsim 不合并覆盖率。结束时（`run` 与 `regr`）打印 **Coverage** 表：每个编译组的覆盖率数据库位置、
合并脚本的位置，以及 cluster 启动器下的提交脚本名；由用户自己决定合并哪些、何时合并。

VCS 的做法：

- 编译和仿真加 `-cm <metrics>`，数据写进编译目录的 `simv.vdb`，每个 seed 用 `-cm_name <case>_<seed>`。
- 编译目录写 `run_verdi_cov`（`verdi -cov`，有 `merge.vdb` 时打开它，否则打开 `simv.vdb`）。
- 每个开了覆盖率、编译成功的编译组写 `run_cov_merge`（`urg -dir simv.vdb -dbname merge.vdb
  -report urgReport`），`run` 也写一份在用例的编译目录。
- 回归目录写 `run_cov_merge_all`：一条 `urg` 合并所有覆盖率编译组到 `<regression>/merge.vdb` 与
  `urgReport`，额外参数原样传给 urg。define 不同的编译组合并不一定有意义。
- 这些脚本都带编译阶段的环境（exports），和 `run_verdi` 一样，cluster 启动器在旁边写提交脚本：
  `bsub_verdi_cov` / `bsub_cov_merge` / `bsub_cov_merge_all`（Slurm 为 `srun_*`），local 不写。

命令行开覆盖率：注册 `{ name: "COV", flags: "--cov" }`，回调里写 `cov: process.env.COV === "1"`
（demo/dtsim、demo/hbm）。

### Which cases share a build

In a regression, cases with equal compile keys share one compile directory.
dtsim computes a generic key (tool name, `top`, `wave` with its depth and scope
when on, defines as a set, `compileArgs` in order, compile-scope `env`,
`filelists` in order) and hands it to the backend's
`compileKey(c, base)`, which returns the final key: `base` unchanged, `base`
plus what else its build depends on, or a key of its own when the simulator
knows better (for example a backend whose defines are runtime parameters can
leave them out). `sim`-scoped env, `simArgs`, `uvm` and seeds never split a
build unless the backend puts them in the key. `dtsim plan` prints the groups.

Compile grouping is independent of the case tree: derivation only inherits
options. Whether a derived case reuses its parent's build is decided purely by
the key, so a subcase that adds a define compiles separately, and two unrelated
cases with equal keys share one build.

A build is named `build<NN>_<top>` by default: its position in this plan
(larger groups first, at least two digits) and its top module, so a build
never reads as one of its cases. A backend may supply `buildName(c)` instead.
The directory and the cluster job name are `compile_<name>`, with unsafe
characters turned into `_` and `-2`, `-3` added to repeats.

| Backend | Key |
|---|---|
| `VcsTool` | base + `ntbOpts` + compile `flags` |
| `VerilatorTool` | base + `mdir` + `main` |

## Launchers

A launcher decides how a compile or sim command runs; the scheduler decides
when (`task.maxSlots`, `task.maxCompiles` never reach the launcher).
`task.launcher` is one launcher (default `LocalLauncher()`), or a **probe list**
tried left to right: the first launcher whose `probe` executables are all on
PATH wins, and the probes run concurrently so a slow filesystem does not
serialise. A single launcher is an explicit choice and is not probed. Built in:

| Launcher | Wraps as | `passthrough` |
|---|---|---|
| `LocalLauncher()` | the command itself | none |
| `LsfLauncher({ queue, args })` | `bsub -I -J <job> [-q <queue>] <args> <cmd>` | `LSF_*`, `LSB_*` |
| `SlurmLauncher({ queue, args })` | `srun --pty [--qos <queue>] --job-name <job> <args> <cmd>` | `SLURM_*` |

`args` is a string array, e.g. `["-R", "rusage[mem=8000]"]` or
`["--partition", "eda"]`. `LsfLauncher` probes `bsub` and writes `bsub_*`
wrappers; `SlurmLauncher` probes `srun` and writes `srun_*`; `LocalLauncher`
has neither, so it is always available and writes no wrapper. A site wrapper
is `defineLauncher(...)`:

```ts
// Blocks until the job ends and returns its exit code.
const grid = defineLauncher({
	name: "grid",
	passthrough: ["GRID_*"],
	probe: ["grid_run"], // on PATH => usable in a probe list
	scriptPrefix: "gjob", // writes gjob_sim / gjob_compile / gjob_verdi backups
	wrap: (argv, ctx) => ["grid_run", "--name", ctx.jobName, "--pool", ctx.queue || "eda", "--", ...argv],
});
export default Workspace({ tools: [VcsTool()], task: { launcher: [grid, LocalLauncher()], maxSlots: 16, maxCompiles: 4 }, ... });
```

`wrap(argv, ctx)` receives the already-built tool argv (`bash <seed dir>/run_sim`
for a sim) and returns the argv to spawn; the wrapped command must exit with
the job's exit code (interactive / blocking submission). `ctx` carries
`phase`, `jobName` (`compile_<base>` or `<case>_<seed>`), `caseId`, `seed`,
`cwd`, `queue` and `interactive` (`run --interactive`). The launcher's
`passthrough` names are copied into the child environment like a backend's.
An optional `summary` string (built-ins: queue and args) is shown next to
the launcher name in the regression header.

`DTSIM_TASK_TYPE=local|lsf|slurm` forces that launcher (a matching list entry,
else the built-in with default options) and skips the probe; any other value
fails before an output directory is created.
`DTSIM_TASK_QUEUE` reaches the launcher as `ctx.queue` and wins over the
built-ins' own `queue`; it is `""` when unset.

Next to `run_sim`, `run_compile` and (VCS) `run_verdi`, a cluster launcher also
writes a submit wrapper — `bsub_*` for LSF, `srun_*` for Slurm — that submits
that script through the launcher (e.g. `./bsub_sim` runs `bsub … bash run_sim`). They are backups to
resubmit by hand; dtsim submits inline and does not run them. `bsub_verdi` and
`srun_verdi` end in `&` so launching the GUI returns immediately; compile and
sim wrappers still wait for their jobs. `LocalLauncher` writes none.

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
Each compile or sim step starts its phase log empty, so a rerun in the same
directory is graded on its own output only.
Every compile directory has `run_compile`: the compile env, the tool command,
and as a comment the command as submitted through the launcher (`bsub ...`).
It is a record to read or rerun by hand; dtsim runs the full command itself.
Every seed directory has `run_sim`, `.result`, `git_rev` (revision of the
repo holding `dt/config`), and, for any non-clean result, `error.txt` with
the grader's report rows and a bounded excerpt (tool error lines, the lines
the grader highlights, the last lines when few). Re-grading is
`dtsim results --dir <dir> --recheck` (or `dresults --recheck`); no per-seed
checker script is written. A tool that cannot be started at all reports
`dtsim: cannot start <tool>` on stderr.

Logs are never read whole: grading and excerpts stream the file in a worker
thread (`scanLog`), so a log of several hundred MB costs one chunk of memory
and does not stall the progress display or other seeds (308 MB: about 1.7 s,
no growth in dtsim's own memory).

## Graders

A grader decides the status of one seed after `postSim`, and `results
--recheck` runs the same one. Graders are values: `Workspace({ grader })` sets
the default (omitted: `DefaultGrader()`), a case sets `grader` and its derived
cases inherit it, unless a derived case sets its own; `bareDefaults.grader`
sits below every case, then the workspace's.

`DefaultGrader(opts)` is the built-in:

| Option | Meaning |
|---|---|
| `pass` | a line matching one of these marks a finished run; default `["TEST PASSED"]` |
| `error` | a kept (not waived) line matching one: `PASS WITH ERRORS` |
| `expect` | each must match somewhere, else `PASS WITH ERRORS` |
| `waive` | `WaiveRule(name, pattern)` entries, switched on by `DSIM_WAIVE_ON <names>` |
| `uvm` | default `true`: a `UVM Report Summary` also marks a finished run, and any kept `UVM_ERROR` / `UVM_FATAL` message (not the summary's count lines) is `FAIL` |

Keywords (`pass`, `error`, `expect`, waive patterns) are substrings, or `re:`
regexes (an invalid regex is a substring). Lines are read without their line
ending, so `re:^TEST PASSED$` also matches CRLF logs. No finished marker is
`FAIL` with note `not finished` and a `Finished` row naming the keywords that
were looked for. Waive markers keep their dsim spelling:
`DSIM_WAIVE_BEGIN [pattern]` .. `DSIM_WAIVE_END` waives matching lines (all
lines without a pattern; unclosed runs to EOF), `DSIM_WAIVE_ON` /
`DSIM_WAIVE_OFF` switch named rules; marker lines never count. Waived UVM
messages do not fail. `grader.extend(opts)` returns a new grader with the
lists and waive rules appended and `uvm` overridden:

```ts
const grader = DefaultGrader({ waive: [WaiveRule("boot", "Error: timeout in boot phase")] });
const helloGrader = grader.extend({ error: ["Error:"], expect: ["Keyword"] });
export const hello = Case("test_hello_world", { grader: helloGrader });
export default Workspace({ ..., grader });
```

A custom grader is `defineGrader({ name, grade(ctx) })`. `grade` returns a
status (`Status.Pass`, `Status.PassWithErrors`, `Status.Fail`,
`Status.NoSimLog`, or the same strings) or `{ status, note?, details?,
highlight? }`: `note` is shown next to the status in `run` and `regr`,
`details` (`[label, value]` rows) in the `run` summary and `error.txt`,
`highlight` (log lines) in the `error.txt` excerpt. `ctx` has the
`HookContext` fields below except `stage` / `status`, plus `seed`. Compose by
calling another grader:

```ts
const signoff = defineGrader({
	name: "signoff",
	grade: async (ctx) => {
		const report = await scanLog(ctx.log, (pattern) => {
			let hits = 0;
			return { push: (line) => { if (line.includes(pattern)) hits += 1; }, finish: () => hits };
		}, "SCOREBOARD MISMATCH");
		return report > 0 ? { status: "FAIL", note: `${report} mismatches` } : helloGrader.grade(ctx);
	},
});
```

For large logs use `scanLog(path, makeScanner, arg)` (runs `makeScanner(arg)`
over the lines in a worker; `makeScanner` is sent as source, so it may use
only its own body, `arg` and globals) or `streamLines(path)` (an async line
iterator in the dtsim thread). A missing log is `NO SIM LOG` before any
grader runs. A throw or an unknown status grades `FAIL` with the reason in
`<seed dir>/grade.log`, which also receives `ctx.sh` output
(`DTSIM_GRADER=<name>` is set).

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
export default Workspace({ ..., hooks: { preCompile: [spiceDeck], preSim: firmware } });
```

Every stage gets the same `HookContext`:

| Field | Meaning |
|---|---|
| `stage` | `preCompile` `postCompile` `preSim` `postSim` `onResult` |
| `caseId`, `baseId` | case id and its top-level case |
| `dir` | compile dir (compile stages) or seed dir (sim stages); equals `${output_dir}` |
| `seed` | sim stages only |
| `log` | compile log (compile stages) or sim log (sim stages) |
| `status` | onResult only: the final status |
| `verify`, `workspace`, `tool` | `dt/config`, project root, backend id |
| `caseOpts` | merged `defines`, `compileArgs`, `simArgs`, `env`, `uvm`, `toolOptions`, `filelists`, placeholders intact |
| `env` | the isolated environment of this phase's tool command |
| `expand(text)`, `resolvePath(text)` | see [Placeholders and paths](#placeholders-and-paths) |
| `sh(cmd, { timeoutSec? })` | runs `bash -c cmd` in `dir` with `env` (plus `DTSIM_HOOK=<stage>`); output appended to `<dir>/hook-<stage>.log`; returns stdout; a non-zero exit throws |

A throw (or rejected promise) fails that compile or seed: the stack is
appended to `hook-<stage>.log` and `error.txt` says `phase: hook`. The rest
of that stage's list is skipped, except `onResult`, whose errors are only
logged. The result verdict is not a hook stage; see [Graders](#graders). Hooks run in the
dtsim process, so `process.env` is dtsim's own environment; `ctx.env` is what
the tool sees. In a regression, compile stages run once per compile group
and `ctx` describes the group's first case.

| Stage | Runs | Typical use | Demo |
|---|---|---|---|
| `preCompile` | per compile dir, before the filelists are checked and the tool runs | generate or patch sources (or a filelist), prebuild a C model | soc: sdspi patch via `ctx.sh`; dtsim: SPICE deck, `gen_stamp.svh` |
| `postCompile` | after the compile tool exits | compile-log policy, archive the build | dtsim: fail on more than `DTSIM_DEMO_MAX_WARN` warnings |
| `preSim` | per seed, before `run_sim` | per-seed input: firmware, memory image, stimulus | soc: firmware + SD image; dtsim: `stim.hex` from the seed |
| `postSim` | per seed, before grading | golden-model compare (throw to fail), metrics, wave conversion | dtsim: `metrics.json` |
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
| `demo/soc` | `dt/config/dtsim.config.ts`, `tools: [VerilatorTool(), VcsTool(...)]`: `basic_smoke`, `regfile_smoke` on both (`byTool`), `sd_sha256`, `tb_mod`, `sv_reg_smoke` Verilator-only (`tools`); groups `smoke`, `sd` | `dt/verilator/run.sh [--regfile\|--sd\|--tb-mod\|--sv-reg]`, `dt/vcs/run.sh [case]` (`SIM_TOOL=vcs`) | Verilator 5 + RISC-V GCC; VCS |
| `demo/hbm` | `dt/config/dtsim.config.ts` (VCS + UVM-1.2, six `hbm_*_test` cases, graded by the default grader's UVM report check) | `dt/vcs/run.sh [test ...]` | VCS |

Both VCS configs pass `VcsTool({ flags })` with the flags of the old `run.sh`
scripts: VCS O-2018.09 reads `-xlrm nettype_array` as a source file.

`demo/hbm` needs a g++ older than 10 for VCS O-2018.09: its UVM DPI source
has curly quotes in a skipped `#error`, which newer g++ rejects (the
pre-dtsim `run.sh` fails the same way). `VCS_GCC_DIR=/usr/bin dt/vcs/run.sh`
passes `-cc` / `-cpp` / `-ld` from that directory.

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
