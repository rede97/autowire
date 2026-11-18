// SPDX-License-Identifier: MIT
// Edge-sampled QSPI flash model for VL (no # delays / inout Z).
// Protocol subset used by picosoc spimemio: 0xAB wake, 0x03/0xBB/0xEB reads.
`timescale 1ns / 1ps
module spiflash_vl (
	input  wire csb,
	input  wire clk,
	input  wire io0_di,
	input  wire io1_di,
	input  wire io2_di,
	input  wire io3_di,
	output reg  io0_do,
	output reg  io1_do,
	output reg  io2_do,
	output reg  io3_do,
	output reg  io0_oe,
	output reg  io1_oe,
	output reg  io2_oe,
	output reg  io3_oe
);

	localparam [2:0]
		M_SPI = 0,
		M_DSPI_RD = 1,
		M_DSPI_WR = 2,
		M_QSPI_RD = 3,
		M_QSPI_WR = 4;

	reg [7:0] memory [0:16*1024*1024-1];
	reg [1023:0] firmware_file;
	initial begin
		if (!$value$plusargs("firmware=%s", firmware_file))
			firmware_file = "firmware.hex";
		$readmemh(firmware_file, memory);
	end

	reg powered_up = 0;
	reg [7:0] spi_cmd;
	reg [7:0] xip_cmd = 0;
	reg [23:0] spi_addr;
	reg [7:0] buffer;
	reg [3:0] bitcount;
	reg [7:0] bytecount;
	reg [2:0] mode;
	// Init required for 4-state simulators (VCS): X would mask every output
	// enable (dummycount == 0 test fails on X). Verilator zero-inits anyway.
	reg [7:0] dummycount = 0;
	integer latency = 8;

	task automatic spi_action;
		begin
			if (bytecount == 1) begin
				spi_cmd = buffer;
				if (spi_cmd == 8'hab)
					powered_up = 1;
				if (spi_cmd == 8'hb9)
					powered_up = 0;
				if (spi_cmd == 8'hff)
					xip_cmd = 0;
			end

			if (powered_up && spi_cmd == 8'h03) begin
				if (bytecount == 2) spi_addr[23:16] = buffer;
				if (bytecount == 3) spi_addr[15:8] = buffer;
				if (bytecount == 4) spi_addr[7:0] = buffer;
				if (bytecount >= 4) begin
					buffer = memory[spi_addr];
					spi_addr = spi_addr + 1;
				end
			end

			if (powered_up && spi_cmd == 8'hbb) begin
				if (bytecount == 1) mode = M_DSPI_RD;
				if (bytecount == 2) spi_addr[23:16] = buffer;
				if (bytecount == 3) spi_addr[15:8] = buffer;
				if (bytecount == 4) spi_addr[7:0] = buffer;
				if (bytecount == 5) begin
					xip_cmd = (buffer == 8'ha5) ? spi_cmd : 8'h00;
					mode = M_DSPI_WR;
					dummycount = latency;
				end
				if (bytecount >= 5) begin
					buffer = memory[spi_addr];
					spi_addr = spi_addr + 1;
				end
			end

			if (powered_up && spi_cmd == 8'heb) begin
				if (bytecount == 1) mode = M_QSPI_RD;
				if (bytecount == 2) spi_addr[23:16] = buffer;
				if (bytecount == 3) spi_addr[15:8] = buffer;
				if (bytecount == 4) spi_addr[7:0] = buffer;
				if (bytecount == 5) begin
					xip_cmd = (buffer == 8'ha5) ? spi_cmd : 8'h00;
					mode = M_QSPI_WR;
					dummycount = latency;
				end
				if (bytecount >= 5) begin
					buffer = memory[spi_addr];
					spi_addr = spi_addr + 1;
				end
			end
		end
	endtask

	always @(posedge csb) begin
		buffer = 0;
		bitcount = 0;
		bytecount = 0;
		mode = M_SPI;
		io0_oe = 0;
		io1_oe = 0;
		io2_oe = 0;
		io3_oe = 0;
	end

	always @(negedge csb) begin
		if (xip_cmd) begin
			buffer = xip_cmd;
			bitcount = 0;
			bytecount = 1;
			spi_action;
		end
	end

	// Drive outputs while clk low (SPI mode 0 style).
	always @(negedge clk or posedge csb) begin
		if (csb) begin
			io0_oe = 0;
			io1_oe = 0;
			io2_oe = 0;
			io3_oe = 0;
		end else if (dummycount == 0) begin
			case (mode)
				M_SPI: begin
					io0_oe = 0;
					io1_oe = 1;
					io2_oe = 0;
					io3_oe = 0;
					io1_do = buffer[7];
				end
				M_DSPI_RD: begin
					io0_oe = 0;
					io1_oe = 0;
					io2_oe = 0;
					io3_oe = 0;
				end
				M_DSPI_WR: begin
					io0_oe = 1;
					io1_oe = 1;
					io2_oe = 0;
					io3_oe = 0;
					io0_do = buffer[6];
					io1_do = buffer[7];
				end
				M_QSPI_RD: begin
					io0_oe = 0;
					io1_oe = 0;
					io2_oe = 0;
					io3_oe = 0;
				end
				M_QSPI_WR: begin
					io0_oe = 1;
					io1_oe = 1;
					io2_oe = 1;
					io3_oe = 1;
					io0_do = buffer[4];
					io1_do = buffer[5];
					io2_do = buffer[6];
					io3_do = buffer[7];
				end
				default: begin
					io0_oe = 0;
					io1_oe = 0;
					io2_oe = 0;
					io3_oe = 0;
				end
			endcase
		end else begin
			io0_oe = 0;
			io1_oe = 0;
			io2_oe = 0;
			io3_oe = 0;
		end
	end

	always @(posedge clk) begin
		if (!csb) begin
			if (dummycount > 0) begin
				dummycount = dummycount - 1;
			end else begin
				case (mode)
					M_SPI: begin
						buffer = {buffer[6:0], io0_di};
						bitcount = bitcount + 1;
						if (bitcount == 8) begin
							bitcount = 0;
							bytecount = bytecount + 1;
							spi_action;
						end
					end
					M_DSPI_RD: begin
						buffer = {buffer[5:0], io1_di, io0_di};
						bitcount = bitcount + 2;
						if (bitcount == 8) begin
							bitcount = 0;
							bytecount = bytecount + 1;
							spi_action;
						end
					end
					M_DSPI_WR: begin
						bitcount = bitcount + 2;
						if (bitcount == 8) begin
							bitcount = 0;
							bytecount = bytecount + 1;
							spi_action;
						end
					end
					M_QSPI_RD: begin
						buffer = {buffer[3:0], io3_di, io2_di, io1_di, io0_di};
						bitcount = bitcount + 4;
						if (bitcount == 8) begin
							bitcount = 0;
							bytecount = bytecount + 1;
							spi_action;
						end
					end
					M_QSPI_WR: begin
						bitcount = bitcount + 4;
						if (bitcount == 8) begin
							bitcount = 0;
							bytecount = bytecount + 1;
							spi_action;
						end
					end
					default: ;
				endcase
			end
		end
	end

endmodule
