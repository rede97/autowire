// SPDX-License-Identifier: MIT
//
// Basic Verilator smoke:
//   1) SRAM: 64 zero bytes + soft pad → DMA0 → SHA0
//   2) Flash XIP region 0x0100_1000: legacy gen_firmware.py message words
//   3) Enable FABRIC.rb_grant_en (round-robin), then DMA0+DMA1 concurrent
//      SRAM reads of the same buffer → SHA0 / SHA1
// Soft-reset SHA and clear DMA done between stages.

#include "../common/soc_map.h"

#define MSG_BASE   0x00000100u
#define MSG_WORDS  32u
#define FLASH_KAT  0x01001000u

/* sha256(64 zero bytes), per-word byte-swapped */
static const uint32_t EXPECTED_ZEROS[8] = {
	0x42FDA5F5u, 0x30206AD1u, 0x6EEF9827u, 0x9B9709D3u,
	0x233D0043u, 0xE8F0D920u, 0xA93198EAu, 0x4BFB5927u,
};

/* gen_firmware.py KAT digest, per-word byte-swapped */
static const uint32_t EXPECTED_FLASH[8] = {
	0x52A09D04u, 0x56EB4F63u, 0xBCC06ECEu, 0x20678C64u,
	0x1CFFED11u, 0x31B572B2u, 0x0AC9BB13u, 0x9C24008Fu,
};

static void fail(void)
{
	mmio_write(TESTOUT_ADDR, MARK_FAIL);
	for (;;)
		;
}

static void pass(void)
{
	mmio_write(TESTOUT_ADDR, MARK_PASS);
	for (;;)
		;
}

static void dma_kick(uint32_t dma_base, uint32_t src, uint32_t ctrl)
{
	mmio_write(dma_base + DMA_STATUS, DMA_STATUS_DONE);
	mmio_write(dma_base + DMA_SRC, src);
	mmio_write(dma_base + DMA_LEN, MSG_WORDS);
	mmio_write(dma_base + DMA_CTRL, ctrl);
}

static void wait_dma_done(uint32_t dma_base)
{
	while ((mmio_read(dma_base + DMA_STATUS) & DMA_STATUS_DONE) == 0)
		;
}

static void wait_sha_idle(uint32_t sha_base)
{
	while (sha_busy(sha_base))
		;
}

static void run_dma_sha(uint32_t src, uint32_t ctrl)
{
	dma_kick(DMA0_BASE, src, ctrl);
	wait_dma_done(DMA0_BASE);
	wait_sha_idle(SHA0_BASE);
}

static void check_digest_at(uint32_t sha_base, const uint32_t *expected)
{
	unsigned i;

	for (i = 0; i < 8; i++) {
		uint32_t got = mmio_read(sha_base + SHA_HASH0 + 4u * i);
		mmio_write(TESTOUT_ADDR, got);
		if (got != expected[i])
			fail();
	}
}

int main(void)
{
	unsigned i;
	union SMOKE_FABRIC fabric;

	mmio_write(TESTOUT_ADDR, MARK_ALIVE);
	if (!regfile_layout_ok())
		fail();

	/* --- 1) SRAM zeros + soft pad --- */
	for (i = 0; i < 16; i++)
		mmio_write(MSG_BASE + i * 4u, 0);
	mmio_write(MSG_BASE + 16u * 4u, 0x00000080u);
	for (i = 17; i < 31; i++)
		mmio_write(MSG_BASE + i * 4u, 0);
	mmio_write(MSG_BASE + 31u * 4u, 0x00020000u);
	(void)mmio_barrier(MSG_BASE);

	run_dma_sha(MSG_BASE, DMA_CTRL_START | DMA_CTRL_SRC_INC);
	check_digest_at(SHA0_BASE, EXPECTED_ZEROS);

	/* --- 2) Flash KAT region (XIP) --- */
	sha_soft_reset_at(SHA0_BASE);
	run_dma_sha(FLASH_KAT, DMA_CTRL_START | DMA_CTRL_SRC_INC);
	check_digest_at(SHA0_BASE, EXPECTED_FLASH);

	/* --- 3) Dual DMA concurrent SRAM KAT under round-robin grant --- */
	fabric.all = mmio_read(REGFILE_SMOKE_BASE + SMOKE_OFF_FABRIC);
	if (fabric.bit.RB_GRANT_EN)
		fail();
	fabric.bit.RB_GRANT_EN = 1;
	mmio_write(REGFILE_SMOKE_BASE + SMOKE_OFF_FABRIC, fabric.all);
	/* Posted pipe: readback is the barrier before DMA contention. */
	fabric.all = mmio_read(REGFILE_SMOKE_BASE + SMOKE_OFF_FABRIC);
	if (!fabric.bit.RB_GRANT_EN)
		fail();

	sha_soft_reset_at(SHA0_BASE);
	sha_soft_reset_at(SHA1_BASE);

	dma_kick(DMA0_BASE, MSG_BASE, DMA_CTRL_START | DMA_CTRL_SRC_INC);
	dma_kick(DMA1_BASE, MSG_BASE, DMA_CTRL_START | DMA_CTRL_SRC_INC);

	wait_dma_done(DMA0_BASE);
	wait_dma_done(DMA1_BASE);
	wait_sha_idle(SHA0_BASE);
	wait_sha_idle(SHA1_BASE);

	check_digest_at(SHA0_BASE, EXPECTED_ZEROS);
	check_digest_at(SHA1_BASE, EXPECTED_ZEROS);

	pass();
	return 0;
}
