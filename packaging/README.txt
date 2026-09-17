tudouni —— 在命令行里干活的编码助手
====================================

这个压缩包里没有源码，只有一个装好就能用的程序。
不需要 Python、Node 或任何别的运行时 —— 它是**一个独立的可执行文件**。


一、安装
--------

Windows（x86_64）
    1. 把压缩包**完整解压**到一个目录（右键 → 全部解压缩）。
       不要在压缩包预览窗口里直接跑脚本，那样旁边没有程序本体。
    2. 在解压出来的目录里，右键 install.ps1 →「使用 PowerShell 运行」。
       如果提示脚本被禁止运行，就在 PowerShell 里执行：
           powershell -ExecutionPolicy Bypass -File .\install.ps1
    3. 关掉这个窗口，**开一个新的终端**（PATH 是启动时读的）。

Linux（x86_64）
    1. 解压：unzip tudouni-*.zip
    2. cd 进解压出来的目录，然后：chmod +x install.sh && ./install.sh
       （zip 不带权限位，所以那一步 chmod 是必须的；脚本自己会给程序和随包的
         ripgrep 补上执行位。）
    3. 如果脚本提示 ~/.local/bin 不在 PATH 里，照它给的 export 那一行
       加进 ~/.profile 或 ~/.bashrc，然后开一个新终端。

安装只装给当前用户，不需要管理员 / root。重复运行安装脚本就是覆盖升级。

装过去的除了程序本身，还有 `prompts\` 和 `tools\` 两个目录，**别分开移动或删掉**：
程序用它们认出"这是我自己的目录"，随包的 ripgrep（`grep` 工具用的搜索引擎）就在
里面。少了它们程序照常起来，只是 `grep` 会不见。


二、填密钥（第一次运行必须做）
------------------------------

    cd 到你自己的项目目录
    tudouni --tui

第一次运行会直接报"一条能用的模型路由都没有"，并告诉你去哪个文件填。那份文件是：

    Windows   %USERPROFILE%\.tudouni\config.json
    Linux     ~/.tudouni/config.json

用记事本 / 任意编辑器打开它，把 "api_key" 那一格填上（模型和密钥写在**同一条路由**里）：

    {
      "providers": {
        "deepseek": {
          "base_url": "https://api.deepseek.com",
          "api_key": "sk-...",                     ← 填这里
          "models": [
            {"id": "deepseek-flash", "context_window": 1000000},
            {"id": "deepseek-v4-pro", "context_window": 1000000}
          ]
        }
      },
      "web": {
        "tavily_api_key": ""                       ← 可选，填了才有联网搜索
      }
    }

要接自己的网关，就改 `base_url` / `models`，或者再加一条路由 —— **第一条有密钥的路由
就是默认路由**，顺序由你排。**配置只有这一个文件**：这个程序不读环境变量、也不读 .env。

填完存盘，重新运行 tudouni --tui 就行。密钥只放在你自己这台机器上。


三、怎么用
----------

    tudouni --tui                    TUI 界面（推荐）
    tudouni --session <id>           接着某个会话聊
    tudouni --list                   列出这个目录里存过的会话（不需要密钥）
    tudouni --skills                 列出这个目录里有哪些技能（不需要密钥）
    tudouni --version                看装的是哪一版（不需要密钥）
    tudouni --tui --theme A-T2       换配色（A 石墨琥珀 / A-T2 深透明 / P3 粉紫）
    tudouni --tui --no-stream        不要逐字输出，答案整段出现
    tudouni --tui --quiet            一个工具调用压成一行
    tudouni --help                   全部参数

进去之后常用的斜杠命令：/model 换模型、/new 开新会话、/resume 换回旧会话、
/help 看全部。输入框里 **Ctrl+J 换行**（回车是发送）。


四、几件要知道的事
------------------

**别在用户主目录（或盘根）下启动。** 程序操作的"工作区"就是你敲命令时所在的
那个目录，它能让模型读文件、执行命令 —— 所以在 home 下跑等于把整个主目录
（.ssh、浏览器数据、别的项目的密钥）交出去。程序会直接拒绝启动（退出码 2），
这不是故障，是保护。

**每个目录是独立的工作区。** 会话记录、审计日志、权限策略都存在那个目录下的
.tudouni/ 里，跟着项目走。你在 A 项目里的会话在 B 项目里看不到，这是有意的。

**第一次跑某个工具会问你要不要放行。** 按提示选即可；选「以后都允许」会把决定
写进那个项目的 .tudouni/permissions.json，可以自己 review、也可以提交给团队。

**版本号是编译在程序里的。** 所以 `tudouni --version` 说出来的就是你手上这个
文件本身的版本 —— 它不会因为旁边多了个文件而说谎。


五、出问题了
------------

想知道装的是哪一版
    tudouni --version

程序根本起不来 / 提示不是有效的 Win32 应用程序
    平台不对。这个包只支持 x86_64 的 Windows 和 Linux。

装了但敲 tudouni 说找不到命令
    新开的终端才认 PATH。Windows 上确认 %LOCALAPPDATA%\Programs\tudouni
    在用户 PATH 里；Linux 上确认 ~/.local/bin 在 PATH 里。

界面闪一下就退
    大概率是配置问题（比如 config.json 里多了一个逗号）。在同一个目录里跑
    tudouni --tui，子进程的报错会打在终端上，照着改即可。

模型说找不到文件、或者 `grep` 这条命令在 /tools 里没有
    检查安装目录里的 `prompts\` 和 `tools\` 还在不在（它们必须和程序在一起）。
    随包的 ripgrep 也要有执行位：Linux 上
        chmod +x ~/.local/opt/tudouni/tools/vendor/rg/*/rg
