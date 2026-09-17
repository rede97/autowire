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
	union SMOKE_ID id;
	union SMOKE_STATUS st;
	union SMOKE_CFG cfg;
	union SMOKE_FEED feed;
	union SMOKE_FIFO fifo;
	union SMOKE_CMD cmd;
	union SMOKE_IRQ irq;
	union SMOKE_BANK bank;
	union SMOKE_BANKSEL banksel;
	union SMOKE_FABRIC fabric;
	union SMOKE_KEY_KEY_0 key0;
	union SMOKE_KEY_KEY_1 key1;
	union SMOKE_KEY_KEY_2 key2;
	unsigned i;

	mmio_write(TESTOUT_ADDR, MARK_ALIVE);
	if (!regfile_layout_ok())
		fail();

	/* RC: magic|version */
	id.all = smoke_rd(SMOKE_OFF_ID);
	expect_eq(id.bit.MAGIC, 0xa55au);
	expect_eq(id.bit.VERSION, 0x0001u);

	/* RO: status readable (counter-backed; just ensure bus works) */
	st.all = smoke_rd(SMOKE_OFF_STATUS);
	mmio_write(TESTOUT_ADDR, st.all);

	/* RW: write enable + mode, read back */
	cfg.all = 0;
	cfg.bit.ENABLE = 1;
	cfg.bit.MODE = 3;
	smoke_wr(SMOKE_OFF_CFG, cfg.all);
	cfg.all = smoke_rd(SMOKE_OFF_CFG);
	expect_eq(cfg.bit.ENABLE, 1u);
	expect_eq(cfg.bit.MODE, 3u);

	/* RW byte select: sb to lane1 (mode) must preserve lane0 (enable) */
	mmio_write8(REGFILE_SMOKE_BASE + SMOKE_OFF_CFG + 1, 0x05u);
	cfg.all = smoke_rd(SMOKE_OFF_CFG);
	expect_eq(cfg.bit.ENABLE, 1u);
	expect_eq(cfg.bit.MODE, 5u);

	/* RWW: sync to a HW strb edge, SW-write 0xabcd, confirm readback, then
	   wait for HW to move the field again. Retry the edge if the posted
	   write loses the 64-cycle window (compiler scheduling / PIPE depth). */
	for (;;) {
		uint32_t edge;

		feed.all = smoke_rd(SMOKE_OFF_FEED);
		edge = feed.bit.CAPTURE;
		do {
			feed.all = smoke_rd(SMOKE_OFF_FEED);
		} while (feed.bit.CAPTURE == edge);
		feed.all = 0;
		feed.bit.CAPTURE = 0xabcd;
		smoke_wr(SMOKE_OFF_FEED, feed.all);
		(void)smoke_rd(SMOKE_OFF_FEED);
		feed.all = smoke_rd(SMOKE_OFF_FEED);
		if (feed.bit.CAPTURE == 0xabcd)
			break;
	}
	mmio_write(TESTOUT_ADDR, 0xabcdu);
	delay(80);
	feed.all = smoke_rd(SMOKE_OFF_FEED);
	mmio_write(TESTOUT_ADDR, feed.bit.CAPTURE);
	if (feed.bit.CAPTURE == 0xabcd)
		fail(); /* HW strb should have moved capture */

	/* RWE FIFO loopback: push 3 words, pop them back */
	fifo.bit.DATA = 0x11111111u;
	smoke_wr(SMOKE_OFF_FIFO, fifo.all);
	fifo.bit.DATA = 0x22222222u;
	smoke_wr(SMOKE_OFF_FIFO, fifo.all);
	fifo.bit.DATA = 0x33333333u;
	smoke_wr(SMOKE_OFF_FIFO, fifo.all);
	fifo.all = smoke_rd(SMOKE_OFF_FIFO);
	expect_eq(fifo.bit.DATA, 0x11111111u);
	fifo.all = smoke_rd(SMOKE_OFF_FIFO);
	expect_eq(fifo.bit.DATA, 0x22222222u);
	fifo.all = smoke_rd(SMOKE_OFF_FIFO);
	expect_eq(fifo.bit.DATA, 0x33333333u);

	/* W1P: pulse go (must ACK; value reads as 0).
	   Wiring: c_rg_sticky_set = p_rg_go, so this also sets the W1C sticky */
	cmd.all = 0;
	cmd.bit.GO = 1;
	smoke_wr(SMOKE_OFF_CMD, cmd.all);
	cmd.all = smoke_rd(SMOKE_OFF_CMD);
	expect_eq(cmd.bit.GO, 0u);

	/* W1C: go pulse set the sticky; write 1 clears it */
	irq.all = smoke_rd(SMOKE_OFF_IRQ);
	expect_eq(irq.bit.STICKY, 1u);
	irq.all = 0;
	irq.bit.STICKY = 1;
	smoke_wr(SMOKE_OFF_IRQ, irq.all);
	irq.all = smoke_rd(SMOKE_OFF_IRQ);
	expect_eq(irq.bit.STICKY, 0u);

	/* Shadow banks: bank_sel CSR drives fabric TGA; per-copy reset defaults */
	bank.all = 0;
	bank.bit.CFG = 0x55u;
	smoke_wr(SMOKE_OFF_BANK, bank.all);
	bank.all = smoke_rd(SMOKE_OFF_BANK);
	expect_eq(bank.bit.CFG, 0x55u);
	banksel.all = 0;
	banksel.bit.BANK_SEL = 1;
	smoke_wr(SMOKE_OFF_BANKSEL, banksel.all);
	bank.all = smoke_rd(SMOKE_OFF_BANK);
	expect_eq(bank.bit.CFG, 0x20u); /* copy1 reset default */
	bank.bit.CFG = 0xaau;
	smoke_wr(SMOKE_OFF_BANK, bank.all);
	bank.all = smoke_rd(SMOKE_OFF_BANK);
	expect_eq(bank.bit.CFG, 0xaau); /* bank1 readback */
	banksel.bit.BANK_SEL = 3;
	smoke_wr(SMOKE_OFF_BANKSEL, banksel.all);
	bank.all = smoke_rd(SMOKE_OFF_BANK);
	expect_eq(bank.bit.CFG, 0x40u); /* copy3 reset default */
	banksel.bit.BANK_SEL = 2;
	smoke_wr(SMOKE_OFF_BANKSEL, banksel.all);
	bank.all = smoke_rd(SMOKE_OFF_BANK);
	expect_eq(bank.bit.CFG, 0x30u); /* copy2 untouched */
	banksel.bit.BANK_SEL = 0;
	smoke_wr(SMOKE_OFF_BANKSEL, banksel.all);
	bank.all = smoke_rd(SMOKE_OFF_BANK);
	expect_eq(bank.bit.CFG, 0x55u); /* bank0 intact */

	/* Wide key auto-split */
	key0.all = 0;
	key0.bit.KEY_0 = 0x01010101u;
	key1.all = 0;
	key1.bit.KEY_1 = 0x02020202u;
	key2.all = 0;
	key2.bit.KEY_2 = 0x03030303u;
	smoke_wr(SMOKE_OFF_KEY0, key0.all);
	smoke_wr(SMOKE_OFF_KEY1, key1.all);
	smoke_wr(SMOKE_OFF_KEY2, key2.all);
	key0.all = smoke_rd(SMOKE_OFF_KEY0);
	key1.all = smoke_rd(SMOKE_OFF_KEY1);
	key2.all = smoke_rd(SMOKE_OFF_KEY2);
	expect_eq(key0.bit.KEY_0, 0x01010101u);
	expect_eq(key1.bit.KEY_1, 0x02020202u);
	expect_eq(key2.bit.KEY_2, 0x03030303u);

	/* FABRIC.rb_grant_en: reset 0; CPU can enable round-robin arbiter */
	fabric.all = smoke_rd(SMOKE_OFF_FABRIC);
	expect_eq(fabric.bit.RB_GRANT_EN, 0u);
	fabric.bit.RB_GRANT_EN = 1;
	smoke_wr(SMOKE_OFF_FABRIC, fabric.all);
	fabric.all = smoke_rd(SMOKE_OFF_FABRIC);
	expect_eq(fabric.bit.RB_GRANT_EN, 1u);
	fabric.bit.RB_GRANT_EN = 0;
	smoke_wr(SMOKE_OFF_FABRIC, fabric.all);
	fabric.all = smoke_rd(SMOKE_OFF_FABRIC);
	expect_eq(fabric.bit.RB_GRANT_EN, 0u);

	/* Fill FIFO to exercise ready stall, then drain */
	for (i = 0; i < 4; i++) {
		fifo.bit.DATA = 0xa0000000u + i;
		smoke_wr(SMOKE_OFF_FIFO, fifo.all);
	}
	for (i = 0; i < 4; i++) {
		fifo.all = smoke_rd(SMOKE_OFF_FIFO);
		expect_eq(fifo.bit.DATA, 0xa0000000u + i);
	}

	pass();
	return 0;
}
