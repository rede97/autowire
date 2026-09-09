# Local IP patches

## `sdspi-fifo-wb-once.patch`

ZipCPU `sdspi` FIFO Wishbone pointer must advance once per transaction when
the master holds STB until a pipelined ACK (`!dly_stb` guard).

The demo pins `demo/soc/ip/sdspi` to a local commit that includes this fix.
If the submodule is reset to upstream ZipCPU, re-apply from this directory:

```bash
# from demo/soc/ip/sdspi
git apply ../../patches/sdspi-fifo-wb-once.patch
```
