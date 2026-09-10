// SPDX-License-Identifier: MIT
//
// Wishbone-regfile SoC smoke (C):
//   RC / RO / RW / RWW (SW + HW counter) / RWE FIFO loopback /
//   W1P / W1C / shadow bank0 / wide key.

#include "../common/soc_map.h"

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

static void expect_eq(uint32_t got, uint32_t want)
{
	mmio_write(TESTOUT_ADDR, got);
	if (got != want)
		fail();
}

static uint32_t smoke_rd(uint32_t off)
{
	return mmio_read(REGFILE_SMOKE_BASE + off);
}

static void smoke_wr(uint32_t off, uint32_t val)
{
	mmio_write(REGFILE_SMOKE_BASE + off, val);
}

static void delay(unsigned n)
{
	volatile unsigned i;
	for (i = 0; i < n; i++)
		;
}

int main(void)
{
	uint32_t v;
	unsigned i;

	mmio_write(TESTOUT_ADDR, MARK_ALIVE);

	/* RC: magic|version */
	expect_eq(smoke_rd(SMOKE_ID), 0x0001a55au);

	/* RO: status readable (counter-backed; just ensure bus works) */
	v = smoke_rd(SMOKE_STATUS);
	mmio_write(TESTOUT_ADDR, v);

	/* RW: write enable + mode, read back */
	smoke_wr(SMOKE_CFG, SMOKE_CFG_ENABLE | (3u << SMOKE_CFG_MODE_SHIFT));
	expect_eq(smoke_rd(SMOKE_CFG) & 0x70fu,
		SMOKE_CFG_ENABLE | (3u << SMOKE_CFG_MODE_SHIFT));

	/* RWW: SW write then observe HW counter overwrite */
	smoke_wr(SMOKE_FEED, 0xabcd);
	expect_eq(smoke_rd(SMOKE_FEED) & 0xffffu, 0xabcdu);
	delay(64);
	v = smoke_rd(SMOKE_FEED) & 0xffffu;
	mmio_write(TESTOUT_ADDR, v);
	if (v == 0xabcdu)
		fail(); /* HW strb should have moved capture */

	/* RWE FIFO loopback: push 3 words, pop them back */
	smoke_wr(SMOKE_FIFO, 0x11111111u);
	smoke_wr(SMOKE_FIFO, 0x22222222u);
	smoke_wr(SMOKE_FIFO, 0x33333333u);
	expect_eq(smoke_rd(SMOKE_FIFO), 0x11111111u);
	expect_eq(smoke_rd(SMOKE_FIFO), 0x22222222u);
	expect_eq(smoke_rd(SMOKE_FIFO), 0x33333333u);

	/* W1P: pulse go (must ACK; value reads as 0) */
	smoke_wr(SMOKE_CMD, SMOKE_CMD_GO);
	expect_eq(smoke_rd(SMOKE_CMD) & 1u, 0u);

	/* W1C: sticky stays 0 after clear write */
	smoke_wr(SMOKE_IRQ, SMOKE_IRQ_STICKY);
	expect_eq(smoke_rd(SMOKE_IRQ) & 1u, 0u);

	/* Shadow bank0 (TGA tied 0): rewrite cfg */
	smoke_wr(SMOKE_BANK, 0x55u);
	expect_eq(smoke_rd(SMOKE_BANK) & 0xffu, 0x55u);

	/* Wide key auto-split */
	smoke_wr(SMOKE_KEY0, 0x01010101u);
	smoke_wr(SMOKE_KEY1, 0x02020202u);
	smoke_wr(SMOKE_KEY2, 0x03030303u);
	expect_eq(smoke_rd(SMOKE_KEY0), 0x01010101u);
	expect_eq(smoke_rd(SMOKE_KEY1), 0x02020202u);
	expect_eq(smoke_rd(SMOKE_KEY2), 0x03030303u);

	/* Fill FIFO to exercise ready stall, then drain */
	for (i = 0; i < 4; i++)
		smoke_wr(SMOKE_FIFO, 0xa0000000u + i);
	for (i = 0; i < 4; i++)
		expect_eq(smoke_rd(SMOKE_FIFO), 0xa0000000u + i);

	pass();
	return 0;
}
