# AgentSwitch 环境上下文

路由器每次分诊都会读这个文件，把相关条目原样写进给执行者的简报。手写、随时改。
**只放 secret-gate 密文（enc:v1:...），不放明文密码**：daemon 加载时会把疑似明文的凭据行删掉并警告。
密文用 secret-gate 图形界面生成，host 绑到对应站点。

## 站点与账号

- 内网控制台 core：http://core.internal.example:8400/
  账号 alice@example.com
  密码 enc:v1:REPLACE_WITH_TOKEN
  2FA enc:v1:REPLACE_WITH_TOTP_TOKEN（用 secret_otp 取码）
  备注：登录后首页标题是 "MailLab"；表单是 React，用 secret_fill 填

- GitLab：https://git.example.com/
  账号 alice
  Token enc:v1:REPLACE_WITH_TOKEN（API 用，Authorization: Bearer）

## 环境

- secret-gate 代理在 127.0.0.1:8080；浏览器任务一律走 secret-gate browser
- 内网域名 *.internal.example 只有在公司 Wi-Fi 或 Tailscale 下可达
- Codex 用 ChatGPT.app 内置的 0.155，homebrew 那个别用

## 偏好

- ~/Desktop/WorkSpace/Projects/AgentSwitch：Python 部分优先 Claude，TypeScript 部分优先 Codex
- 文档翻译、总结类直接用 deepseek-flash，不要动用 Opus
