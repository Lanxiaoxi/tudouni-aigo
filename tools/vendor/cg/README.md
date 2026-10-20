# tools/vendor/cg —— 随仓库带的代码索引解析器

`code_explore` 工具要重建索引时 exec 就是它：`cg-parse`。**这是"不对外有依赖"那句话在代码智能上的兑现方式**：
解析器跟着仓库走，用户不需要装 Rust、不需要联网、不需要 npm。

## 目录约定

```
tools/vendor/cg/
  README.md                            本文件
  x86_64-pc-windows-msvc/cg-parse.exe  一个官方 target triple 一份，目录名就是 triple
  x86_64-unknown-linux-musl/cg-parse   同上（**尚未提供**，见下）
```

目录名和文件名照 `internal/release` 的 `Target.Triple` / `Target.CgName()`，跟
`tools/vendor/rg` 同一套约定：triple 是唯一的键，不需要第二张对照表。

## 它是什么

不是自己写的解析器，是把 **CodeGraph 官方 Rust kernel**（`codegraph-kernel`，MIT）的 napi 入口
换成一个普通 `[[bin]]` 得到的：

- 上游：`@colbymchenry/codegraph` v1.6.2，`codegraph-kernel/`
- 改动：`Cargo.toml` 里 `crate-type = ["cdylib", "rlib"]`，加 `[[bin]] name = "cg-parse"`；
  `src/lib.rs` 里把 napi 包装成 `extract_for_bin()`（输出 5 个扁平 buffer，不经过 JS）
- 这样做的理由：**它的提取结果和官方逐字节一致**，重写没有任何精度收益，只有性能损失

## 怎么重建

```bash
cd codegraph-kernel
cargo build --release --bin cg-parse
# 产物在 $CARGO_TARGET_DIR/release/cg-parse(.exe)
```

交叉编译到 Linux musl 需要一个 musl C 工具链（kernel 链接了 tree-sitter 的 C 源码）：

```bash
# 在 Linux 主机上最省事
rustup target add x86_64-unknown-linux-musl
cargo build --release --target x86_64-unknown-linux-musl --bin cg-parse
```

**当前只有 Windows 那一份。** Linux 缺失这件事记在
`internal/release/release_test.go` 的 `codeIndexParserPending` 里，带原因：
没有 musl 交叉工具链。门禁测试会在两种情况失败——新增平台却没放二进制（逼你做决定），
或者已经放了二进制却没从待办里删掉（逼清单保持真实）。

## 缺失时会发生什么

和 ripgrep 不同，**少了它程序照常启动**：

- `code_explore` 仍然注册，仍然能查已有索引
- 但 `EnsureFresh` 返回 `Unavailable`，答案前面会多一行告警说"索引可能落后"
- 不会静默给出一个看起来新鲜的旧答案——这是这条降级路径存在的全部意义

所以"半可用的包"正是 `internal/release` 要防的那种失败，这也是它进了 `RequiredFiles` 的原因。

## 许可

上游 `codegraph` 是 MIT。二进制随仓库一起分发，所以许可文本必须让用户看得到：
`LICENSE` 就在本目录，和 `tools/vendor/rg/LICENSE-MIT` 同一个位置约定。

上游 npm 包只声明了 `"license": "MIT"` 而没有附许可文件，所以那份 `LICENSE` 是标准 MIT
原文，署名取自包元数据和它的仓库地址。
