// SPDX-License-Identifier: MIT
// SoC memory map for C firmware (mirrors connect/soc_top.html).

#pragma once

#include <stdint.h>

#define SRAM_BASE      0x00000000u
#define FLASH_BASE     0x01000000u
#define TESTOUT_ADDR   0x02000010u
#define DMA0_BASE      0x03002000u
#define SHA0_BASE      0x03004000u

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
