// SPDX-License-Identifier: MIT
// Verilator harness for demo/soc: timed clk/rst; optional SDSPISIM on sd0.

#include "Vtb_soc_vl.h"
#include "verilated.h"

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
#if defined(SOC_USE_SDSPISIM)
static constexpr uint64_t TIMEOUT_NS = 2'000'000'000ull;
#else
static constexpr uint64_t TIMEOUT_NS = 200'000'000ull; /* basic_smoke: SRAM + flash + dual DMA */
#endif

static void usage(const char *argv0)
{
	fprintf(stderr, "usage: %s +firmware=<hex> [+sdcard=<img>]\n", argv0);
}

int main(int argc, char **argv)
{
	const std::unique_ptr<VerilatedContext> ctx{new VerilatedContext};
	ctx->threads(1);
	ctx->commandArgs(argc, argv);

	const char *firmware = nullptr;
	const char *sdcard = nullptr;
	for (int i = 1; i < argc; i++) {
		if (strncmp(argv[i], "+firmware=", 10) == 0)
			firmware = argv[i] + 10;
		else if (strncmp(argv[i], "+sdcard=", 8) == 0)
			sdcard = argv[i] + 8;
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

	while (ctx->time() < TIMEOUT_NS) {
		tick();

		if (top->trap) {
			fprintf(stderr, "FAIL: cpu trap @ %lluns\n",
				(unsigned long long)ctx->time());
			return 1;
		}

		if (!top->test_valid)
			continue;

		uint32_t d = top->test_data;
		printf("testout: %08x\n", d);
		fflush(stdout);

		if (!saw_alive) {
			if (d != MARK_ALIVE) {
				fprintf(stderr, "FAIL: alive marker %08x\n", d);
				return 1;
			}
			saw_alive = true;
			test_count++;
			continue;
		}

		if (d == MARK_FAIL) {
			fprintf(stderr, "FAIL: firmware reported failure\n");
			return 1;
		}
		if (d == MARK_PASS) {
			printf("SMOKE PASS: verilator soc (test_count=%d)\n", test_count);
			return 0;
		}
		test_count++;
	}

	fprintf(stderr, "FAIL: timeout (test_count=%d)\n", test_count);
	return 1;
}
