// SPDX-License-Identifier: MIT
//
// Smoke: init SD0 (sdspi) → CMD17 sector 0 → DMA0 (fixed FIFO A) → SHA256_0.
// Expected digest matches basic_smoke SRAM zeros KAT (sha256 of 64 zero bytes).
//
// Note: picorv32 WB reads drive sel=0; sdspi only advances the FIFO pointer
// when sel!=0. Drain FIFO A via DMA (sel=0xF), not CPU loads.

#include "../common/soc_map.h"
#include "../common/sdspi_regs.h"

#define MSG_WORDS 32u

static const uint32_t EXPECTED[8] = {
	0x42FDA5F5u, 0x30206AD1u, 0x6EEF9827u, 0x9B9709D3u,
	0x233D0043u, 0xE8F0D920u, 0xA93198EAu, 0x4BFB5927u,
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

static uint32_t sd_ctrl(void)
{
	return mmio_read(SD0_BASE + SDSPI_CMD_OFF);
}

static void sd_wait(void)
{
	uint32_t r;
	do {
		r = sd_ctrl();
		if (r & (SDSPI_ERROR | SDSPI_PRESENTN))
			break;
	} while (r & SDSPI_BUSY);
}

static uint32_t sdcmd(uint32_t cmd, uint32_t arg)
{
	mmio_write(SD0_BASE + SDSPI_DATA_OFF, arg);
	mmio_write(SD0_BASE + SDSPI_CMD_OFF, cmd);
	sd_wait();
	return sd_ctrl();
}

static int sd_init(void)
{
	unsigned i;
	uint32_t v;

	mmio_write(SD0_BASE + SDSPI_DATA_OFF, SECTOR_512B | SPEED_SLOW);
	mmio_write(SD0_BASE + SDSPI_CMD_OFF, SDSPI_SETAUX);

	mmio_write(SD0_BASE + SDSPI_DATA_OFF, 0);
	mmio_write(SD0_BASE + SDSPI_CMD_OFF, SDSPI_CLEARERR | SDSPI_READAUX);

	for (i = 0; i < 200000u; i++) {
		if ((sd_ctrl() & SDSPI_PRESENTN) == 0)
			break;
	}
	if (sd_ctrl() & SDSPI_PRESENTN)
		return -1;

	v = sdcmd(SDSPI_GO_IDLE, 0);
	if ((v & 0xffu) != 0x01u)
		return -2;

	v = sdcmd((SDSPI_CMD | SDSPI_READREG) + 8u, 0x01a5u);
	if (mmio_read(SD0_BASE + SDSPI_DATA_OFF) != 0x01a5u)
		return -3;
	(void)v;

	for (i = 0; i < 1500u; i++) {
		if (sdcmd(SDSPI_ACMD, 0) & 0x01u)
			return -4;
		v = sdcmd(SDSPI_CMD + 41u, 0x40000000u);
		if ((v & 0x01u) == 0)
			break;
	}
	if (v & 0x01u)
		return -5;

	v = sdcmd((SDSPI_CMD | SDSPI_READREG) + 58u, 0);
	if (v & SDSPI_ERROR)
		return -6;
	(void)mmio_read(SD0_BASE + SDSPI_DATA_OFF);

	/* Keep SPI clock slow for Verilator cosim reliability. */
	mmio_write(SD0_BASE + SDSPI_DATA_OFF, SECTOR_512B | SPEED_SLOW);
	mmio_write(SD0_BASE + SDSPI_CMD_OFF, SDSPI_SETAUX);
	return 0;
}

static int sd_read_sector0(void)
{
	uint32_t v;

	mmio_write(SD0_BASE + SDSPI_DATA_OFF, SECTOR_512B | SPEED_SLOW);
	mmio_write(SD0_BASE + SDSPI_CMD_OFF, SDSPI_SETAUX);

	v = sdcmd(SDSPI_READ_SECTOR, 0);
	if (v & (SDSPI_ERROR | SDSPI_REMOVED | SDSPI_BUSY))
		return -1;
	return 0;
}

int main(void)
{
	unsigned i;

	mmio_write(TESTOUT_ADDR, MARK_ALIVE);
	if (!regfile_layout_ok())
		fail();

	if (sd_init() != 0)
		fail();
	if (sd_read_sector0() != 0)
		fail();

	sha_soft_reset_at(SHA0_BASE);
	mmio_write(DMA0_BASE + DMA_STATUS, DMA_STATUS_DONE);
	/* Channel DMA sees window-relative addresses (sd @ 0x00). */
	mmio_write(DMA0_BASE + DMA_SRC, CH_SD_OFF + SDSPI_FIFO_A);
	mmio_write(DMA0_BASE + DMA_LEN, MSG_WORDS);
	mmio_write(DMA0_BASE + DMA_CTRL, DMA_CTRL_START);
	(void)mmio_barrier(DMA0_BASE + DMA_STATUS);

	while ((mmio_read(DMA0_BASE + DMA_STATUS) & DMA_STATUS_DONE) == 0)
		;

	while (sha_busy(SHA0_BASE))
		;

	for (i = 0; i < 8; i++) {
		uint32_t got = mmio_read(SHA0_BASE + SHA_HASH0 + 4u * i);
		mmio_write(TESTOUT_ADDR, got);
		if (got != EXPECTED[i])
			fail();
	}

	pass();
	return 0;
}
