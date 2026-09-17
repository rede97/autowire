# Build sd_sha256 smoke firmware for demo/soc (RV32IMC, flash XIP).
# CROSS= override, e.g. CROSS=riscv32-wch-elf-

FW_ROOT := $(abspath ..)
COMMON  := $(FW_ROOT)/common
BUILD   := build

# Prefer common open/WCH prefixes if CROSS unset.
ifeq ($(CROSS),)
  ifneq ($(shell command -v riscv32-wch-elf-gcc 2>/dev/null),)
    CROSS := riscv32-wch-elf-
  else ifneq ($(shell command -v riscv-none-embed-gcc 2>/dev/null),)
    CROSS := riscv-none-embed-
  else ifneq ($(shell command -v riscv64-unknown-elf-gcc 2>/dev/null),)
    CROSS := riscv64-unknown-elf-
  else
    CROSS := riscv32-unknown-elf-
  endif
endif

CC      := $(CROSS)gcc
OBJCOPY := $(CROSS)objcopy
OBJDUMP := $(CROSS)objdump

REGFILE := $(FW_ROOT)/gen/regfile
CFLAGS  := -march=rv32imc -mabi=ilp32 -Os -g -ffreestanding -nostdlib \
	-fno-builtin -Wall -Wextra -Wno-array-bounds -I$(COMMON) -I$(REGFILE)
LDFLAGS := -T $(COMMON)/link.ld -nostdlib -Wl,--gc-sections

OBJS := $(BUILD)/crt0.o $(BUILD)/main.o

.PHONY: all clean

all: $(BUILD)/firmware.hex $(BUILD)/firmware.elf

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/crt0.o: $(COMMON)/crt0.S | $(BUILD)
	$(CC) $(CFLAGS) -c -o $@ $<

$(BUILD)/main.o: main.c $(COMMON)/soc_map.h $(COMMON)/sdspi_regs.h \
		$(REGFILE)/smoke.h $(REGFILE)/sha256.h | $(BUILD)
	$(CC) $(CFLAGS) -c -o $@ $<

$(BUILD)/firmware.elf: $(OBJS) $(COMMON)/link.ld
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $(OBJS)
	$(OBJDUMP) -d $@ > $(BUILD)/firmware.lst

$(BUILD)/firmware.bin: $(BUILD)/firmware.elf
	$(OBJCOPY) -O binary $< $@

$(BUILD)/firmware.hex: $(BUILD)/firmware.bin $(COMMON)/makehex.py
	python3 $(COMMON)/makehex.py $< > $@

clean:
	rm -rf $(BUILD)
