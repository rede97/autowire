# Verilator SoC harness (run from demo/soc via ./sim/verilator/run.sh).
SOC_ROOT ?= $(abspath ../..)
VL_DIR   := $(abspath .)
# Separate trees so flipping USE_SD=0/1 never reuses a stale binary.
OBJ_DIR  := $(VL_DIR)/obj_dir$(if $(filter 1,$(USE_SD)),_sd,)
TOP      := tb_soc_vl

VERILATOR ?= verilator
CXX       ?= g++

# Phase C: make USE_SD=1
USE_SD ?= 0

CXXFLAGS_COMMON := -O2 -std=c++17 -I$(VL_DIR)
LDFLAGS_COMMON  := -pthread

ifeq ($(USE_SD),1)
  CXXFLAGS_COMMON += -DSOC_USE_SDSPISIM -I$(VL_DIR)/third_party/sdspisim
endif

VL_WARN := -Wno-fatal \
	-Wno-WIDTH \
	-Wno-CASEINCOMPLETE \
	-Wno-UNOPTFLAT \
	-Wno-BLKANDNBLK \
	-Wno-INITIALDLY \
	-Wno-TIMESCALEMOD

VL_FLAGS := -Wall --cc --exe --build -j 0 \
	--top-module $(TOP) \
	--Mdir $(OBJ_DIR) \
	--timing \
	$(VL_WARN) \
	-CFLAGS "$(CXXFLAGS_COMMON)" \
	-LDFLAGS "$(LDFLAGS_COMMON)"

SRCS := $(VL_DIR)/tb_main.cpp

ifeq ($(USE_SD),1)
  SRCS += $(VL_DIR)/third_party/sdspisim/sdspisim.cpp
endif

.PHONY: all tb_mod clean

all: $(OBJ_DIR)/V$(TOP)

# RTL sources from filelist.f (comments/blanks stripped) — rebuild on leaf edits.
RTL_SRCS := $(shell grep -vE '^\s*(#|$$)' $(VL_DIR)/filelist.f | sed 's|^|$(SOC_ROOT)/|')

$(OBJ_DIR)/V$(TOP): $(VL_DIR)/filelist.f $(VL_DIR)/tb_soc_vl.sv $(VL_DIR)/spiflash_vl.sv $(VL_DIR)/jtag_host.h $(SRCS) $(RTL_SRCS)
	cd $(SOC_ROOT) && $(VERILATOR) $(VL_FLAGS) \
		-f $(VL_DIR)/filelist.f \
		$(SRCS) \
		-o V$(TOP)

# aw-tb-mod dump top (rtl/gen/sim/tb_soc.sv + sim/*.svh): pure SV, --binary.
TB_OBJ  := $(VL_DIR)/obj_dir_tb
TB_RTL  := $(filter-out %/tb_soc_vl.sv,$(RTL_SRCS))
TB_SVH  := $(wildcard $(SOC_ROOT)/sim/*.svh)

tb_mod: $(TB_OBJ)/Vtb_soc

$(TB_OBJ)/Vtb_soc: $(VL_DIR)/filelist.f $(SOC_ROOT)/rtl/gen/sim/tb_soc.sv $(TB_SVH) $(TB_RTL)
	cd $(SOC_ROOT) && $(VERILATOR) --binary --timing -j 0 \
		--top-module tb_soc \
		--Mdir $(TB_OBJ) \
		$(VL_WARN) \
		-CFLAGS "$(CXXFLAGS_COMMON)" \
		-LDFLAGS "$(LDFLAGS_COMMON)" \
		-Isim \
		sim/tb_timescale.sv rtl/gen/sim/tb_soc.sv \
		$(TB_RTL) \
		-o Vtb_soc

clean:
	rm -rf $(VL_DIR)/obj_dir $(VL_DIR)/obj_dir_sd $(TB_OBJ)
