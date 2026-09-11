# Local IP patches

本目录是本地 IP 修改的 **SoT**；submodule（`demo/soc/ip/*`）保持上游原样、
**禁止**在上游子模块里落本地 commit（上游 fetch 不到会导致 gitlink 失效）。

子模块 checkout / reset 后重新打补丁：

```bash
demo/soc/patches/apply.sh   # 幂等；已打过则跳过
```

打上补丁后 submodule 显示 `modified content`（工作区改动）是**预期状态**。

## `sdspi-fifo-wb-once.patch`

ZipCPU `sdspi` FIFO 的 Wishbone 指针必须每笔事务只推进一次（`!dly_stb` 守卫）：
sdspi 是流水 ACK slave（`o_wb_ack <= dly_stb <= wb_stb`），而 `sd_rd_dma`
这类 master 会保持 STB 直到 ACK——没有该守卫时指针在等 ACK 的第二拍再次 +1，
FIFO 跳字。详见 commit message / 实战手册踩坑 #12。

期望上游基线：`ZipCPU/sdspi` `dfb16c8`（superproject gitlink 记录值）。
