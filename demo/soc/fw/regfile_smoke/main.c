// SPDX-License-Identifier: MIT
//
// Wishbone-regfile SoC smoke (C):
//   RC / RO / RW (+SEL byte write) / RWW (SW + HW counter) / RWE FIFO loopback /
//   W1P / W1C (HW set via p_rg_go) / shadow banks 0-3 via bank_sel TGA / wide key.

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

	/* RW byte select: sb to lane1 (mode) must preserve lane0 (enable) */
	mmio_write8(REGFILE_SMOKE_BASE + SMOKE_CFG + 1, 0x05u);
	expect_eq(smoke_rd(SMOKE_CFG) & 0x70fu,
		SMOKE_CFG_ENABLE | (5u << SMOKE_CFG_MODE_SHIFT));

	/* RWW: sync to the HW strb edge, then SW write reads back inside one period */
	v = smoke_rd(SMOKE_FEED) & 0xffffu;
	while ((smoke_rd(SMOKE_FEED) & 0xffffu) == v)
		;
	smoke_wr(SMOKE_FEED, 0xabcd);
	expect_eq(smoke_rd(SMOKE_FEED) & 0xffffu, 0xabcdu);
	delay(80);
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

	/* W1P: pulse go (must ACK; value reads as 0).
	   Wiring: c_rg_sticky_set = p_rg_go, so this also sets the W1C sticky */
	smoke_wr(SMOKE_CMD, SMOKE_CMD_GO);
	expect_eq(smoke_rd(SMOKE_CMD) & 1u, 0u);

	/* W1C: go pulse set the sticky; write 1 clears it */
	expect_eq(smoke_rd(SMOKE_IRQ) & 1u, 1u);
	smoke_wr(SMOKE_IRQ, SMOKE_IRQ_STICKY);
	expect_eq(smoke_rd(SMOKE_IRQ) & 1u, 0u);

	/* Shadow banks: bank_sel CSR drives fabric TGA; per-copy reset defaults */
	smoke_wr(SMOKE_BANK, 0x55u);
	expect_eq(smoke_rd(SMOKE_BANK) & 0xffu, 0x55u);
	smoke_wr(SMOKE_BANKSEL, 1u);
	expect_eq(smoke_rd(SMOKE_BANK) & 0xffu, 0x20u); /* copy1 reset default */
	smoke_wr(SMOKE_BANK, 0xaau);
	expect_eq(smoke_rd(SMOKE_BANK) & 0xffu, 0xaau); /* bank1 readback */
	smoke_wr(SMOKE_BANKSEL, 3u);
	expect_eq(smoke_rd(SMOKE_BANK) & 0xffu, 0x40u); /* copy3 reset default */
	smoke_wr(SMOKE_BANKSEL, 2u);
	expect_eq(smoke_rd(SMOKE_BANK) & 0xffu, 0x30u); /* copy2 untouched */
	smoke_wr(SMOKE_BANKSEL, 0u);
	expect_eq(smoke_rd(SMOKE_BANK) & 0xffu, 0x55u); /* bank0 intact */

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
