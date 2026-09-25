// SPDX-License-Identifier: MIT
// External JTAG host for tb_soc_vl: bit-bangs the soc_top jtag_* pins while
// the CPU firmware runs, so both masters share the soc_wb arbiter.
// Sequence: IDCODE after TLR, IR capture, BYPASS 1-bit delay, then the USER
// TDR (wb_jtag_tdr behind demo_tap) reads the smoke ID and writes + reads
// back an SRAM word the firmware does not use. After the firmware has passed,
// banks() writes every address-aliased BANK.cfg and reads ACTIVE, which is
// the copy selected by BANKSEL (i_bank_mux_sel), not the access tag.
//
// USER DR (66 bit, LSB first): shift {op[1:0], adr[31:0], dat[31:0]},
// capture {st[1:0], adr, rdat}; op 1 read / 2 write; st 0 ok / 1 busy / 2 err.
#pragma once

#include <cstdint>
#include <cstdio>
#include <functional>

template <class Top> class JtagHost {
    public:
	static constexpr uint32_t IDCODE = 0x1a570001u;
	static constexpr uint32_t SMOKE_ID_ADR = 0x03006000u;
	static constexpr uint32_t SMOKE_ID = 0x0001a55au;
	static constexpr uint32_t SRAM_ADR = 0x00008000u;
	static constexpr uint32_t SRAM_DAT = 0xc0de7a90u;
	static constexpr uint32_t SMOKE_BASE = 0x03006000u;
	static constexpr uint32_t BANK_OFF = 0x1cu;
	static constexpr uint32_t BANKSEL_OFF = 0x2cu;
	static constexpr uint32_t ACTIVE_OFF = 0x34u;

	/* half_period advances the simulation by one TCK half period. */
	JtagHost(Top *top, std::function<void()> half_period)
		: top_(top), half_(std::move(half_period))
	{
		top_->jtag_tck = 0;
		top_->jtag_tms = 1;
		top_->jtag_tdi = 0;
		top_->jtag_trst_n = 0;
	}

	/* Returns true on success; prints the first mismatch otherwise. */
	bool run()
	{
		top_->jtag_trst_n = 1;
		for (int i = 0; i < 5; i++)
			clk(1, 0); /* Test-Logic-Reset */
		clk(0, 0);         /* Run-Test/Idle */

		Bits o = shift(false, {0, 0}, 32);
		if (!expect("IDCODE", uint32_t(o.lo), IDCODE))
			return false;

		o = shift(true, {IR_BYPASS, 0}, 4);
		if (!expect("IR capture", uint32_t(o.lo & 3), 1))
			return false;
		o = shift(false, {0xb5, 0}, 9);
		if (!expect("BYPASS", uint32_t(o.lo & 0x1ff), 0xb5u << 1))
			return false;

		shift(true, {IR_USER, 0}, 4);

		uint32_t rd = 0;
		if (!wb(OP_READ, SMOKE_ID_ADR, 0, rd, "smoke ID") ||
		    !expect("smoke ID", rd, SMOKE_ID))
			return false;
		if (!wb(OP_WRITE, SRAM_ADR, SRAM_DAT, rd, "SRAM write"))
			return false;
		if (!wb(OP_READ, SRAM_ADR, 0, rd, "SRAM read") ||
		    !expect("SRAM readback", rd, SRAM_DAT))
			return false;

		printf("JTAG SMOKE PASS: IDCODE %08x, BYPASS, smoke ID %08x, "
		       "SRAM[%08x] = %08x\n",
		       IDCODE, SMOKE_ID, SRAM_ADR, rd);
		fflush(stdout);
		return true;
	}

	/* Address aliases select the accessed bank. ACTIVE reads rg_cfg, which
	   follows BANKSEL rather than the alias used for this transaction. */
	bool banks()
	{
		uint32_t rd = 0;
		uint32_t sel = 0;
		if (!wb(OP_READ, SMOKE_BASE + BANKSEL_OFF, 0, sel, "BANKSEL"))
			return false;
		sel &= 3u;
		for (uint32_t i = 0; i < 4; i++) {
			char what[32];
			snprintf(what, sizeof what, "bank %u write", i);
			if (!wb(OP_WRITE, SMOKE_BASE + BANK_OFF + (i << 27), 0xa0u + i, rd, what))
				return false;
		}
		if (!wb(OP_READ, SMOKE_BASE + BANKSEL_OFF, 0, rd, "BANKSEL unchanged") ||
		    !expect("BANKSEL unchanged", rd & 3u, sel))
			return false;
		for (uint32_t i = 0; i < 4; i++) {
			char what[32];
			snprintf(what, sizeof what, "bank %u read", i);
			if (!wb(OP_READ, SMOKE_BASE + BANK_OFF + (i << 27), 0, rd, what) ||
			    !expect(what, rd & 0xffu, 0xa0u + i))
				return false;
		}
		/* Alias 1 must not change the copy selected by the saved BANKSEL. */
		if (!wb(OP_READ, SMOKE_BASE + ACTIVE_OFF + (1u << 27), 0, rd, "ACTIVE") ||
		    !expect("ACTIVE via bank 1", rd & 0xffu, 0xa0u + sel))
			return false;
		if (!wb(OP_WRITE, SMOKE_BASE + BANKSEL_OFF, 3u, rd, "BANKSEL write"))
			return false;
		if (!wb(OP_READ, SMOKE_BASE + ACTIVE_OFF, 0, rd, "ACTIVE after sel") ||
		    !expect("ACTIVE via bank 0", rd & 0xffu, 0xa3u))
			return false;

		printf("JTAG BANK PASS: aliases 0-3, ACTIVE follows BANKSEL\n");
		fflush(stdout);
		return true;
	}

    private:
	struct Bits {
		uint64_t lo, hi;
	};

	static constexpr uint64_t IR_USER = 0x8;
	static constexpr uint64_t IR_BYPASS = 0xf;
	static constexpr int DR_BITS = 66;
	static constexpr uint64_t OP_READ = 1;
	static constexpr uint64_t OP_WRITE = 2;
	static constexpr int POLL_TRIES = 64;
	static constexpr int POLL_IDLE = 16;

	Top *top_;
	std::function<void()> half_;

	/* One TCK: TMS/TDI set on the low phase, TDO sampled before the rise. */
	bool clk(bool tms, bool tdi)
	{
		top_->jtag_tms = tms;
		top_->jtag_tdi = tdi;
		half_();
		const bool tdo = top_->jtag_tdo;
		top_->jtag_tck = 1;
		half_();
		top_->jtag_tck = 0;
		return tdo;
	}

	/* Run-Test/Idle -> Shift-xR -> n bits -> Update-xR -> Run-Test/Idle. */
	Bits shift(bool ir, Bits din, int n)
	{
		Bits dout{0, 0};
		clk(1, 0); /* Select-DR */
		if (ir)
			clk(1, 0); /* Select-IR */
		clk(0, 0); /* Capture */
		clk(0, 0); /* Shift */
		for (int i = 0; i < n; i++) {
			const bool b = i < 64 ? (din.lo >> i) & 1 : (din.hi >> (i - 64)) & 1;
			const bool t = clk(i == n - 1, b); /* last bit exits to Exit1 */
			if (i < 64)
				dout.lo |= uint64_t(t) << i;
			else
				dout.hi |= uint64_t(t) << (i - 64);
		}
		clk(1, 0); /* Update */
		clk(0, 0); /* Run-Test/Idle */
		return dout;
	}

	/* Launch one WB access on the USER TDR, then poll status with nop scans. */
	bool wb(uint64_t op, uint32_t adr, uint32_t dat, uint32_t &rdat, const char *what)
	{
		shift(false, {(uint64_t(adr) << 32) | dat, op}, DR_BITS);
		uint32_t st = 1;
		for (int i = 0; i < POLL_TRIES && st == 1; i++) {
			for (int k = 0; k < POLL_IDLE; k++)
				clk(0, 0);
			const Bits o = shift(false, {0, 0}, DR_BITS);
			st = uint32_t(o.hi & 3);
			rdat = uint32_t(o.lo);
		}
		char label[48];
		snprintf(label, sizeof label, "%s status", what);
		return expect(label, st, 0);
	}

	static bool expect(const char *what, uint32_t got, uint32_t exp)
	{
		if (got == exp)
			return true;
		fprintf(stderr, "FAIL: jtag %s got %08x expected %08x\n", what, got, exp);
		return false;
	}
};
