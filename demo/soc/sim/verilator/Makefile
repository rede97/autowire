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

VL_FLAGS := -Wall --cc --exe --build -j 0 \
	--top-module $(TOP) \
	--Mdir $(OBJ_DIR) \
	--timing \
	-Wno-fatal \
	-Wno-WIDTH \
	-Wno-CASEINCOMPLETE \
	-Wno-UNOPTFLAT \
	-Wno-BLKANDNBLK \
	-Wno-INITIALDLY \
	-Wno-TIMESCALEMOD \
	-CFLAGS "$(CXXFLAGS_COMMON)" \
	-LDFLAGS "$(LDFLAGS_COMMON)"

SRCS := $(VL_DIR)/tb_main.cpp

ifeq ($(USE_SD),1)
  SRCS += $(VL_DIR)/third_party/sdspisim/sdspisim.cpp
endif

.PHONY: all clean

all: $(OBJ_DIR)/V$(TOP)

# RTL sources from filelist.f (comments/blanks stripped) — rebuild on leaf edits.
RTL_SRCS := $(shell grep -vE '^\s*(#|$$)' $(VL_DIR)/filelist.f | sed 's|^|$(SOC_ROOT)/|')

$(OBJ_DIR)/V$(TOP): $(VL_DIR)/filelist.f $(VL_DIR)/tb_soc_vl.sv $(VL_DIR)/spiflash_vl.sv $(SRCS) $(RTL_SRCS)
	cd $(SOC_ROOT) && $(VERILATOR) $(VL_FLAGS) \
		-f $(VL_DIR)/filelist.f \
		$(SRCS) \
		-o V$(TOP)

clean:
	rm -rf $(VL_DIR)/obj_dir $(VL_DIR)/obj_dir_sd
