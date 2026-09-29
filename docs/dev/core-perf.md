# src/core 性能优化记录

> 2026-09-29 审查 + 优化。审查基线：demo/soc（4 connect unit + 1 sim unit，41 个 leaf 模块，soc_top snapshot 38KB）。
> 实测：connect check 0.42s → 0.38s / connect run 0.55s → 0.46s（含 Bun 启动 ~0.15s；demo 规模小，收益主要体现在 O(U²) 消除后的放大场景）。soc_top 单 unit：happy-dom 加载 33.6ms、ctx 构建 21.5ms、check 7.8ms、elaborate 38.0ms、序列化 10.2ms。
> CPU profile（elaborate ×30）：热点在 happy-dom DOM 属性机器（setNamedItem 3.5%、onSetAttribute 2.4%、MutationRecord 1.6%、enqueueReaction 1.7%）。

## 优化项（按实施顺序；编号沿用审查报告）

| # | 位置 | 问题 | 修法 | 状态 |
|---|---|---|---|---|
| 1 | `connect.ts` `unitModNames` ← `happydom.ts`/`cli/web.ts` | 每个 unit 都用 linkedom 全量解析全部 unit HTML 取顶层 aw-mod 名，O(U²) | unit 循环外算一次传入 | 已做 |
| 2 | `happydom.ts` sessionFacts | dep snapshot 字符串 → parseSnapshot → connectXml → parseConnectXml 序列化往返 | parseSnapshot 结果直接映射 WrapperFacts，去掉 XML 往返 | 已做 |
| 4 | `aw.ts` elaborateMod | 同一 target 模块 N 实例时 leafParams/portFacts/portOrder Map 重建 N 次 | elaborateMod 内按 target 缓存 | 已做 |
| 5 | `aw.ts` 维度文本 | 同一 packed/unpacked 文本被 foldDims/rewriteDims 反复扫描 | resolveDims 复用已算结果；mergeSignal 缓存范式 | 已做 |
| 6 | `aw.ts` writeRender 排序 | 比较器内 indexOf 查端口序，O(P² log P) | 每实例先建 Map<port,idx> | 已做 |
| 7 | `aw.ts` submods 拓扑 | sibs.find 按名查，O(k²) | 建 Map<name,Element> | 已做 |
| 8 | `happydom.ts` 错误过滤 | 每 error 摊开 session keys | 循环外取一次 | 已做 |
| 10 | `printer.ts` printInsts | rows.flat() 两遍、Math.max(...大数组) | 复用 flat；循环求 max | 已做 |
| 3 | `aw.ts` writeRender + connectedCallback | 逐节点 DOM API 建 aw-render，热点全在 happy-dom 属性机器 | **已尝试 innerHTML 一次写入：实测无收益（soc_top renderUnit 新旧均 ~37ms，解析成本抵消 attribute 节省），已回退** |
| 9 | `happydom.ts` check+elaborate 两遍遍历 | check 不跑脚本、elaborate 跑脚本，是设计结果 | 不动 | 不做 |

## 不做的事

- #9：check/elaborate 分离是「check 不执行脚本」的契约，合并会破坏静态报错语义。
- happy-dom 换实现：浏览器/happy-dom 双端共用 aw.ts，绑定平台特有 API 会破坏 connect web 的浏览器路径。

## 已经是对的（勿"优化"）

- `writeIfChanged` 先读后比，生成物增量写。
- `printer.ts` string[] + join 单遍输出，正则全为模块级常量。
- `connectxml.ts` 单遍序列化/解析；`topoUnits` DFS + Set；LeafDb per-module 缓存。
- check 侧 Map/Set 查重，无 includes/find 套循环。

## #3 实验记录（2026-09-30，已回退）

writeRender 改为整棵子树拼 HTML 字符串 + 单次 `innerHTML`：功能正确（201 测试全过、demo/soc 生成物逐字节一致），但 20 次 soc_top renderUnit 微基准新旧均 ~37ms——happy-dom 的 HTML 解析成本恰好抵消掉逐节点 attribute 机器（NamedNodeMap/MutationRecord）的节省。soc_top 的 render 树约数百节点，innerHTML 的盈亏平衡点不在这个规模。结论：保留 DOM API 路径，不再投入。

## 复测方法

```bash
bun test                                    # 全量
cd demo/soc && bun ../../index.ts connect run   # 生成物应与仓库一致（git status 干净）
bun --cpu-prof index.ts connect run         # profile 对比
```
