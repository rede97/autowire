// demo/soc hooks (dtsim.config.ts; the same for Verilator and VCS).
// Both shell out through ctx.sh: it runs bash in the stage directory with the
// case's isolated env, logs to hook-<stage>.log, and throws on a non-zero exit.
import type { HookContext } from "../../../../src/dtsim/dsl/index.ts";

/** preCompile: ZipCPU sdspi FIFO pointer patch, once per WB beat. Idempotent;
 *  the submodule stays at upstream dfb16c8 otherwise. Compile groups build in
 *  parallel and share the one submodule checkout, so the patch runs once per
 *  dtsim process and every compile awaits the same promise. */
let patched: Promise<string> | undefined;
export async function applyIpPatch(ctx: HookContext): Promise<void> {
	patched ??= ctx.sh(`bash "${ctx.workspace}/patches/apply.sh"`);
	await patched;
}

/** preSim: build the case firmware ($FW, a fw/<dir>) and, for the SD case,
 *  the raw card image ($SD_IMAGE). Both come from the case env. */
export async function buildFirmware(ctx: HookContext): Promise<void> {
	const root = ctx.workspace;
	const fw = ctx.env.FW;
	if (fw) {
		await ctx.sh(
			`export PATH="$HOME/wch/Toolchain/RISC-V Embedded GCC15/bin:$HOME/wch/Toolchain/RISC-V Embedded GCC/bin:$PATH"
make -C "${root}/fw/${fw}"
test -f "${root}/fw/${fw}/build/firmware.hex"`,
		);
	}
	const image = ctx.env.SD_IMAGE;
	if (image) {
		await ctx.sh(
			`python3 "${root}/dt/verilator/images/gen_zeros_sha_img.py" "${image}"`,
		);
	}
}
