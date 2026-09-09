#!/bin/sh
# CentOS 7+ 兼容二进制（bun 模式：zig 工具链钉 glibc 2.17，cargo-zigbuild）。
# 依赖：zig + cargo-zigbuild（cargo install cargo-zigbuild）。
set -e
cargo zigbuild --release --target x86_64-unknown-linux-gnu.2.17 --target-dir=target/dist
cd target/dist/x86_64-unknown-linux-gnu/release
tar -cJvf ../../../../hdxml-linux-x64.tar.xz hdxml
echo "== ../../../../hdxml-linux-x64.tar.xz"
