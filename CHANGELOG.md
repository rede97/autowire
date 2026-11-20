# Changelog

版本号和 GitHub Release 说明以本文件最上面一条 `## [x.y.z] - YYYY-MM-DD` 为准。`package.json` 的 `version` 必须和它相同。`hdxml` 是独立项目（[`rede97/hdxml`](https://github.com/rede97/hdxml)），用自己的版本，本文件只记录 `hdxml-version.txt` 钉的版本变化。

## [2.9.0] - 2026-11-20

- **表格填满终端宽度**:所有框线表格(单条用例的 Run / Summary、回归的 Regression / Summary、`results`、`groups`、`env`)像 `cmd` 分割线一样按当前终端宽度排版——窄了把空余宽度加给最宽的列、整表填满终端宽;宽了最宽的列自动折行使整表不超宽(列不窄于表头)。非终端(管道/文件)保持内容自然宽度(100 列封顶、不补空格)。此前固定 100/120 列,窄终端会被软换行而错位、宽终端又填不满。单步日志行(`▶ start <phase> <log>`)仍是普通一行,长路径由终端换行。
- **日志路径改为纯文本整行**:回归里每个 compile / sim 完成后的行,日志路径和大小直接接在 `<状态> <耗时> <名字>` 同一行末尾(`OK 00:01 compile sd_sha256  <path> (147.1 KiB)`),不再用 `└─` 另起一行;长路径交给终端换行,与单步日志行 `▶ start <phase> <log>` 一致。
- **作业后端探测与顺序 fallback**:`task.launcher` 可以给一个列表,dtsim 并发探测每个 launcher 的提交工具是否在 PATH 上(LSF→`bsub`、Slurm→`srun`、local 永远可用),按列表顺序选中第一个有效的(`[LsfLauncher(), SlurmLauncher(), LocalLauncher()]`)。单个 launcher 仍是显式选择、不探测;`DTSIM_TASK_TYPE` 可强制某一个并跳过探测。并发探测避免慢文件系统上逐个串行拖慢启动。
- **作业后端生成提交备份脚本**:选中的 cluster launcher 在 `run_sim` / `run_compile` / VCS `run_verdi` 旁各写一份提交脚本(LSF `bjob_*`、Slurm `srun_*`,内容 `<bsub|srun> … bash <run 脚本>`)供手动重投;dtsim 仍内联提交、不执行这些备份,local 不生成(bypass)。`defineLauncher` 新增可选 `probe`(需在 PATH 上的可执行文件)和 `scriptPrefix`(备份脚本前缀)。
- **破坏性:`Workspace(regEnv, opts | ((mode) => opts)` 回调式配置**:`Workspace` 现在第一个参数是 config 注册的环境变量(见下),第二个参数是静态 opts 或一个 `(mode: "run"|"regr") => opts` 的回调。config 的全部逻辑(按 mode 默认 `DTSIM_WAVE`、算 slots、选 tool)都写在这个回调里,dtsim 在加载时以 mode 调用它。**`onResolve` 已移除**(此能力由该回调取代)。单参数 `Workspace({...})` 仍兼容。
- **破坏性:工具选择交给 config + 自动 fallback**:删除 `--tool` 和 `$DTSIM_TOOL` 选择入口。每个 `SimTool` 新增 `probe`(需在 PATH 上的可执行文件,VCS→`vcs`、Verilator→`verilator`),dtsim 并发探测、按 `tools` 顺序自动选中第一个可用的;要强制某个 tool,config 在回调里调整 `tools` 顺序或过滤。
- **破坏性:删除 `--wave` / `--cov` 等运行开关 flag**:CLI 不再注入 `DTSIM_WAVE` / `DTSIM_COV`。wave / coverage 完全由 config 决定(在回调里设置 `DTSIM_WAVE` 等),backend 在用时读取。`--wave-depth/--wave-top/--cov-metrics/--cov-merge` 一并移除。
- **环境变量注册表**:`Workspace` 第一个参数登记 config 支持的环境变量(`{ name, values?, default?, desc? }`),`dtsim env` 末尾列出"Config environment variables"表,便于发现项目级旋钮(如 `WAVE`/`JOBS`/`DTSIM_SLOTS`)。
- **DSL 默认 flags 构造器**:新增 `vcsBaseFlags(opts)` / `verilatorBaseFlags(opts)`,返回可移植的编译基线,config 展开后再追加项目特有项,不必从头写一遍。**SystemVerilog 强制**(`-sverilog` / `--sv`)、**VCS 强制 `-full64`**(均不可关);`timescale`/`jobs` 为辅助参数,`kdb`(默认开,写 simv.daidir 供 `run_verdi`)、`debugaccess`(可选 string 枚举 `"all"|"pp"|"r"|"w"|"f"|"drivers"` → `-debug_access+<level>`)、`add` 追加。`--wave` 无需 flag(dtsim 自绑 dump,wave 打开且未显式设置 debug access 时自动加 `-debug_access+all`)。
- **`maxSlots` / `maxCompiles` 支持回调**:`task.maxSlots` / `maxCompiles` 除数字外可写 `(ctx: { tool, launcher }) => number`,在 tool 和 launcher 解析之后求值——config 据此按真正选中的 launcher 定并发数(local 无 license 计量→1,farm→jobs),不必自己 `onPath` 探测环境。

## [2.8.6] - 2026-11-19

- **`cmd` 面板改为上下分割线**：TTY 下提交的命令不再放进带左右竖线的方框，而是夹在两条与终端等宽的分割线之间（顶行内嵌标题 `cmd`），没有左右边框，便于直接框选复制整条命令。

## [2.8.5] - 2026-11-19

- **`dtsim list` 默认展开 2 层**：`list` 不再一次展开到底，默认只显示 2 层（根加直接子用例）。`-L <n>` / `--depth <n>` 指定展开层数，`-a` / `--all` 全部展开。`list <case>` 只列出该用例（或基）及其子树，层数规则相同。

## [2.8.4] - 2026-11-19

- **抽象基用例**：Case 新增 `abstract: true`（像 C++ 虚类，只用于派生）。dtsim 不运行它：`run` / `env` 报错，`*` 与 `<base>.*` 等分组模式不收它，分组里直接写基名或用模式命中基时，展开成它派生出的具体用例。该标记是节点级的，派生用例继承基的选项但本身是具体用例，不继承 `abstract`。
- **分组去掉保留字 `all`**：不再有特殊的 `all` 组。分组参数本身可以是模式：`*` = 顶层用例（原 `all` 的含义），`**` = 任意层级；`regr` / `plan` 默认组改为 `*`。`groups` 表的首行也改成 `*`。`Group(name, members)` 的成员可混用用例对象、精确 id、基名、以及 `*` / `**` 模式。
- **文档/demo**：`docs/dtsim/README.md`、`help/dtsim.txt` 补充 `abstract`、`*` / `**` 分组、以及“派生只继承选项、是否共享编译完全由 compileKey 决定（与父子关系正交）”；`demo/dtsim` 用抽象基 `chip`（`chip.rtl` / `chip.gate`）演示。

## [2.8.3] - 2026-11-19

- **dtsim 不再解析 filelist**（#3）：`Workspace({ filelist })` / Case `filelist` 改为 `filelists: [...]`，按列表追加（workspace 的在前，然后是 `bareDefaults`、根用例、各级派生，每层之后是该层的 `byTool`），workspace 不再默认 `file.lst`。每个 filelist 原样作为 `-f <绝对路径>` 交给仿真器，编译在项目根目录下运行：相对路径、嵌套 `-f`、`-F`（相对文件自身目录）与 `$VAR` 都由仿真器按标准处理；展开器与编译目录里的 `filelist.f` 删除，启动前只检查列出的 filelist 存在（在 `preCompile` 之后）。VCS 加 `-Mdir=<编译目录>/csrc -o <编译目录>/simv`，Verilator 的 `-Mdir` 改为编译目录下的绝对路径，项目根不落文件；`run_verdi` 先 cd 到项目根。`ToolContext.filelist` 改为 `filelists`，新增 `interactive`。
- **bareDefaults 进入派生链**（#5）：bareDefaults 成为每个顶层用例的最低优先级底座，用例自己的选项合并在上面（列表在后、标量覆盖），派生用例经父用例继承；原来只给裸顶层用例、且其标量会反盖用例自己的值。用例模块导出的数组、`Set`、`Map` 里的 `Case` 也会登记。
- **DefaultGrader**（#4）：`pass` 也支持 `re:`；日志行去掉行尾 `\r`，CRLF 日志上的锚点正则可用；没有结束标记时结果带 note `not finished` 和 `Finished` 一行（列出查找的关键字）。
- **VcsTool**（#6）：新增 `top`（`-top`，同时是 `--wave` 默认范围与 `run_verdi -t` 的 `-top`，去掉写死的 `tb_top`）、`command`（编译器命令，默认 `vcs`）、`casePlusarg`（默认 `"TEST"`，`false` 不传）；没有 `--wave` 时不写 `dump.tcl`、simv 不加 `-ucli`（`--interactive` 只加 `-ucli`）。
- **VerilatorTool**：`top` 不再默认 `"top"`，不设时不传 `--top-module`，由 Verilator 找唯一的 top；可执行文件用 `-o` 固定为 `<mdir>/V<top>`（无 top 时 `Vsim`）；`--wave` 需要 `top`，缺少时报错。新增 `command`（默认 `verilator`）。
- demo/soc：filelist 移到各用例（`harness.f` / `tb_mod.f` / `sv_reg.f`，VCS 为 `bareDefaults.byTool.vcs.filelists`），VCS 用 `VcsTool({ top: "tb_soc" })`。

## [2.8.2] - 2026-11-19

- **dtsim 多仿真器**：`Workspace({ tool })` 改为 `Workspace({ tools: [...] })`（非空列表，第一个是默认，名字不能重复）；`--tool <name>`（`$DTSIM_TOOL`）在 `run` / `regr` / `plan` / `list` / `groups` / `env` / `results` 上选择仿真器，不在 `tools` 里时加载即报错。Case 新增 `tools: ["verilator"]`（只在这些仿真器上跑，派生用例继承；`run` / `env` 报错，`regr` / `plan` 跳过并打印 `Skipped (not for <tool>): ...`，`groups` 显示每组可跑 / 跳过数）与 `byTool: { <tool>: opts }`（选中该仿真器时在这一层之上合并，`bareDefaults` 同样支持）。配置了多个仿真器时输出改到 `dt/simout/<tool>/`；回归目录的 `dresults` 记下仿真器供 `--recheck` 使用。
- **运行开关改为环境变量**：`--wave` / `--wave-depth` / `--wave-top` / `--cov` / `--cov-metrics` / `--no-cov-merge` 只负责在加载配置前设置 `DTSIM_WAVE` / `DTSIM_WAVE_DEPTH` / `DTSIM_WAVE_TOP` / `DTSIM_COV` / `DTSIM_COV_METRICS` / `DTSIM_COV_MERGE`；后端在构造时用新导出的 `waveFromEnv()` / `covFromEnv()` 读取，`ToolContext.wave` / `ToolContext.cov` 删除。这些变量传给 compile / sim 子进程并记在 `run_compile` / `run_sim` 里。
- **波形默认关**：`--no-wave` 删除，`--wave` 打开；`--wave-top` 不再写死 `tb_top`（VCS 不给时 dump 整个设计，Verilator 用后端的 `top`）。Verilator 后端支持波形：编译加 `--trace-fst` 并绑定生成的 `dtsim_wave` 模块，每个 seed 目录写 `wave.fst`，TB 不用改；C++ harness 需调用 `traceEverOn(true)`。Run / Regression 表新增 `Wave` 行。
- demo/soc 的 `vcs.config.ts` 并入 `dtsim.config.ts`（`tools: [VerilatorTool(), VcsTool(...)]`，`basic_smoke` / `regfile_smoke` 两边都跑，其余三个只在 Verilator），`dt/vcs/run.sh` 改为 `--tool vcs`；`tb_main.cpp` 在 `VM_TRACE` 下开启 trace。demo/hbm 去掉 `--no-wave`。

## [2.8.1] - 2026-11-19

- **`dtsim regr` 进度条**：TTY 上实时面板的最后一行改为 `<进度条>  compile x/N  sim y/M  running n  MM:SS`（原来的总计行从树上方移到这里）。进度条分两层：每个编译组占 1/N，组内每个 sim 占 1/(N·k)，一组 sim 全部跑完正好盖满该组长度。编译层从左到右为已编译蓝 `█`、编译失败灰 `█`（这一段作废，跳过的 sim 不画）、编译中 `░`（默认前景色）、待编译灰 `░`；跑完的 sim 从左边盖在已编译区上：PASS 绿、PASS WITH ERRORS 黄、其他状态红（`█`），未跑完处露出编译层。宽度取终端剩余列数，10 到 60 格。
- 编译状态 `OK` 改为蓝色，与 `PASS` 的绿色区分（结束行、结果树、Summary 表、`dtsim run`）。

## [2.8.0] - 2026-11-19

- **dtsim 并入 autowire**：`autowire dtsim run|regr|plan|list|groups|results|env`；`ln -s autowire.js dtsim`（或指向编译版 `out/autowire`）后 `./dtsim <cmd>` 直接进入同一组子命令。`index.ts` 带 bun shebang，`out/autowire.js` 写成可执行。独立的 `dtsim.js` / `build:dtsim` 删除，DSL 文本由 `scripts/gen-dtsim-dsl.ts` 在 `build:js` / `build:bin` 里嵌入。
- **`dt` 目录语义**：RTL 设计目录（项目）下的 `dt/` 放 testbench，`dt/config/dtsim.config.ts` 放配置（从 CWD 向上找），输出到 `dt/simout/`。`${workspace}` / `$WORKSPACE` 是项目根；`--root` 与 `Workspace({ root })` 删除。filelist 条目（含嵌套 `-f`）相对项目根，dtsim 在每个编译目录写一份展开后的绝对路径 `filelist.f`；缺失或循环的 filelist 在启动工具前报错。Case 可用 `filelist` 覆盖工作区 filelist（单独成编译组）。
- 后端改为值：`tool: VcsTool({ ntbOpts, flags })` / `VerilatorTool({ top, mdir, main })` / `defineTool({ name, ... })`，`Workspace({ tools })`、按 id 注册表与工作区级 `toolOptions` 删除；Case 的 `toolOptions` 按键覆盖工厂参数。Verilator `main: false` 走 `--cc --exe --build` 的 C++ harness；VCS `ntbOpts` 选择 `-ntb_opts`（如 `uvm-1.2`，`""` 不加），`flags` 替换内置编译选项（内置的 `-xlrm nettype_array` 在 VCS O-2018.09 上被当成源文件；demo 两份 VCS 配置用旧 run.sh 的选项）。内置后端与启动器随 DSL 一起物化到 `dt/config/.dtsim/dsl/`。`git_rev` 记录 `dt/config` 所在仓库的版本。工具无法启动时打印 `dtsim: cannot start <tool>`。修复：VCS `+UVM_TIMEOUT` 带字面引号传给 UVM，`$sscanf("%d")` 读成 0，所有 UVM 用例在 0 时刻 PH_TIMEOUT。demo/hbm：VCS O-2018.09 的 UVM DPI 不能用 g++ ≥ 10 编译（被跳过的 `#error` 含弯引号，dtsim 之前的 run.sh 同样失败），`VCS_GCC_DIR` 指向较旧的 gcc，eda 上 `VCS_GCC_DIR=/usr/bin` 六个用例 PASS。
- **后端决定哪些用例共用编译**：`SimTool.fingerprint`（只能追加字符串）换成 `compileKey(c, base)`：dtsim 给出通用 key（工具、defines 集合、按顺序的 compileArgs、编译期 env、case filelist），后端返回最终 key，可原样、追加或整体替换；相等即共用一个编译目录。内置 vcs 追加 `ntbOpts` 与编译 `flags`，verilator 追加 `top` / `mdir` / `main`。通用 key 不再对 compileArgs 排序（原来 `-CFLAGS a -LDFLAGS b` 与 `-CFLAGS b -LDFLAGS a` 会被误判为同一编译）。
- **集群执行后端改为值**：`task: { launcher: LsfLauncher({ queue, args }), maxSlots, maxCompiles }`，内置 `LocalLauncher()`（默认）/ `LsfLauncher`（`bsub -I`）/ `SlurmLauncher`（`srun --pty`），自定义用 `defineLauncher({ name, passthrough, wrap(argv, ctx) })`；`task.type` / `task.queue` / `task.options` 与 `Workspace({ launchers })` 删除。`DTSIM_TASK_TYPE=local|lsf|slurm` 换成对应内置启动器（与配置的名字相同则保留配置），其他值在加载时报错；`DTSIM_TASK_QUEUE` 作为 `ctx.queue` 传入并优先于内置启动器自己的 `queue`。`lsf` 透传 `LSF_*` / `LSB_*`，`slurm` 透传 `SLURM_*`（此前这些变量会被环境隔离拦掉）。假 `bsub` / `srun` 修正：遇到第一个命令词就停止解析选项（原来会吞掉被包装命令的 `-` 参数），并可把 argv 记到 `$DTSIM_MOCK_LAUNCH_LOG`。
- **路径与占位符统一 `${name}`**：新增 `resolvePath`（dtsim 变量优先，其次启动 dtsim 的 shell 变量如 `${HOME}`，结果相对 `dt/config` 取绝对路径；未知名字、裸 `$NAME`、工作区级路径里用 `${case}` 等都报错）。`Workspace({ output })` 可改输出根，如 `"${workspace}/temp/output"`；`filelist`、`cases`、hook 路径都走同一解析，`ToolContext.resolvePath` 给后端用。
- **hooks 改为 TypeScript 回调，`patches` 并入 `preCompile`**：`hooks: { preCompile: fn | [fn, ...], postCompile, preSim, postSim, onResult }`，在 dtsim 进程内调用；`Hook(path)` 脚本形式与 `patches` 字段删除，dtsim 也不再内置 `{ from, to }` 复制。所有阶段共用一个 `HookContext`（`stage`、`caseId`、`dir`、`log`、sim 阶段的 `seed`、onResult 的 `status`、合并后的 `caseOpts`、隔离后的 `env`、`expand`、`resolvePath`），`ctx.sh(cmd)` 在该目录以该阶段环境执行 bash，输出追加到 `hook-<stage>.log`，非零退出抛错。抛错即该编译 / seed 失败（`error.txt` 为 `phase: hook`）；onResult 只记日志；未知阶段名在加载时报错。preCompile 位于 filelist 展开之前，可以生成或修改 filelist 列出的源文件。
- **结果判定改为 Grader**：grader 是值，不按 id 注册：`Workspace({ grader })` 设默认（省略即 `DefaultGrader()`），Case 的 `grader` 覆盖并被派生用例继承。内置 `DefaultGrader({ pass, error, expect, waive, uvm })`：关键字（子串或 `re:` 正则）与 waive 规则从工作区 / 用例选项移入 grader 参数（`Workspace.waive` 与 Case `grade` 删除），`uvm`（默认开）把 `UVM Report Summary` 视为跑完标记、未被 waive 的 `UVM_ERROR` / `UVM_FATAL` 消息判 FAIL；`g.extend({...})` 追加列表与 waive 规则，供派生用例沿用父用例关键字。自定义用 `defineGrader({ name, grade(ctx) })`，返回 `Status` 或 `{ status, note, details, highlight }`（note 显示在结果旁，details 进 `run` 摘要与 `error.txt`，highlight 进摘录），可调用其他 grader 组合；日志缺失直接 `NO SIM LOG`，抛错或非法状态判 FAIL 并写 `grade.log`。`results --recheck` 走同一 grader。删除每个 seed 目录生成的 `check_result.js` 与 `error_keywords` / `expect_keywords` / `pass_keywords` / `waive_rules`。日志不再整体读入：判定与 `error.txt` 摘录在 worker 线程里流式扫描（DSL 导出 `scanLog`、`streamLines` 供自定义 grader 使用），308 MB 日志约 1.7 s，dtsim 主进程内存不增长。
- **用例派生树**：`Subcase(base, suffix, opts)` 换成 `case.SubCase(suffix, opts)`，返回新用例，可多级派生（id 为点分路径，如 `test_hello_world.cosim.ss`），父用例持有 `children`。case 文件只需导出顶层用例。`opts` 可写成 `(parent) => CaseOpts`，只在该用例被使用时求值、每次加载最多一次；deny 检查随之推迟到用例被使用时。`dtsim list` 以树形列出派生 id 而不求值。demo/dtsim 的 cosim 角落改为 `cosim.ss` / `cosim.ff` 二级派生。
- `case.descendants()` 列出整棵子树（不求值）；`Group` 成员可混用用例对象、精确 id 与 id 通配（`*` 限一段，`**` 跨段，如 `hello_world_base.*.cosim`），按成员顺序、通配按树序展开并去重；通配无匹配、对象不在已导出树中都会报错。
- **hooks 说明与 demo**：`docs/dtsim/README.md` 的 Hooks 一节列出上下文字段、各阶段运行时机、典型用途与对应 demo。demo/dtsim 的 `dt/config/hooks.ts` 覆盖五个阶段：`preCompile` 复制 SPICE deck 并用 `ctx.sh` 生成 `gen_stamp.svh`、`postCompile` 编译告警门限（`DTSIM_DEMO_MAX_WARN`）、`preSim` 按 seed 生成 `stim.hex`、`postSim` 写 `metrics.json`、`onResult` 追加 `results.csv` 并删除 PASS 的波形；demo/soc 用 `ctx.sh` 打 sdspi 补丁、编固件。修复：子进程在 stdout 关闭后再写 stderr 时 dtsim 报 `write after end` 崩溃。
- **dtsim 终端输出**：去掉 `[dtsim]` 前缀。计划、结果与表格写 stdout（cli-table3 表格、`├─` / `└─` 结果树与 `list` 派生树、Run / Summary 键值表、`elapsed MM:SS (start → end)` 一行代替三行时间），进度只写 stderr：TTY 上用 log-update 画面板，`--plain` / 管道 / LSF 日志每事件一行。`results` 改为 Status / Seed dir 表，`PASS=n` 计数行与 `--csv` 不变；`regression.txt` / `result.txt` 写入去色文本。新依赖 `cli-table3`、`log-update`。回归目录的 `dresults` 不再自带 bash 版 find / readlink 统计，改为转发给生成它的 dtsim 的 `results --dir <该目录>`（参数透传，`$DTSIM_BIN` 可覆盖），与 `dtsim results` 只剩一份实现；原 bash 版在 Windows 上反而更慢（0.54s 对 0.18s）。
- **`dtsim run` 实时状态**：compile / sim 开始时打印日志路径与实际提交的命令（`$ bsub ... vcs ...`，程序名加粗、选项高亮）；运行中 stderr 上是 spinner 面板，显示当前步骤（`preCompile` / `compile` / `postCompile` / `preSim` / `sim seed N` / `postSim` / `grade` / `onResult`，hook 步骤只在配置了 hook 时出现）、已运行时间与日志大小，并为编译日志和仿真日志各显示一行大小与最后一行（只读末尾 4 KB，250 ms 刷新），日志未落盘或 NFS 未同步时显示 `-`；每个步骤结束打印带颜色的状态与耗时。终端上 `-v` 把正在运行的日志新行实时打印在面板上方（读日志文件，VCS `-l` 这类工具自写日志也适用），面板保留在底部；非终端或 `--plain` 时只有开始 / 结束行，`-v` 仍直接转发子进程输出；`--interactive` 不显示。demo 的 `dt/*/run.sh` 不再强制 `--plain`，多余参数传给 `dtsim run`。引擎通过 `EngineOptions.monitor`（`start` / `end`）报告步骤。日志大小小于 1 KB 时显示字节数。
- `dtsim run` 状态行改为对齐的列：运行中 `[spinner] [已运行时间] [步骤] <日志> <大小>`，结束 `[带颜色的粗体状态] [耗时] [步骤] <日志> <大小>`，步骤名不带 seed（seed 在 Run / Summary 表里）；提交的命令画在标题为 `cmd` 的框里（标题与上框线同行，程序名、选项分色，长命令折行）；大小改用 `B` / `KiB` / `MiB`。非终端时精简输出：命令一行、只有 compile / sim / grade 的开始与结束，hook 步骤仅在失败时出现。表格框线灰色、表头粗体青色、键青色、状态粗体着色。
- **`dtsim regr` 输出改为树**：开始先打印 Regression 表（group、仿真器、启动器及其 `summary`、任务数、slot、输出目录），再打印计划树：编译节点 `compile <名字>` 下是 `defines` 节点（每行一个宏）和 sim 用例，每个 sim 下每行一个参数（seed、UVM test、simArgs、env）；完整编译命令写入每个编译目录的 `run_compile`（编译 env、工具命令，注释里是经启动器提交的命令；只是记录，dtsim 仍自己执行完整命令）。编译组名字由后端可选的 `SimTool.buildName` 提供（默认组内第一个用例 id），编译目录由 `compile_g1` 改为 `compile_<名字>`（非法字符变 `_`，重名加 `-2`）。运行中 stderr 上并列显示每个进行中的编译组树：`[spinner|状态] [耗时] compile <名字> <日志> <大小>`，子节点是正在跑的 sim，其余折叠为 `… N waiting, M done`，超过终端高度只画前几组。每个 compile / sim 完成或失败打印 `<状态> <耗时> <名字>`，下一行以 `└─` 给出日志路径和大小（非终端只有这些行）。结束后打印结果树与 Summary 表：Compiles 先 `FAIL` 再 `OK`，Sims 先 `FAIL` 等失败状态再 `PASS WITH ERRORS` / `PASS`，计数为 0 时灰色；另有总数、耗时、`result.txt`、`dresults`。`Launcher` 新增可选 `summary`，内置 lsf / slurm 填队列与参数。修复：回归进度原来固定显示 `vcs.log`，现在用后端实际写的日志。
- **Windows（MSYS2 UCRT64）**：无扩展名的 `#!` 命令（UCRT64 `verilator` perl 包装、hook、假工具）交给解释器执行；环境变量名大小写不敏感，`SYSTEMROOT` 等启动必需变量总会传给子进程；`run_sim` 以 MSYS 形式导出 `PATH`；`results --recheck` 修正 Windows 路径拆分。
- **demo**：新增 `demo/dtsim`（`dt/bin/` 假 vcs / simv / urg / verdi / verilator / bsub / srun，`run.sh` 包装）。`demo/soc/sim/` 迁到 `demo/soc/dt/`（`[sim.soc_tb] html = "dt/soc_tb.html"`），Verilator 冒烟改为 dtsim 用例 `basic_smoke` / `regfile_smoke` / `sd_sha256` / `tb_mod` / `sv_reg_smoke`，VCS 用 `dt/config/vcs.config.ts`；`dt/verilator/run.sh`（新增 `--sv-reg`，替代 `sv_reg_smoke.sh`）与 `dt/vcs/run.sh` 只是 dtsim 包装，`Makefile` 删除，固件与 SD 镜像在 `preSim` hook 构建。`demo/hbm/dv/uvm` 迁到 `demo/hbm/dt/uvm`，`dt/vcs/run.sh` 走 dtsim（VCS + UVM-1.2，默认 grader 按 UVM 报告判分）。
- 测试迁到 `test/dtsim/`，用 `demo/dtsim/dt/bin` 的假工具；新增 filelist 展开用例。`docs unpack` 对所有 `#!` 文件恢复可执行位，打包跳过 `dt/simout/` 与 `.dtsim/`。文档：`docs/dtsim/README.md`、`help dtsim`。
- 仓库内 demo 的 dtsim 配置直接 import `src/dtsim/dsl/index.ts`（与 wishbone SoT 同一约定），改 DSL 源码立即生效；打包时改写为配置旁的 `.dtsim/dsl/index.ts`，解包树照常运行。不用软链接（Windows 需要额外权限，Bun 也不跟随 MSYS 链接）。
- **文档**：README 全面更新（四项功能总表、安装、connect 与 dtsim 快速上手、demo 表、开发与发布）；`help dtsim` 改为面向 agent 的参考（目录与产物、命令与参数、Agent workflow、DSL 一览、输出）；`help agent` 与 `AGENTS.md` 加入 dtsim 的 SoT、生成目录与失败排查步骤（先读 `error.txt`，`run_compile` / `run_sim` 单步重跑，退出码只看 grader 状态）；`help status` / `help agent` 的发布说明改为只由推送 `v*` tag 触发。

## [2.7.2] - 2026-11-05

- **新增独立 Access.W1CC**：软件写 1 清除，硬件导出等宽 `_set` / `_clr` mask，逐 bit 按旧状态仲裁：旧 0 接受 set，旧 1 接受 clear；两输入持续同时为 1 时每拍翻转。支持 SEL、ready、shadow broadcast / 硬件 mux / per-copy 数组和独立复位域；硬件更新不受软件选择或 ready 阻塞影响。
- Excel 保留独立 `W1CC` 类型，C / SV package / UVM 注释说明硬件语义；UVM 使用标准软件 `W1C` 策略。文档与可运行示例同步更新。
- **寄存器存储块分组**：每个 Cell 内 RW/RWW、W1C、W1CC 分别生成时序块，同组字段及 shadow copies 共享。W1C/W1CC 将软件清除与有效 set/clear 提取为组合信号，时序块只复位和更新，不增加延迟；W1C 保持 set-wins 和原有 shadow 更新条件。W1P 仍按字段独立生成脉冲块。
- 增加 RTL 回归覆盖逐 bit 真值表、混合向量、持续翻转、字节使能、ready 阻塞、shadow、复位域，以及同 Cell 混合 RW/RWW/W1C/W1CC 的独立仲裁；重新生成 SoC smoke 寄存器 RTL。

## [2.7.1] - 2026-11-04

- **Cell 级访问阻塞**：新增 `CellDefault.ready(name)`，导出 `i_<name>`，同时控制该 Cell 的读写接受。仅 Cell 可配置，没有 Regfile / Block 默认。ready=0 时叶子不 ACK，不提前更新软件可写状态或触发 W1P；RWW 硬件更新与 W1C 硬件置位继续。posted pipe 保持入队 ACK，未接受的写滞留 pipe，队列满后自然反压，不增加非 posted 模式。
- bus cfg wrapper 正确上提 ready 输入，跨挂接 id 的同名 ready 合并；与时钟、复位、shadow 或其他端口撞名时报错。带 Cell ready 的 RWE 窗口与内部字段共同接受，单窗口支持 ready 依赖请求；同 Cell 多个阻塞窗口的 ready 必须独立于请求，避免循环等待与部分消费。
- **RWW 分支顺序更直观**：生成存储逻辑按复位 → 已接受的软件写 → 硬件更新排列，不再先判断 `~wr_sel`。保持 RWW 软件写优先、W1C set-over-clear 与未选字节 lane 的硬件置位语义。
- 增加直连与两级 posted pipe 的 RTL 回归，覆盖阻塞、队列反压、写顺序、硬件更新和 RWE 联合接受。契约及用法见 `docs/plugins/wishbone-regfile.md`，可运行示例为 `docs/examples/regfile/regfile.ts` 的 `sub_module_ready`。

## [2.7.0] - 2026-11-03

- **regfile 新增复位域（reset domains）**：`RegfileDefault.resetDomains("por_rst_n", ...)` 声明额外异步低有效复位域；`CellDefault.resetDomain(name)` 把**整个 cell** 的存储 DFF 绑到该域，`BlockDefault.resetDomain(...)` 为下属 cell 缺省（宽 field 拆片同样继承），都省略时落 `defaultResetDomain(...)`（缺省隐式域 `"rst_n"`）。粒度只到 cell，禁止 field 级。隐式域 `"rst_n"` = `i_rst_n`：**常驻、免声明、不可删**；被用域各出一个 `i_<name>` input，声明未用的域不出端口。只支持同 `i_clk` 的异步复位；**RWE** field 禁止挂非 `"rst_n"` 域（报错并提示显式绑回），W1P 脉冲寄存器与 RWE 窗 glue 恒走 `i_rst_n`。多份 regfile 可声明**同名**复位域：bus Type-A wrapper 按名合并成一个 wrapper input 统一上提，connect HTML 对 wrapper `aw-inst` 接一次线。Excel / C / uvm_reg 导出不含复位域。契约见 `docs/plugins/wishbone-regfile.md`；可运行样例 `docs/examples/regfile/regfile.ts` 的 `sub_module_rst`。
- wrapper 旁路口撞名从静默重复声明改为显式报错（reset domain 同名合并除外）。
- `test/pack.test.ts` 的 run.sh 执行位断言在 Windows 上自动跳过。

## [2.6.0] - 2026-10-26

- **hdxml 成为独立项目**：[`rede97/hdxml`](https://github.com/rede97/hdxml)。本仓库删除 `hdxml/`，不再构建它（无 cargo 依赖）；用 `hdxml-version.txt` 钉版本（本次 0.4.1），`bun run fetch:hdxml` 把该版本 release 二进制下载到 `.cache/hdxml/<version>/`。查找顺序变为 `--hdxml` > `[analysis] hdxml_bin` > `$HDXML_BIN` > 仓库 `.cache/hdxml/<version>` > `PATH`；原先的 `hdxml/target/{release,debug}` 候选已删除。
- autowire 发布改为**拉取** hdxml 对应 tag 的 release 产物（Linux x64 glibc 2.17、macOS arm64/x64、Windows x64）并原样挂到自己的 release，不再编译 hdxml；被钉版本缺失时发布失败。
- hdxml 自己的仓库有独立 `v*` tag 发布（先 `cargo test`，再构建四个平台并发布），已存在的 release 拒绝覆盖。RtlIndex / CLI 契约文档仍留在本仓库 `docs/hdxml/`（随 `autowire.js` 打包），hdxml 仓库链接过来。

## [2.5.12] - 2026-10-26

- 发布纪律：推送 `main` 不再触发 CI。检查、构建和 GitHub Release 只在人工推送 `v*` tag 时跑；CI 仍不创建 tag，已存在的 release 仍拒绝覆盖。
- connect 新增 `aw-content/aw-port-groups`：导出端口的打印分组提示（弱规则，不改连线）。每个 `aw-port-group name=` 按序带多个选择器（自身 `match=` / `inst=`，再加若干 `aw-port-match`）；端口归第一个命中的组，组内按选择器优先级、再按原 §4.1 顺序排（`order="name"` 改按名字排），未归组的放到最后的 `Other`；每组首个端口打印 `// <组名>`。重叠或空组给警告，非法正则 / 未知 `inst` / 缺选择器在 `check` 报错。契约见 `docs/connect/html.md` §4.1.1。demo/soc `soc_top` 按时钟复位 / JTAG / SPI flash / UART / SD0 / SD1 / 状态分组，`rtl/gen/connect/soc_top.sv` 与 `rtl/gen/sim/tb_soc.sv` 已重新生成。

## [2.5.11] - 2026-10-26

- **接口变更**：fabric（decoder / interconnect / crossbar）上 `SlaveRegfile` 的下游 slave 口 `{id}_i_wb_adr` 改为直接按叶子 `addrWidth` 声明，与 `<name>_regfile` 逐位对齐；其它 slave 与上游 master 口仍是 fabric `addrWidth`。窗内 offset 的截位 / 零扩展从 `<bus>_bus_cfg` 移进 fabric；有 `pipe` 时 `wb_cfg_pipe` 按窗口与叶子中较窄的宽度寄存。wrapper 内置叶子与 `external: true` 的上层叶子都直接同名连接，不再需要 ADR 适配；`-Wno-WIDTHEXPAND` 不再需要。直接例化 fabric 并自行接 regfile ADR 的用户需按新位宽改连接。
- demo regfile 的 `addrWidth` 改为各自窗口转发的位数，不再统一写 32：demo/soc `sha256` / `smoke` = 6（0x40 窗），demo/hbm `aword` / `dword` = 8（0x100 窗）、`center` = 12（0x1000 窗）。`rtl/gen` 已重新生成；C / uvm_reg / sv_reg 地址图不变。

## [2.5.10] - 2026-10-26

- `SlaveRegfile(regfile, base, { external })` 新增分离模式（缺省 `false` = 内置，保持现状）。`external: true` 时 `<bus>_bus_cfg` 不再例化该叶子、不提升字段旁路，改为导出该挂接的 fabric WB 窗口口（`{id}_i_wb_*` / `{id}_o_wb_*`，含 shadow 的 `{id}_i_wb_tga_<domain>`），由上层自行例化 `<name>_regfile` 并连接。按挂接点选择，可内外混用；同一 `RegfileDef` 多挂时各挂接点独立。`<name>_regfile.sv` 与软件地址图（C / uvm_reg / Excel / sv_reg）两种模式完全一致。`TagFromReg` 必须引用内置叶子，引用外置挂接 → 构造期报错。契约见 `docs/plugins/wishbone-bus.md` §2.1 / §6、`docs/plugins/wishbone-regfile.md`。

## [2.5.9] - 2026-10-21

- 修复 hdxml 0.4.1（issue #2）：保原文宏（`--define-headers` / `--keep-raw`）用作模块名时，内部哨兵不再出现在例化 `target` 和 hierarchy 节点。XML / JSON 导出还原为 `` `NAME ``，未展开的 cell 是黑盒叶子。
- `--expand-headers` 的宏值去掉前导分隔空白，与 `-D` 的 `definesFp` 一致。用宏选择外部 FIFO / sync cell 时把带值项写在 `[analysis.defines]`；只放进 `define_headers` / `keep_raw` 不会把 cell 接上。

## [2.5.8] - 2026-10-20

- connect 顶层导出端口排序规则化：显式 `aw-ports` 按作者文档序在前；自动导出的网按实例文档序分组，组内按目标模块自身端口表顺序排列，模板里 connect 规则的书写顺序不再影响导出顺序。契约见 `docs/connect/html.md` §4.1；demo/soc `rtl/gen` 随之重新生成。
- `wb_sync_cell` 新增参数 `WIDTH`（缺省 1，备用；多位为逐位独立同步，不是总线同步器），`d`/`q` 变为 `[WIDTH-1:0]`，`STAGES < 2` 编译期报错。新增编译宏 `AUTOWIRE_SYNC_CELL=CELL_SYNC` 选择外部同步单元/adapter：透传 `STAGES`、`RESET_VAL`、`WIDTH`，缺失所选模块编译失败、不静默回退；生成的 `wb_sync_cell.sv` 两种模式都留在 filelist。契约见 `docs/plugins/wishbone-master.md` §3.2。新增 `test/sync-cell.test.ts`。

## [2.5.7] - 2026-10-19

- 修复 `wb_cdc` 单侧复位（2.5.6 起）：只复位一侧（JTAG TRST 或系统 `rst_n`）会让 FIFO 重放历史命令、发出未初始化的 X 命令，并使后续读数据永久错一拍。现在 `link_rst_n = s_rst_n & rst_n` 同时复位两向 FIFO 两端（对侧停钟也生效）；丢失的挂起读回一次 `s_err`；源侧单独复位时已在 fabric 上的拍做完、数据丢弃；目标复位期间新请求等待；源撤 `CYC` 放弃的读，其迟到响应被排空。不再要求协调两侧复位。新增 `test/fixtures/wb_cdc_reset_tb.sv`。
- 新增 `Master(..., { apb: { timeout: N }, cdc: true })`：`wb_apb2wb` 参数 `TIMEOUT`（PCLK 周期，0 关闭），超时撤 `CYC` 并回 `PSLVERR`；必须经 `wb_cdc`，无 CDC 时报错。`wb_cdc` 自身仍无超时。`demo/hbm` 的 `host` 恢复 `timeout: 64`。新增 `test/fixtures/wb_apb_timeout_tb.sv`。RDC、复位脉宽、超时预算等集成注意事项见 `docs/plugins/wishbone-master.md` §3、§4。

## [2.5.6] - 2026-10-19

- `wb_cdc` 迁移 [Gitee master `435180e`](https://gitee.com/lunamiko/autowire/tree/435180e61a2580d5db3f3cc6f8f4e622b638876b) 的 posted 语义：命令 FIFO 深度 8、读返回 FIFO 深度 2，写入队即 ACK、读等目标 WB ACK 返回；保留 TGA 与 APB PPROT 拒绝。用户提供的硅验证结论适用于参考实现，不覆盖新增 WB 适配和默认 Gray FIFO。
- **接口/行为变更**：移除 `timeout` / RTL `TIMEOUT`、超时/复位 ERR 及自动恢复；要求静默请求并协调两侧复位，不保证单侧复位。停目标钟时读等待，写至 FIFO 满后背压。JTAG 写完成表示排队；同路径读只保证命令顺序，不是下游 posted 写的全局栅栏。
- 生成 `wb_async_fifo` wrapper 默认使用同文件 `wb_async_fifo_gray`，无需外部 CELL 即可仿真；`AUTOWIRE_ASYNC_FIFO_CELL=CELL_ASYNC_FIFO` 选择实际 CELL/adapter，缺失所选模块会编译失败，不静默回退。两种模式均保留生成 FIFO 文件，外部模式另外加入 CELL/adapter，并在 analysis 使用相同宏/filelist；适配必须满足寄存读出与 reset-busy 契约。外部选择的测试 adapter 不代表 vendor CELL 验证。

## [2.5.5] - 2026-10-19

- 修复 `wb_cdc` 冷启动：复位后、第一次回到 idle 之前，若目标侧没有在飞事务，新请求等待而不是立刻 `s_err`。APB 桥在此期间保持 `PREADY` 为低。超时、abort，以及源侧复位后目标仍握着已捕获事务时，仍回 `ERR`。`demo/hbm` 与 `demo/soc` 的 `wb_cdc.sv` 已重新生成。
- 仓库内直接跑 TypeScript 时，Wishbone RTL 模板从 Git 里的 `docs/plugins/rtl/` 读取。打包后的 `autowire.js` 仍只使用内嵌文档包，不打开本地 `docs/`。

## [2.5.4] - 2026-10-19

- 总线 WB 端口统一由一个端点 schema 生成名称、方向、位宽、TGA 和请求/响应角色；decoder / interconnect / crossbar 的 RTL 声明、wrapper 与原生 WB/CDC 桥接面共享来源，删除重复端口表及名字反向解析。
- **接口变更**：所有拓扑的 `.uplink()` 只选择级联 master，不再把 wrapper 端口改成 flat `i_wb_*` / `o_wb_*`。上层使用具名 `{master}_o_wb_*` / `{master}_i_wb_*` 显式连接父级 slave；demo/soc 已迁移成束 rewrite，保留手写 channel 外壳接口。
- **接口变更**：`Bus()` 的 `masters` 省略或为空时归一化为名为 `m` 的默认 master，统一输出 `m_o_wb_*` / `m_i_wb_*`，删除旧 `m_adr_i` 等端口格式，不保留兼容别名。
- 更新 SoC/HBM 生成物、级联端口契约和 tagged/pipe/broadcast/bridge 回归；仲裁、译码和基础 pipe/CDC 模块协议不变。

## [2.5.3] - 2026-10-19

- **接口变更**：Wishbone decoder 的已声明 master 端口与 interconnect / crossbar 统一为 `{master}_o_wb_*` / `{master}_i_wb_{dat,ack}`（含 TGA），不再使用 flat `m_*`；未声明 `masters` 的 decoder 保持原有 flat 口。
- decoder 的 `.uplink()` Type-A wrapper 保留具名 master 口，不再 remap 成 `i_wb_*` / `o_wb_*`，上层按 master 名显式连接；interconnect / crossbar 的级联 remap 不变。master pipe、APB/JTAG/CDC、demo/hbm 与回归测试已同步。

## [2.5.2] - 2026-10-15

- 修复 Type-A wrapper `<bus>_bus_cfg` 把 fabric 全宽 ADR 直接接到挂接 regfile 的 `i_wb_adr`、两者 `addrWidth` 不同时产生端口位宽不匹配的问题（issue #1）。fabric 下发的是窗内 offset（`adr & ~mask`），窗口以上全 0：fabric 更宽 → 接 `net[M-1:0]`；fabric 更窄 → 接 `{(M-N)'d0, net}`。demo/soc `sd_sha_bus_cfg`、demo/hbm `hbm_ch_bus_cfg` 随之重新生成。
- `Bus()` 构造期拒绝窗口转发位数大于挂接 regfile `addrWidth` 的配置（截断会把窗口别名到叶子上）。regfile 比窗口宽仍然允许。

## [2.5.1] - 2026-10-12

- `[plugins.wishbone]` 新增可选 `regfile_dir` / `bus_dir`，分别覆盖 regfile 与 bus 的 RTL 输出目录；省略时仍写入 `plugins_dir/wishbone/{regfile,bus}`。
- 修复 CDC 超时恢复过早接收新请求、可能将旧响应交给新请求的问题：增加目标排空确认握手，覆盖停钟前未捕获请求、单侧复位及复位期间 ERR。
- 明确 PIPE 读请求不可取消，增加仅仿真使用的请求保持检查；新增 CDC 时钟比例/恢复测试和 PIPE 违规控制测试。
- 纠正生成 JTAG PDL 的能力说明：Level-0 固定等待后检查状态，不提供自动 busy 轮询。
- `[plugins.wishbone]` 新增可选 `regfile_dir` / `bus_dir`，分别覆盖 regfile 与 bus 的 RTL 输出目录；省略时仍写入 `plugins_dir/wishbone/{regfile,bus}`。
- 修复 Bus / Crossbar 广播在订阅者响应错开或 pipe 占用不同时重复接受同一笔请求的问题：逐分支记录完成、屏蔽已完成分支的 STB，并保存读响应后 OR 汇总。保留 posted 写入口 ACK 语义。
- 构造期拒绝 slave 组名与同一 decoder 内 slot 名大写规范化后的标识符冲突，避免生成重复的 `SG_*` / `SLOT_*` 常量。

## [2.5.0] - 2026-10-12

- Wishbone 总线新增分组 crossbar：`Crossbar(name, desc, { masters: [Master | MasterGroup(...)], slaves: [slave | SlaveGroup(...)], addrWidth, tagWidth?, tags? })`。master 组各有一个 arbiter（组内互斥），slave 组各有一个 decoder，不同 (master 组, slave 组) 对并行推进；裸 master / slave 即单成员组。返回值仍是拍平的 `BusDef`（多出 `crossbar` 组元数据），口名、tag、pipe、广播、`.uplink()` 级联、`<bus>_bus_cfg` wrapper 与 C/UVM/SV/Excel 软件图全部沿用；产物 `<bus>_crossbar.sv`，端口与 interconnect 同形（含 `rb_grant_en`）。广播窗与订阅者必须同在一个 slave 组。经典 `Bus()` 的语义与生成产物逐字节不变。文档 `docs/plugins/wishbone-bus.md` §4.2，`help status`。
- 修复 interconnect 中 piped master（`Master(..., { pipe: N })`）携带继承 tag 域时，`g_up_<domain>` 引用未声明的 `m<i>_tga_<domain>_q`；现在从 pipe 打包的 `m<i>_tga_q` 正确切片。
- `plugin wishbone run` 的地址树为 crossbar 标出 `group:` 与 master 组；Excel 总线形态列新增 `crossbar`。
- 新增 `test/wishbone-crossbar.test.ts` 与 Verilator TB `test/fixtures/wb_crossbar_tb.sv`（并行推进、组内互斥、slave 组互斥、unmapped、固定/轮转混合突发）。

## [2.4.1] - 2026-10-10

- `.autowire/dsl/` 自愈从「仅缺失时补回」改为「每次 `plugin wishbone run` / `init` 都从内嵌 pack 无条件重新物化」：autowire 升级后解包出的 DSL 随之刷新，被手改/改脏的文件也会覆盖回内嵌版本（`.autowire` 本就是可删、禁手改的缓存）。文件很小，无条件覆盖比字节比对更简单，且没有陈旧缓存的失败模式；不引入版本戳。`ensureWishboneDsl` 返回 `{ files, freshDir }`，`freshDir` 仅用于决定日志措辞（目录原本不存在才打 `restored .autowire/dsl/`）。

## [2.4.0] - 2026-10-10

- Wishbone 级联面改用 `BusDef.uplink(name?)` 显式选取，**不再**用保留名 `Master("uplink")`，并删除 `SlaveBusOpts.uplink`。单 master 的子总线隐式取唯一 master 作面，多 master 必须 `child.uplink("name")` 点名；桥接口（apb/jtag/cdc）不能当面。`SlaveBus` 要求传入已选面的 child，`flattenBuses` 保留带 `cascadeFace` 的副本，使独立生成的 `<bus>_bus_cfg` wrapper 拿到正确面（级联 = `i_wb_*`/`o_wb_*`，顶层 = `m_*`）。**破坏性**：`Master("uplink")` + `SlaveBus(child, …)` 需迁移到 `child.uplink()`（或 `child.uplink("name")`）。
- 顺带修掉「decoder 挂 regfile 且无级联面」时 wrapper 把 fabric master 接到未声明 `i_wb_*` 的悬空 bug——现在无级联面就保持 fabric 自己的 `m_*` 面。
- demo（hbm / soc）、文档（`docs/plugins/wishbone-bus.md` §9、`wishbone-master.md`）、`help status`、测试全部切到新 API，并新增「无级联面」回归用例。
- `fix(demo/soc)`：默认 Verilator 目标（`Vtb_soc_vl`）不再把 aw-tb-mod 的 `rtl/gen/sim/tb_soc.sv` 拉进构建（那是 `--tb-mod` 的 top），避免找不到 `sim/*.svh` 而编译失败。

## [2.3.2] - 2026-10-09

- Wishbone 插件新增 `sv_reg` 导出：`[plugins.wishbone] sv_reg=` 生成非 UVM 的 `*_pkg.sv` package + localparam（字段 `_LSB/_WIDTH/_MASK/_RESET`；总线 `<SLAVE>_BASE`、`<SHEET>_<CELL>_OFFSET`、绝对地址 `<SLAVE>_<CELL>`），目录按 `regfile/` 与 `bus/` 分开、伞文件在根，与 C 导出同款组织。demo/soc 入库 `dv/sv_reg/` 与 Verilator 冒烟 `sim/verilator/sv_reg_smoke.sh`（无固件、无总线 RTL、不需要 `--timing`）。
- 新增 `autowire update`：打印当前版本、最新 release 地址（github.com/rede97/autowire/releases/latest）、各平台资产下载链接，以及一段可直接粘贴给 AI 的升级提示词（下载→替换→验版本→读 changelog→按依赖序重新生成→刷新 AGENTS-AUTOWIRE.md→重跑测试）。命令本身不下载、不写盘。
- 裸执行 `autowire`（无子命令）在命令索引末尾追加一行：项目链接 + 版本号。
- 发布纪律变更：CI 永不创建/推送 tag；推送 `main` 只做检查与构建，发布只在人工推送 `v*` tag 时触发，且拒绝覆盖已存在的 release。

## [2.3.1] - 2026-09-30

- `autowire.js` 打包打开 `--minify --keep-names`。页面脚本改由 `bun run build:web` 写到 `out/web/aw.js`、`out/web/page.js`（同样 minify，不入库）；`connect web` 和测试前先跑 `build:web`。

## [2.3.0] - 2026-09-30

- 索引/快照单格式：`--format json` 时 hdxml 只写 JSON（不再双写 XML）；增量缓存回读按格式分发（serde_json），验证逻辑（指纹/mtime/blake3 仲裁）原样。格式切换会清掉另一种格式的残留文件。connect 快照同理：`format = "json"` 时 `.autowire/connect/` 只写 `<id>.json`。
- `[analysis.index] format` 的 JSON 模式标记为测试状态；demo 与默认路径保持 XML（稳定支持）。
- README 重写为英文并补充性能与 Agent 适配说明、CI/Release 徽标；仓库以 GPL-3.0 开源。

## [2.2.9] - 2026-09-30

- RtlIndex JSON 消费模式：`[analysis.index] format = "json"` 时 hdxml（0.4.0，`--format json`）在 XML 之外再写 `index.json` + 每文件 `.json` 镜像；connect/web/`analysis deps|search|info` 直接 JSON.parse（真实索引上约为 Bun.XML 的 2.1 倍吞吐）。XML 始终写出，仍是增量缓存本体与文档化契约；增量逻辑不变。
- JSON 端口带显式 `dir` 字段（声明序）；消费侧按 PORT_DIRS 重排，与 XML 路径生成结果逐字节一致。
- connect 快照同步支持：`format = "json"` 时 `connect run` 在 `.autowire/connect/<id>.xml` 之外写 `<id>.json` 镜像，deps 加载改读 JSON（`connectJson`/`parseConnectJson`，与 XML 往返结果全等有测试锁定）。

## [2.2.8] - 2026-09-30

- src/core 性能优化（docs/dev/core-perf.md）：`unitModNames` 全量 HTML 解析从每 unit 一次降为每次命令一次（O(U²)→O(U)）；session dep facts 去掉 connectXml 序列化往返；elaborate 按 target 模块缓存 facts/params/ports/端口序；端口维度 rewriteDims 不再重复扫描；writeRender 端口排序改 Map 查表。生成物与优化前逐字节一致。
- writeRender 的 DOM 构建路径（审查 #3）未动，留待单独处理。

## [2.2.7] - 2026-09-29

- wishbone `<bus>_bus_cfg` wrapper 改经 connect 的 render IR + 共享 printer 生成：插件构造 ports/signals/insts 模型交给 `printSv`，删掉手工对齐的平行实现（含正则反解析已生成文本的 helper）。生成时传入**全部** `[workspace.style]`（对齐、端口方向/位宽注释、`net_type`），wrapper 与 connect 单元输出同款格式。四个 demo wrapper 重新生成；桥接实例的端口事实（dir/宽度）来自插件自有模板表。printer 的 RenderModule 增加可选 `header` / 端口与信号 `comment` / `assigns` 字段（connect 引擎不写，插件用）。

## [2.2.6] - 2026-09-29

- 发布产物增加 `hdxml-windows-x64.zip`：`windows-2022` 上 MSVC 目标的 `hdxml.exe`。
- `[workspace.style] net_type`：`logic`（默认）/ `wire` / `auto`。作者面没写 `nettype` 的端口和内部信号按它填关键字；`auto` 从子模块声明继承（叶子口按 RtlIndex `dataType`：`logic`/`reg` → `logic`，无关键字即隐式线网 → `wire`；connect 例化 connect 取子单元快照的 `nettype`；两端继承不一致报 nettype conflict），继承不到回落 `logic`。生成的 `.sv` 不再出现 `reg`。显式 `nettype=` 永远优先。原默认（端口回落 wire、信号回落 logic、默认带继承）改为默认 logic、不做继承，demo 生成物随之重生成。

## [2.2.5] - 2026-09-29

- Wishbone 总线封装模块改名 `<bus>_system` → `<bus>_bus_cfg`（生成物；引用封装名的 `aw-inst`、filelist、脚本都要同步改）。demo/soc、demo/hbm 已跟随。
- 生成的 Wishbone Excel（`bus_regfiles.xlsx`）不再进 git：`*.xlsx` 加入 gitignore，工作簿留在磁盘上，改 SoT 后由 `plugin wishbone run` 重写。

## [2.2.4] - 2026-09-30

- hdxml 提取端口 packed / unpacked 维度时去掉紧随其后的 `//` 行注释。2.2.2 只清了 localparam 默认值，sdspi 的 `// }}}` 折叠标记仍从 `[DW-1:0]` 进生成的端口宽度注释。
- `docs/skills/autowire-soc-integration.md` 与 `docs/workspace/toml.md` 把分析 filelist 的三条规则拆开写：只放手写 RTL 和 `plugins_dir` 叶子；wrapper 与 TB 放仿真 filelist；叶子缺失时 `analysis run` 点名 `plugin wishbone run`。

## [2.2.3] - 2026-09-29

- `help agent`、`help dont`、仓库 `AGENTS.md`（`init` 抄成 `AGENTS-AUTOWIRE.md`）和 init 的 toml 注释写明：`rtl/gen/`、`fw/gen/`、`dv/ral/`、`.autowire/` 是生成物，不是源。生成结果不对就改 SoT 再跑写出命令，不要改这些文件。
- 初始化约定整段写在 `help agent` 的 Init：先讲清工具再按默认项问用户，并说明怎么把 `AGENTS-AUTOWIRE.md` 接到工作区 `AGENTS.md`。没跑过 `init` 也能读到。`init` 写完文件后会再打一行同样的挂接提示。
- `help agent` 的 Cold start 只留启动顺序。hdxml 查找留在 `help analysis`，`snapshot missing` 留在 `help check`，解包缺 demo 留在 `help docs`，`adr & ~mask`、分片口、tga tie-off、`TagFromAddr` 地址位留在 `help status` 的 wishbone 条目旁。
- `help agent` 的 Init 按 Writes / Attach / Ask / Defaults 分块。实战顺序和踩坑在 `docs/skills/autowire-soc-integration.md`：filelist 已点名 `rtl/gen` 时先 `plugin wishbone run`，再 `analysis run`，再 `connect run`。
- `help` 正文改到 `help/<topic>.txt`，`src/cli/help.ts` 只负责读入；这些文件打进 `autowire.js`，不必先 `docs unpack`。`docs/dev/cdp-debug.md` 挪到 `docs/skills/cdp-debug.md`。工具与 MCP 的边界收进 `docs/architecture.md` §3，删掉没有实现的 `docs/mcp/`。
- 分析与仿真的 filelist 分开：`[analysis]` filelist 只装手写 RTL 和 `plugins_dir` 叶子；`connect run` 的产物（wrapper、TB）不进索引，放仿真专用 filelist（demo/soc 新增 `rtl/gen.f`，仿真按 `-f rtl/soc.f -f rtl/gen.f` 合并，两个仿真 filelist 不再各自抄一份）。`analysis run` 对 filelist 里的 `connect_dir` / `sim_dir` 条目直接报错，不再提示「先跑 connect run」。demo/soc 重新生成 `sd_sha_ch.sv`（hdxml 去掉 localparam 行尾注释后产物一直未同步，release 冒烟抓到漂移）。

## [2.2.2] - 2026-09-29

- 冷启动契约写进 `help agent`、仓库 `AGENTS.md`（`init` 抄成 `AGENTS-AUTOWIRE.md`）和 init 的 toml 注释：独立包的 hdxml 走 `--hdxml` / `$HDXML_BIN` / PATH；filelist 点名了还不存在的 dump 路径时先生成再 analysis；`connect check` 依赖已有 snapshot；文档引用的 demo 若这次 unpack 没有，就不要到包外去找。同时写明 `adr & ~mask` 不能做基址相减或翻位、宽 field 旁路是分片口、声明了 tag 的总线每个 master 都有 tga 口要 tie-off、`TagFromAddr "hi:lo"` 才是地址位权威。
- `analysis run` 在 filelist 列出 `plugins_dir` / `connect_dir` / `sim_dir` 下缺失文件时直接停住，并指出先跑 `plugin wishbone run` 或 `connect run`，不再只把 hdxml 的 file-not-found 透传出去。
- `docs unpack` 把 `*.sh` 恢复为可执行。wishbone-regfile 契约改为与生成器一致：宽 field 模块口保持分片，不拼成一条向量。hdxml 从 localparam 默认值里去掉紧随其后的 `//` 注释（sdspi 的 `DW = 32` 下一行折叠标记不再进宽度表达式）。demo/soc 的 JTAG bank 别名与 `TagFromAddr bank "27:26"` 对齐。

## [2.2.1] - 2026-09-29

- 发布 CI 的 `autowire-js` 构建后新增 bundle 冒烟（`scripts/smoke-bundle.ts`）：用打出来的 `autowire.js` 跑 `--version`、独立目录 `init`（含 `.autowire/dsl` 与拒绝覆盖）、完整驱动 demo/soc（analysis → wishbone → connect check/run），并用 `git diff` 验证生成产物与仓库逐字节一致（Excel 除外，其内嵌时间戳）。只测源码的单元测试覆盖不到的打包路径问题由此进 CI 门禁。

## [2.2.0] - 2026-09-28

- 发布包冷启动优化：文档包收紧为"可运行的最小集"——`demo/*/ip/` 只打该 demo `.f` filelist 引用到的源文件（sdspi/picorv32 的上游文档、bench、PDF 不再进包），`vcs/work/`、`.git` 指针、`.github`、`*.xlsx`、`ucli.key`、`~$*` 全部排除；`demo/*/patches/` 的补丁打包时已应用；demo `sot/*.ts` 的 DSL 导入改写到 `.autowire/dsl/`，解包后的独立树可直接跑 `analysis run` → `plugin wishbone run` → `connect run`（再生产物与仓库已提交的 showcase 逐字节一致）。压缩从 gzip 换成 zstd level 22，内嵌形式从 80MB 的 `Uint8Array.from([...])` 字节数组字面量改成函数体内的 base64 字符串（函数体惰性解析，只在 `loadPack` 时解码）；exceljs 改为惰性加载。`autowire.js` 从 85MB 降到 4.8MB，冷启动从约 1.2s 降到约 0.2s。
- `autowire init <name>` 同时写出 `.autowire/dsl/`（wishbone-bus/wishbone-regfile 的 DSL 源码三件套）。独立工作区的 SoT 用 `../.autowire/dsl/wishbone-bus/dsl.ts`、`../.autowire/dsl/wishbone-regfile/dsl.ts` 导入，不再依赖仓库源码树。DSL 随发布版本走；`.autowire` 被删后 `plugin wishbone run` 自动补回。DSL 判定为结构式（无 instanceof），bundle 内置副本与外部文件不会重复定义冲突。

## [2.1.0] - 2026-09-28

- 打包的 `autowire.js` 可以脱离仓库工作：wishbone 模板从文档包读取（不再依赖源码树路径），`hdxml` 查找在仓库外回退到 `HDXML_BIN`/PATH。`loadPack` 进程内缓存。
- RtlIndex 目录强制固定为 `.autowire/hdxml`：`[analysis.index] dir` 写成其他值直接报错。`autowire init <name>` 会创建该目录。
- `init` 的 toml 模板风格对齐 demo/soc：`filelists = ["rtl/<name>.f"]`、`rtl/gen/` 产物三分目录、完整 `[workspace.style]` 对齐块。

## [2.0.2] - 2026-09-28

- `help agent`（`Reference (top priority)`）与仓库根 `AGENTS.md` 明确：项目最佳实践以 `docs/`（契约/约束）与 `demo/`（可运行范例）为准，改动行为前先读这两处，作为第一优先级参考。

## [2.0.1] - 2026-09-28

- `[analysis.rtl]` 新增 `exclude_dirs`，映射 hdxml `--exclude-dirs`（按目录名剪整棵子树，任一路径分量命中即排除）。此前 hdxml 已支持该能力，但 autowire.toml 未透出、文档也未说明。

## [2.0.0] - 2026-09-28

- hdxml 支持 VCS 风格 filelist 的最小子集：`.vc` 扩展名、`+incdir+DIR`、`+define+NAME[=VALUE]`、`-F`（子列表内容相对该子列表所在目录）。库搜索（`-y`/`+libext+`/`-v`）与仿真器开关不实现，遇到即报错。hdxml 自身版本升为 0.2.0，与 autowire 版本相互独立。
- 主线代码源切换为 GitHub `main`；Gitee 分支线不再合入。

## [0.9.1] - 2026-09-28

- 主干上的 GitHub Actions 发布 Linux x86_64 `hdxml`（Ubuntu 22.04 执行 `hdxml/dist.sh`，glibc 2.17，CentOS 7 及更新版本）、macOS `hdxml`（arm64 与 x64），以及单文件 `autowire.js`。
- `autowire --version` 打印版本、提交和构建时间。版本来自本文件；发布构建把提交和构建时间写进 `autowire.js`。
- `autowire init <name>` 同时创建 `autowire.toml` 和 `AGENTS-AUTOWIRE.md`。后者是仓库根目录 `AGENTS.md` 的原样副本。任一文件已存在则两个都不写。
- 文档包包含仓库根目录的 `AGENTS.md`。`docs unpack` 会写出它。`doc-pack.generated.ts` 每次发布构建重新生成，不入库。
- 本版不包含 obscura、安装器、Linux aarch64，以及编译进 Bun 运行时的 `autowire` 二进制。
