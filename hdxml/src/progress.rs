//! ProgressCenter — 跨线程进度核心（docs/hdxml/module-info.md §5，第一阶段的薄实现）。
//! 全局唯一；功能代码禁止直接 println!/eprintln!，一律经此处。

use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use std::io::IsTerminal;
use std::time::Duration;

pub struct ProgressCenter {
    mp: MultiProgress,
    tty: bool,
}

impl Default for ProgressCenter {
    fn default() -> Self {
        Self::new()
    }
}

impl ProgressCenter {
    pub fn new() -> Self {
        Self {
            mp: MultiProgress::new(),
            tty: std::io::stderr().is_terminal(),
        }
    }

    /// 阶段聚合条（done/total）；非 TTY 返回隐藏条（不产生输出）
    pub fn phase(&self, name: &str, total: u64) -> ProgressBar {
        if !self.tty {
            return ProgressBar::hidden();
        }
        let pb = self.mp.add(ProgressBar::new(total));
        pb.set_style(
            ProgressStyle::with_template("{msg} [{bar:40}] {pos}/{len} ({eta})")
                .unwrap()
                .progress_chars("=>-"),
        );
        pb.set_message(name.to_string());
        pb
    }

    /// spinner（总量未知的阶段）
    pub fn spinner(&self, name: &str) -> ProgressBar {
        if !self.tty {
            return ProgressBar::hidden();
        }
        let pb = self.mp.add(ProgressBar::new_spinner());
        pb.enable_steady_tick(Duration::from_millis(100));
        pb.set_message(name.to_string());
        pb
    }

    /// 一切终端输出的唯一入口；非 TTY 降级为普通打印（进度条隐藏时不丢消息）
    pub fn println(&self, msg: &str) {
        if self.tty {
            let _ = self.mp.println(msg);
        } else {
            println!("{msg}");
        }
    }

    pub fn is_tty(&self) -> bool {
        self.tty
    }
}
