// SPDX-License-Identifier: MIT
// Verilator harness for demo/soc: timed clk/rst; external JTAG host running
// concurrently with the CPU firmware; optional SDSPISIM on sd0.

#include "Vtb_soc_vl.h"
#include "jtag_host.h"
#include "verilated.h"

// MinGW ld does not honor the weak sc_time_stamp Verilator declares for
// legacy $time. The harness drives time via VerilatedContext::timeInc.
double sc_time_stamp() { return 0; }

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>

#if defined(SOC_USE_SDSPISIM)
#include "sdspisim.h"
#endif

static constexpr uint32_t MARK_ALIVE = 0x00000001u;
static constexpr uint32_t MARK_FAIL = 0xdead0001u;
static constexpr uint32_t MARK_PASS = 0x600d600du;
static constexpr uint64_t HALF_NS = 5;
static constexpr int TCK_HALF_TICKS = 10; /* 10 MHz TCK against 100 MHz clk */
#if defined(SOC_USE_SDSPISIM)
static constexpr uint64_t TIMEOUT_NS = 2'000'000'000ull;
#else
static constexpr uint64_t TIMEOUT_NS = 200'000'000ull; /* basic_smoke: SRAM + flash + dual DMA */
#endif

static void usage(const char *argv0)
{
	fprintf(stderr, "usage: %s +firmware=<hex> [+sdcard=<img>] [+nojtag]\n", argv0);
}

int main(int argc, char **argv)
{
	const std::unique_ptr<VerilatedContext> ctx{new VerilatedContext};
	ctx->threads(1);
	ctx->commandArgs(argc, argv);

	const char *firmware = nullptr;
	const char *sdcard = nullptr;
	bool use_jtag = true;
	for (int i = 1; i < argc; i++) {
		if (strncmp(argv[i], "+firmware=", 10) == 0)
			firmware = argv[i] + 10;
		else if (strncmp(argv[i], "+sdcard=", 8) == 0)
			sdcard = argv[i] + 8;
		else if (strcmp(argv[i], "+nojtag") == 0)
			use_jtag = false;
		else if (strcmp(argv[i], "-h") == 0 || strcmp(argv[i], "--help") == 0) {
			usage(argv[0]);
			return 0;
		}
	}
	if (!firmware) {
		usage(argv[0]);
		return 2;
	}
	(void)firmware;

	auto top = std::make_unique<Vtb_soc_vl>(ctx.get());

#if defined(SOC_USE_SDSPISIM)
	std::unique_ptr<SDSPISIM> card;
	if (sdcard) {
		card = std::make_unique<SDSPISIM>(false);
		card->load(sdcard);
	}
#else
	if (sdcard)
		fprintf(stderr, "built without SOC_USE_SDSPISIM; ignore +sdcard\n");
#endif

	top->clk = 0;
	top->rst_ni = 0;
	/* sdspi: i_card_detect high = present (after debounce). */
	top->sd0_miso = 1;
	top->sd0_cd = 1;

	auto sample_sd = [&]() {
#if defined(SOC_USE_SDSPISIM)
		if (card) {
			top->sd0_miso =
				(*card)(top->sd0_cs_n, top->sd0_sck, top->sd0_mosi);
			top->sd0_cd = 1;
		}
#endif
	};

	auto tick = [&]() {
		ctx->timeInc(HALF_NS);
		top->clk = !top->clk;
		top->eval();
		sample_sd();
		top->eval();
	};

	for (int i = 0; i < 200; i++)
		tick();
	top->rst_ni = 1;

	int test_count = 0;
	bool saw_alive = false;
	bool fw_pass = false;

	/* One clk edge plus firmware checks; exits on trap / FAIL / timeout. */
	auto step = [&]() {
		tick();
		if (ctx->time() >= TIMEOUT_NS) {
			fprintf(stderr, "FAIL: timeout (test_count=%d, fw_pass=%d)\n",
				test_count, fw_pass);
			exit(1);
		}
		if (top->trap) {
			fprintf(stderr, "FAIL: cpu trap @ %lluns\n",
				(unsigned long long)ctx->time());
			exit(1);
		}
		if (!top->test_valid)
			return;

		uint32_t d = top->test_data;
		printf("testout: %08x\n", d);
		fflush(stdout);

		if (!saw_alive) {
			if (d != MARK_ALIVE) {
				fprintf(stderr, "FAIL: alive marker %08x\n", d);
				exit(1);
			}
			saw_alive = true;
			test_count++;
			return;
		}
		if (d == MARK_FAIL) {
			fprintf(stderr, "FAIL: firmware reported failure\n");
			exit(1);
		}
		if (d == MARK_PASS)
			fw_pass = true;
		else if (!fw_pass)
			test_count++;
	};

	JtagHost<Vtb_soc_vl> jtag(top.get(), [&]() {
		for (int i = 0; i < TCK_HALF_TICKS; i++)
			step();
	});
	for (int i = 0; i < 40; i++)
		step();
	if (use_jtag && !jtag.run())
		return 1;

	while (!fw_pass)
		step();
	printf("SMOKE PASS: verilator soc%s (test_count=%d)\n",
	       use_jtag ? " + external JTAG" : "", test_count);
	return 0;
}
