export const PLUGIN_ID = "wishbone";

/**
 * Regfile and bus artifacts never share a directory: every directory-style
 * sink (plugins_dir, [plugins.wishbone] c=, uvm=) gets these two subdirs.
 * Umbrella files stay at the sink root and include through them.
 */
export const REGFILE_DIR = "regfile";
export const BUS_DIR = "bus";
