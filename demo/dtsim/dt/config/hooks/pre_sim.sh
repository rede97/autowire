#!/usr/bin/env bash
# preSim hook (demo/dtsim): per-seed input the simulation reads. Here: a
# stimulus file whose contents follow the seed, so a failing seed can be
# replayed from its directory (run_sim -s <seed>). Other uses: build the
# firmware image (demo/soc), stage test vectors, start a co-simulation peer.
# Args: --phase --case --seed --dir <seed dir> --tool --log.
set -euo pipefail
while [[ $# -gt 0 ]]; do
	case "$1" in
	--seed) SEED="$2"; shift 2 ;;
	--dir) DIR="$2"; shift 2 ;;
	*) shift 2 ;;
	esac
done
RANDOM=$((SEED % 32768))
for _ in 1 2 3 4; do printf '%08x\n' $((RANDOM * RANDOM)); done >"$DIR/stim.hex"
echo "pre_sim: wrote $DIR/stim.hex for seed $SEED"
