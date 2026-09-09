// SPDX-License-Identifier: MIT
// SDSPI register bits for demo/soc firmware (MIT; logic mirrored from
// ZipCPU sdspi bench/driver constants — do not copy GPL sources here).

#pragma once

#include "soc_map.h"

#define SD0_BASE 0x03000000u

#define SDSPI_CMD_OFF  0x0u
#define SDSPI_DATA_OFF 0x4u
#define SDSPI_FIFO_A   0x8u
#define SDSPI_FIFO_B   0xCu

#define SDSPI_SETAUX   0x0000ffu
#define SDSPI_READAUX  0x0000bfu
#define SDSPI_CMD      0x000040u
#define SDSPI_ACMD     (SDSPI_CMD + 55u)
#define SDSPI_FIFO_OP  0x000800u
#define SDSPI_WRITEOP  0x000c00u
#define SDSPI_FIFO_ID  0x001000u
#define SDSPI_READREG  0x000200u
#define SDSPI_BUSY     0x004000u
#define SDSPI_ERROR    0x008000u
#define SDSPI_CLEARERR 0x008000u
#define SDSPI_REMOVED  0x040000u
#define SDSPI_PRESENTN 0x080000u

#define SDSPI_GO_IDLE ((SDSPI_REMOVED | SDSPI_CLEARERR | SDSPI_CMD) + 0u)
#define SDSPI_READ_SECTOR ((SDSPI_CMD | SDSPI_CLEARERR | SDSPI_FIFO_OP) + 17u)

#define SPEED_SLOW   0x7cu /* ~400 kHz with typical SoC clocks */
#define SPEED_FAST   0x01u
#define SECTOR_512B  0x090000u
