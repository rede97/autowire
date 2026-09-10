// SPDX-License-Identifier: MIT
// SoC memory map for C firmware (mirrors connect/soc_top.html).

#pragma once

#include <stdint.h>

#define SRAM_BASE      0x00000000u
#define FLASH_BASE     0x01000000u
#define TESTOUT_ADDR   0x02000010u
#define DMA0_BASE      0x03002000u
#define SHA0_BASE      0x03004000u
#define REGFILE_SMOKE_BASE 0x03006000u

#define DMA_CTRL       0x0u
#define DMA_STATUS     0x4u
#define DMA_SRC        0x8u
#define DMA_LEN        0xCu

#define DMA_CTRL_START   (1u << 0)
#define DMA_CTRL_SRC_INC (1u << 1)
#define DMA_STATUS_BUSY  (1u << 0)
#define DMA_STATUS_DONE  (1u << 1)

#define SHA_CTRL       0x0u
#define SHA_HASH0      0x4u
#define SHA_SOFT_RESET (1u << 0)
#define SHA_DONE_CLEAR (1u << 1)
#define SHA_BUSY       (1u << 8)
#define SHA_DONE       (1u << 9)

/* regfile smoke bank (regs/smoke.ts → smoke_regfile on soc_top; smoke_wb = glue) */
#define SMOKE_ID       0x000u
#define SMOKE_STATUS   0x004u
#define SMOKE_CFG      0x008u
#define SMOKE_FEED     0x00cu
#define SMOKE_FIFO     0x010u
#define SMOKE_CMD      0x014u
#define SMOKE_IRQ      0x018u
#define SMOKE_BANK     0x01cu
#define SMOKE_KEY0     0x020u
#define SMOKE_KEY1     0x024u
#define SMOKE_KEY2     0x028u
#define SMOKE_BANKSEL  0x02cu

#define SMOKE_CFG_ENABLE (1u << 0)
#define SMOKE_CFG_MODE_SHIFT 8
#define SMOKE_IRQ_STICKY (1u << 0)
#define SMOKE_CMD_GO     (1u << 0)

#define MARK_ALIVE     0x00000001u
#define MARK_FAIL      0xdead0001u
#define MARK_PASS      0x600d600du

static inline void mmio_write(uint32_t addr, uint32_t val)
{
	*(volatile uint32_t *)(uintptr_t)addr = val;
}

static inline uint32_t mmio_read(uint32_t addr)
{
	return *(volatile uint32_t *)(uintptr_t)addr;
}

static inline void mmio_write8(uint32_t addr, uint8_t val)
{
	*(volatile uint8_t *)(uintptr_t)addr = val;
}
