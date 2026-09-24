// SPDX-License-Identifier: MIT
// Body-pre include for tb_soc (opaque path; +incdir = sim/).
// UVM / DV environment hook: import packages and declare vif / interface
// instances here. It lands before the dumped nets, so it must not drive or
// reference them; board clock / reset / pad drivers live in tb_board.svh.
