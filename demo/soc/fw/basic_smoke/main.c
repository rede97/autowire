// SPDX-License-Identifier: MIT
//
// Basic Verilator smoke (two KATs on SHA256_0 via DMA0):
//   1) SRAM: 64 zero bytes + soft pad
//   2) Flash XIP region 0x0100_1000: legacy gen_firmware.py message words
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

static void sha_soft_reset(void)
{
	mmio_write(SHA0_BASE + SHA_CTRL, SHA_SOFT_RESET);
	mmio_write(SHA0_BASE + SHA_CTRL, 0);
	mmio_write(SHA0_BASE + SHA_CTRL, SHA_DONE_CLEAR);
}

static void dma_clear_done(void)
{
	mmio_write(DMA0_BASE + DMA_STATUS, DMA_STATUS_DONE);
}

static void run_dma_sha(uint32_t src, uint32_t ctrl)
{
	dma_clear_done();
	mmio_write(DMA0_BASE + DMA_SRC, src);
	mmio_write(DMA0_BASE + DMA_LEN, MSG_WORDS);
	mmio_write(DMA0_BASE + DMA_CTRL, ctrl);

	while ((mmio_read(DMA0_BASE + DMA_STATUS) & DMA_STATUS_DONE) == 0)
		;

	while ((mmio_read(SHA0_BASE + SHA_CTRL) & SHA_BUSY) != 0)
		;
}

static void check_digest(const uint32_t *expected)
{
	unsigned i;

	for (i = 0; i < 8; i++) {
		uint32_t got = mmio_read(SHA0_BASE + SHA_HASH0 + 4u * i);
		mmio_write(TESTOUT_ADDR, got);
		if (got != expected[i])
			fail();
	}
}

int main(void)
{
	unsigned i;

	mmio_write(TESTOUT_ADDR, MARK_ALIVE);

	/* --- 1) SRAM zeros + soft pad --- */
	for (i = 0; i < 16; i++)
		mmio_write(MSG_BASE + i * 4u, 0);
	mmio_write(MSG_BASE + 16u * 4u, 0x00000080u);
	for (i = 17; i < 31; i++)
		mmio_write(MSG_BASE + i * 4u, 0);
	mmio_write(MSG_BASE + 31u * 4u, 0x00020000u);

	run_dma_sha(MSG_BASE, DMA_CTRL_START | DMA_CTRL_SRC_INC);
	check_digest(EXPECTED_ZEROS);

	/* --- 2) Flash KAT region (XIP) --- */
	sha_soft_reset();
	run_dma_sha(FLASH_KAT, DMA_CTRL_START | DMA_CTRL_SRC_INC);
	check_digest(EXPECTED_FLASH);

	pass();
	return 0;
}
