// SPDX-License-Identifier: MIT
//
// Basic Verilator smoke (top decoder cascaded into two sd_sha channels):
//   1) Layout unions + smoke ID via parent decoder
//   2) SHA0/SHA1 CTRL via SlaveBus cascade (soft-reset, BUSY=0)
//   3) FABRIC.rb_grant_en drives both channel arbiters (reset 0, then 1)
// Channel DMA cannot reach SRAM/flash; SD→SHA DMA is --sd (sd_sha256).

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

static void check_sha_idle(uint32_t sha_base)
{
	sha_soft_reset_at(sha_base);
	if (sha_busy(sha_base))
		fail();
}

int main(void)
{
	union SMOKE_FABRIC fabric;
	uint32_t id;

	mmio_write(TESTOUT_ADDR, MARK_ALIVE);
	if (!regfile_layout_ok())
		fail();

	id = mmio_read(REGFILE_SMOKE_BASE + SMOKE_OFF_ID);
	mmio_write(TESTOUT_ADDR, id);
	if (id == 0)
		fail();

	check_sha_idle(SHA0_BASE);
	check_sha_idle(SHA1_BASE);

	fabric.all = mmio_read(REGFILE_SMOKE_BASE + SMOKE_OFF_FABRIC);
	if (fabric.bit.RB_GRANT_EN)
		fail();
	fabric.bit.RB_GRANT_EN = 1;
	mmio_write(REGFILE_SMOKE_BASE + SMOKE_OFF_FABRIC, fabric.all);
	fabric.all = mmio_read(REGFILE_SMOKE_BASE + SMOKE_OFF_FABRIC);
	if (!fabric.bit.RB_GRANT_EN)
		fail();

	pass();
	return 0;
}
