// Connect probe leaf: one input whose width is the macro `MACRO_WIDTH_SIGNAL_W
// (defined in rtl/soc_macros.svh via [analysis] define_headers). Not
// instantiated by the SoC; it exists only to exercise a macro-width port
// through the connect dialect.
module macro_probe (
	input  logic [`MACRO_WIDTH_SIGNAL_W-1:0] i_macro_width_signal,
	output logic                            o_probe_ok
);

	assign o_probe_ok = |i_macro_width_signal;

endmodule
