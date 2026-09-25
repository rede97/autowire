// SPDX-License-Identifier: MIT
// SoC memory map for C firmware (mirrors connect/soc_top.html).
// Field layouts + window bases: wishbone packed C export (fw/gen/wishbone).
// Channel DMA SRC uses the child-relative map (parent strips the 4 KiB window).

#pragma once

#include <stdint.h>

#include "soc_wb_map.h"

#define SRAM_BASE      0x00000000u
#define FLASH_BASE     0x01000000u
#define TESTOUT_ADDR   0x02000010u
#define CH0_BASE       0x03000000u
#define CH1_BASE       0x03001000u
#define CH_SD_OFF      0x00u
#define CH_DMA_OFF     0x10u
#define CH_SHA_OFF     0x40u
#define DMA0_BASE      (CH0_BASE + CH_DMA_OFF)
#define DMA1_BASE      (CH1_BASE + CH_DMA_OFF)
#define SHA0_BASE      SOC_WB_CH0_SHA256_BASE
#define SHA1_BASE      SOC_WB_CH1_SHA256_BASE
#define REGFILE_SMOKE_BASE SOC_WB_SMOKE_BASE

#define DMA_CTRL       0x0u
#define DMA_STATUS     0x4u
#define DMA_SRC        0x8u
#define DMA_LEN        0xCu

#define DMA_CTRL_START   (1u << 0)
#define DMA_CTRL_SRC_INC (1u << 1)
#define DMA_STATUS_BUSY  (1u << 0)
#define DMA_STATUS_DONE  (1u << 1)

#define SHA_CTRL       SOC_WB_SHA256_CTRL_OFFSET
#define SHA_HASH0      SOC_WB_SHA256_HASH0_OFFSET

#define SMOKE_OFF_ID       SOC_WB_SMOKE_ID_OFFSET
#define SMOKE_OFF_STATUS   SOC_WB_SMOKE_STATUS_OFFSET
#define SMOKE_OFF_CFG      SOC_WB_SMOKE_CFG_OFFSET
#define SMOKE_OFF_FEED     SOC_WB_SMOKE_FEED_OFFSET
#define SMOKE_OFF_FIFO     SOC_WB_SMOKE_FIFO_OFFSET
#define SMOKE_OFF_CMD      SOC_WB_SMOKE_CMD_OFFSET
#define SMOKE_OFF_IRQ      SOC_WB_SMOKE_IRQ_OFFSET
#define SMOKE_OFF_BANK     SOC_WB_SMOKE_BANK_OFFSET
#define SMOKE_OFF_KEY0     SOC_WB_SMOKE_KEY_KEY_0_OFFSET
#define SMOKE_OFF_KEY1     SOC_WB_SMOKE_KEY_KEY_1_OFFSET
#define SMOKE_OFF_KEY2     SOC_WB_SMOKE_KEY_KEY_2_OFFSET
#define SMOKE_OFF_BANKSEL  SOC_WB_SMOKE_BANKSEL_OFFSET
#define SMOKE_OFF_ACTIVE   SOC_WB_SMOKE_ACTIVE_OFFSET
#define SMOKE_OFF_FABRIC   SOC_WB_SMOKE_FABRIC_OFFSET

#define MARK_ALIVE     0x00000001u
#define MARK_FAIL      0xdead0001u
#define MARK_PASS      0x600d600du

_Static_assert(sizeof(union SMOKE_CFG) == 4, "SMOKE_CFG");
_Static_assert(sizeof(union SHA256_CTRL) == 4, "SHA256_CTRL");

static inline void mmio_write(uint32_t addr, uint32_t val)
{
	*(volatile uint32_t *)(uintptr_t)addr = val;
}

static inline uint32_t mmio_read(uint32_t addr)
{
	return *(volatile uint32_t *)(uintptr_t)addr;
}

/* Posted-write drain: a read on the same slave is a barrier. */
static inline uint32_t mmio_barrier(uint32_t addr)
{
	return mmio_read(addr);
}

static inline void mmio_write8(uint32_t addr, uint8_t val)
{
	*(volatile uint8_t *)(uintptr_t)addr = val;
}

/* Toolchain bitfield packing must match Field LSB=0 (little-endian GCC). */
static inline int regfile_layout_ok(void)
{
	union SMOKE_CFG cfg;
	union SHA256_CTRL ctrl;

	cfg.all = 0;
	cfg.bit.ENABLE = 1;
	cfg.bit.MODE = 3;
	if (cfg.all != (1u | (3u << 8)))
		return 0;
	ctrl.all = 0;
	ctrl.bit.SOFT_RESET = 1;
	ctrl.bit.DONE_CLEAR = 1;
	if (ctrl.all != 3u)
		return 0;
	ctrl.all = 0;
	ctrl.bit.BUSY = 1;
	ctrl.bit.DONE = 1;
	if (ctrl.all != ((1u << 8) | (1u << 9)))
		return 0;
	return 1;
}

static inline union SHA256_CTRL sha_ctrl_rd(uint32_t sha_base)
{
	union SHA256_CTRL u;

	u.all = mmio_read(sha_base + SHA_CTRL);
	return u;
}

static inline void sha_ctrl_wr(uint32_t sha_base, union SHA256_CTRL u)
{
	mmio_write(sha_base + SHA_CTRL, u.all);
}

static inline void sha_soft_reset_at(uint32_t sha_base)
{
	union SHA256_CTRL u;

	u.all = 0;
	u.bit.SOFT_RESET = 1;
	sha_ctrl_wr(sha_base, u);
	u.all = 0;
	sha_ctrl_wr(sha_base, u);
	u.bit.DONE_CLEAR = 1;
	sha_ctrl_wr(sha_base, u);
	(void)mmio_barrier(sha_base + SHA_CTRL);
}

static inline int sha_busy(uint32_t sha_base)
{
	return sha_ctrl_rd(sha_base).bit.BUSY != 0;
}
