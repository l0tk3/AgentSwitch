# 浏览器与凭据入口的安全边界清单

`docs/gate-next-v0.md` §4 要求的清单。每一行是一个输出或操作入口：规则、它挡的是什么、做不到时怎么失败、由哪个测试守着。
升级 Playwright MCP、新增工具或改 gate 行为时逐行核对；`tests/test_boundary_checklist.py` 检查这里列出的每个测试都真实存在。

信任边界：模型只拿密文（`enc:v1:`）或本次执行的短引用（`enc:ref:`）；gate 进程持有私钥、执行范围和它自己填进页面的值；
网页是不可信的，下游 Playwright MCP 可信但会把未脱敏的快照和日志写盘。
安装凭据网关服务（`docs/gate-service-v0.md`）后，私钥、mitmproxy CA 私钥、短引用库、审计日志和可信配置归服务账户
`_agentswitchgate`，登录用户的进程（daemon、执行器、浏览器组件）在文件系统层面读不到；它们经 `gate.sock` 调用服务，见“凭据网关服务”一节。

## 工具与参数

| 入口 | 规则 | 挡什么 | 失败行为 | 测试 |
|---|---|---|---|---|
| `browser_evaluate`、`browser_run_code_unsafe` | 不对模型列出；调用一律拒绝。gate 自己用它们做 URL 探测、字段状态、表单去向和遮罩截图，代码只来自 `browser_probe.py` 的固定模板。下游是 AgentSwitch 共享浏览器的 agent 桥时，桥另有一份同样的模板（daemon `src/browser/probes.ts`），只放行与模板逐字相同、中间只有 JSON 字面量的代码，`browser_evaluate` 只放行 `() => location.href`；模板生成结果在这里固定，改模板须同时改桥 | 模型用 JS 读 DOM 里的真实值；绕过 gate 的进程在 daemon 里执行代码 | 拒绝，不转发 | `tests/test_browser_gate.py::test_list_tools_hides_dangerous_ones_adds_secret_fill_keeps_annotations`、`tests/test_browser_gate.py::test_denied_tools_file_args_and_schemes`、`tests/test_pii_mask.py::test_probe_snippets_embed_only_json_literals`、`tests/test_browser_probe_templates.py::test_probe_templates_match_the_agent_bridges_copy`；daemon `tests/browserProbes.test.ts` |
| 任意 `filename` 参数（快照、控制台、网络、截图落盘） | 拒绝，并从工具 schema 里去掉 | 未脱敏内容写进模型可读的文件 | 拒绝 | `tests/test_browser_policy.py::test_strip_file_output_removes_only_filename`、`tests/test_browser_policy.py::test_static_refusals` |
| 上传（`paths`） | 一律拒绝 | 把 Playwright 自己的未脱敏输出文件喂给页面 | 拒绝 | `tests/test_browser_gate.py::test_denied_tools_file_args_and_schemes`、`tests/test_browser_mcp_integration.py::test_fill_through_real_mcp_processes` |
| 下载与下游输出目录 | 下游 cwd 和 `--output-dir` 在 gate 家目录下（0700），每次调用后清空。下游是 AgentSwitch 共享浏览器的 agent 桥时（browser-v0 §5 第 3 步），桥进程照旧得到这两项但不写文件；Playwright MCP 在 daemon 进程内，它的快照、日志写在每个连接自己的 `$AGENTSWITCH_HOME/browser/agents/<连接>/`（0700，对调度的执行器禁读），这个目录也是它的工作区根，每次调用后由 daemon 清空，连接结束即删除（daemon `tests/browserAgents.test.ts`）；遮罩截图仍由 gate 指定写进 gate 自己的目录，gate 读回核对 | 快照 `.yml`、控制台/网络日志、遮罩截图文件被模型读到 | 清理失败不影响拒绝逻辑；文件名脱敏不代表文件内容受保护 | `tests/test_browser_mcp_integration.py::test_downstream_command_forces_private_output_dir`、`tests/test_browser_gate.py::test_output_dir_is_swept_after_every_call` |
| 导航与新标签（`browser_navigate`、`browser_tabs`） | 只允许 http(s) 和 `about:blank` | `data:`/`javascript:`/`file:` 页面接收粘贴的值 | 拒绝 | `tests/test_browser_policy.py::test_non_http_urls_refused_even_before_any_fill`、`tests/test_browser_policy.py::test_http_urls_and_blank_allowed` |
| 剪贴板（`browser_press_key`） | 填过或封装过值之后，复制/剪切组合键拒绝 | 值经剪贴板离开页面 | 拒绝 | `tests/test_browser_policy.py::test_copy_chords_refused_once_filled`、`tests/test_transfer.py::test_sealed_values_are_protected_like_filled_ones` |
| 子串搜索（`browser_find`、`browser_wait_for`、`text`/`target`/`startTarget`/`endTarget`、表单各字段的 `target`、`regex`/`filter`） | 与受保护值共享 4 个连续字符（不分大小写）即拒绝；`regex`、网络请求 `filter` 一律拒绝；非 ref 的目标里含文本、`internal:`、`>>`、XPath、`:has(` 等选择器引擎时拒绝 | 逐段猜值的预言机 | 拒绝 | `tests/test_browser_policy.py::test_substring_oracles_refused_once_filled`、`tests/test_browser_gate.py::test_copy_chord_and_oracle_only_after_fill`、`tests/test_browser_policy.py::test_oracle_checks_cover_drag_form_targets_case_and_text_selectors` |
| 所有文本输出 | 填入值按各种编码（含浏览器表单编码、encodeURIComponent）替换为 `[REDACTED:label]`；封装值替换为引用；填写的 Playwright 代码回显和文件链接删除 | 值经快照、代码回显、服务端回显、网络请求回到模型 | 替换后返回 | `tests/test_browser_gate.py::test_secret_fill_types_plaintext_and_result_is_clean`、`tests/test_browser_gate.py::test_value_with_quotes_and_backslash_never_echoes`、`tests/test_browser_policy.py::test_scrub_drops_code_echo_for_fills_and_output_links`、`tests/test_redact.py::test_redact_longest_first`、`tests/test_redact.py::test_browser_and_js_url_encodings_are_redacted` |
| 异常与错误信息 | 下游错误文本同样脱敏，来源页的报错也会封装；gate 自己的拒绝原因经同样的脱敏再返回和写审计；报错不带页面 URL（只写协议或 host）；非文本内容块丢弃 | 错误信息携带值 | 返回脱敏后的错误 | `tests/test_browser_gate.py::test_unexpected_downstream_exception_is_redacted`、`tests/test_browser_gate.py::test_unknown_content_blocks_are_dropped`、`tests/test_browser_policy.py::test_page_host_errors_never_echo_the_url`、`tests/test_transfer.py::test_error_text_from_a_source_page_is_sealed` |

## 填写

| 入口 | 规则 | 挡什么 | 失败行为 | 测试 |
|---|---|---|---|---|
| `secret_fill`、`browser_type`、`browser_fill_form` | 当前页面 URL 只信 gate 自己的探测；按密文里的 host:port 和 `http` 用途校验；密文或引用只能出现在要输入的文本里 | 把值填进别的站点；注入把密文塞进选择器 | 什么都不输入就拒绝 | `tests/test_browser_gate.py::test_wrong_host_is_refused_before_anything_is_typed`、`tests/test_browser_gate.py::test_non_http_page_and_failed_probe_are_refused`、`tests/test_browser_policy.py::test_has_tokens`、`tests/test_browser_policy.py::test_references_are_fillable_and_refused_outside_the_typed_text` |
| iframe 里的字段 | 主 frame 的 ref（`e12`）按页面 URL 校验；frame ref（`f1e2`）和选择器由 Playwright 报出所在 frame 及其全部上层 frame 的 URL，每一层都须被密文允许；多个字段须在同一 frame；非 HTTP(S) 的 frame（`about:srcdoc`）或定位失败则拒绝 | 把值填进允许页面里的第三方 iframe，或填进外站嵌套的允许 iframe | 什么都不输入就拒绝 | `tests/test_browser_gate.py::test_fill_into_a_foreign_iframe_is_refused`、`tests/test_browser_gate.py::test_fill_into_an_allowed_iframe_inside_an_allowed_page`、`tests/test_browser_gate.py::test_allowed_iframe_inside_a_foreign_page_is_refused`、`tests/test_browser_gate.py::test_frame_fills_fail_closed`、`tests/test_browser_gate.py::test_selector_targets_are_located_by_playwright_first` |
| 人的 Fill Ciphertext（daemon `POST /browser/tabs/:id/fill` → `secret-gate fill-value`，browser-v0 §1、§6） | 只收完整的 `enc:v1:` 密文（引用属于某次执行，拒绝）；焦点所在输入框的 frame 及其每一层上层 frame 的 URL 由浏览器报给 daemon，gate 按 `page_host` 逐个换成 host:port，每一个都须被密文允许，用途为 `fill`（无服务时同本地浏览器 gate，`http` 亦可；有服务时为 `browser.resolve`，只认 `fill`）；任何一层不是 http(s) 即拒绝。daemon 一侧（2026-10-02 起）：只在人自己的标签上（agent 的标签即使接手也 409：值会留在页面里，交还后 agent 读得到）；只填密码框或标为密码、验证码的输入框（`type=password`，`autocomplete` 为 `current-password`、`new-password`、`one-time-code`；其余 400，画面流会照原样显示文字）；值只在 CLI 的 stdout 上交给 daemon，daemon 打进检查过的那个元素本身（元素句柄，替换原有内容），gate 回答后焦点已换到别的元素或 frame 链变了就不打；只有接手方（或无人接手时任一屏幕）可用；响应、daemon 日志与审计只有 label 和 host | 人把密文填进别的站点或页面里的第三方 iframe；值出现在手机、日志、审计；值经 agent 的标签回到模型；值以明文出现在画面流里；回答期间焦点被点到别的输入框 | 什么都不输入就拒绝，返回 gate 或 daemon 的原因 | `tests/test_fill_value.py::test_fill_value_is_fill_only_host_checked_for_every_frame_and_never_recorded`、`tests/test_fill_value.py::test_fill_value_through_the_gate_service_asks_browser_resolve_for_each_frame`、`tests/test_fill_value.py::test_fill_value_refuses_references_which_belong_to_a_task`；daemon `tests/browserFill.test.ts` |
| 字段状态（`secret_field_state`、`secret_fill` 结果） | 当前 `empty/nonempty/unknown` 在 Playwright 隔离环境读取，只回判定；`attempted/filled` 是本页操作历史，不代表已保存 | 用状态查询反推值；把历史当现状 | 探测失败返回 `unknown` | `tests/test_browser_gate.py::test_field_state_separates_current_value_from_history`、`tests/test_browser_gate.py::test_field_state_is_per_page_and_unknown_when_probe_fails` |

## 截图（§5.1）

| 入口 | 规则 | 挡什么 | 失败行为 | 测试 |
|---|---|---|---|---|
| `browser_take_screenshot` | 截图前取 gate 自己的未脱敏快照：显示受保护值或个人信息模式的元素按 ref 遮罩，密码框总是遮，页面持有过受保护值时整块遮 canvas，管理员配置的区域总是遮；用 Playwright 原生 `mask` 截图，gate 解码 PNG 逐像素确认每个遮罩框都是遮罩色 | 值出现在图像里；页面拆掉遮罩层 | 找不到可遮挡的元素、遮罩未生效、截图失败或没有私有目录时拒绝 | `tests/test_browser_gate.py::test_screenshot_after_fill_is_masked_and_verified`、`tests/test_browser_gate.py::test_screenshot_refused_when_mask_is_not_in_the_image`、`tests/test_browser_gate.py::test_screenshot_refused_when_sensitive_text_has_no_element`、`tests/test_browser_gate.py::test_screenshot_fails_closed`、`tests/test_browser_gate.py::test_screenshot_needs_a_private_dir_once_something_is_protected`、`tests/test_browser_gate.py::test_personal_data_on_page_is_masked_without_any_fill`、`tests/test_browser_gate.py::test_admin_regions_are_always_masked` |
| 截图：没有任何需要保护的内容 | 直接转发原生截图 | — | — | `tests/test_browser_gate.py::test_screenshot_without_anything_to_protect_is_plain` |
| 截图：frame、Shadow DOM | 快照里出现的 iframe 内容（`f1e2` 这类 ref）和开放 Shadow DOM 按 ref 遮；密码框、canvas 和管理员区域的 CSS 选择器在每个 frame 里都遮 | 嵌套内容里的值 | 同上 | `tests/test_pii_mask.py::test_sensitive_refs_maps_text_lines_to_their_element_and_skips_the_header`、`tests/test_pii_mask.py::test_css_masks_also_apply_inside_frames` |
| PNG 核对 | 只接受 8-bit RGB/RGBA、无隔行；损坏或格式不符即拒绝 | 伪造或截断的图像绕过核对 | 拒绝 | `tests/test_pii_mask.py::test_png_decoder_handles_every_filter`、`tests/test_pii_mask.py::test_coverage_check`、`tests/test_pii_mask.py::test_bad_png_is_rejected`、`tests/test_pii_mask.py::test_unsupported_png_formats_are_rejected` |

## 代理与 `secret_http`

| 入口 | 规则 | 挡什么 | 失败行为 | 测试 |
|---|---|---|---|---|
| 策略 host | 按代理实际连接的 host:port（CONNECT 目标或绝对 URL）判定，不看 Host 头；带值的请求 Host 头与目的地不一致就拒绝；`secret_http` 的 Host 头也必须是 URL 自己的 host | Host 头伪造把明文送到别处；经 CDN 的域前置 | 403 / 拒绝 | `tests/test_proxy_addon.py::test_spoofed_host_header_cannot_redirect_a_value`、`tests/test_proxy_addon.py::test_host_header_must_match_the_real_destination`、`tests/test_gate_ops.py::test_op_http_refuses_a_host_header_for_another_site` |
| 意外错误 | 改写先在局部算完再写回；任何异常都拒绝请求，请求保持原样；响应脱敏出错时扣下整个响应 | 半改写的请求发出去、未脱敏的响应回到模型 | 403 / 502 | `tests/test_proxy_addon.py::test_unexpected_error_denies_and_leaves_the_request_untouched`、`tests/test_proxy_addon.py::test_response_that_cannot_be_redacted_is_withheld` |
| 上游证书例外名单 | 启动和 SIGHUP 重载用同一套严格规则；文件不可信时启动不加载任何例外 | 被改过的名单关掉证书校验 | 保留旧名单（重载）或不加载（启动） | `tests/test_reload.py::test_start_up_uses_the_strict_rules`、`tests/test_reload.py::test_read_refuses_untrustworthy_files` |

## 短引用与执行范围（§1）

| 入口 | 规则 | 挡什么 | 失败行为 | 测试 |
|---|---|---|---|---|
| 所有接受密文的入口（代理、`secret_http`、`secret_exec`、`secret_otp`、`secret_describe`、浏览器填写、`secret_repair`） | 引用只在登记它的执行范围内解析；解析后照原密文的 host/端口/用途校验 | 跨任务使用引用；同名 label 串值 | 拒绝并提示用当前上下文里的引用 | `tests/test_refs.py::test_same_label_in_two_tasks_does_not_mix`、`tests/test_refs.py::test_reference_keeps_the_sealed_policy`、`tests/test_browser_gate.py::test_secret_fill_accepts_a_reference_of_this_execution` |
| 执行结束 | 释放删除映射、范围永不重开；不撤销原密文；没释放的引用 2 天后在查询时就失效 | 旧引用在后续执行里继续生效 | 拒绝（"released" / "expired"） | `tests/test_refs.py::test_release_ends_the_scope_but_not_the_ciphertext`、`tests/test_refs.py::test_releasing_an_unknown_scope_blocks_it_for_good`、`tests/test_refs.py::test_stale_scopes_expire_and_old_releases_are_forgotten`、`tests/test_refs.py::test_lookup_itself_expires_old_references` |
| 代理 | 范围来自 `Proxy-Authorization`（CONNECT 时记在连接上），转发前删除；没有范围的引用 403 | 范围泄露给站点；无范围请求解析引用 | 403 `X-Secret-Gate: denied` | `tests/test_proxy_addon.py::test_reference_resolves_with_scope_on_connect`、`tests/test_proxy_addon.py::test_plain_http_request_scope_is_used_and_never_forwarded`、`tests/test_proxy_addon.py::test_reference_without_scope_is_denied_with_guidance`、`tests/test_proxy_addon.py::test_reference_keeps_host_policy_behind_the_proxy` |
| 注册表文件 | 0600，只存密文、label 和范围的 sha256 | 读到文件的人拿到值或范围 | — | `tests/test_refs.py::test_registry_file_is_private_and_holds_no_plaintext_or_scope` |
| `secret-gate refs` CLI | 只给调度器；范围只走 stdin；错误不回显输入 | 范围出现在 argv（同用户进程可见） | 退出码 2 | `tests/test_refs.py::test_cli_register_and_release`、`tests/test_refs.py::test_cli_register_rejects_bad_requests` |
| 凭据修复 | 引用在离开 gate 前换成密文；修复结果登记为同范围的新引用 | 引用绕过调度器校验 | 同原修复流程 | `tests/test_credential_repair.py::test_repair_of_a_reference_sends_ciphertext_and_returns_a_reference` |

## 授权字段传递（§5.2）

| 入口 | 规则 | 挡什么 | 失败行为 | 测试 |
|---|---|---|---|---|
| 授权本身（`SECRET_GATE_TRANSFER`） | 只接受精确 host、已知字段类型、1–200 字用途；没有执行范围时不生效；不传给下游 | 通配或扩大的授权；授权跨执行复用 | 启动时拒绝或忽略 | `tests/test_transfer.py::test_invalid_grants_are_refused`、`tests/test_transfer.py::test_grant_needs_scope_and_public_key`、`tests/test_browser_mcp_integration.py::test_transfer_grant_without_scope_is_not_applied` |
| 来源页输出 | 只在来源 host、只对授权字段类型当场加密成只允许目的地、只允许浏览器填写（用途 `fill`）的密文，输出里只有引用和说明；同一值换了格式（电话加分隔符、邮箱改大小写）出现在任何页面也换成引用 | 模型看到来源页的个人信息 | 非来源页、非授权类型保持原样 | `tests/test_transfer.py::test_source_page_output_shows_references_and_legend`、`tests/test_transfer.py::test_no_sealing_outside_the_source_or_for_other_kinds`、`tests/test_transfer.py::test_seal_matches_labels_per_kind_and_reuses_known_values`、`tests/test_transfer.py::test_reformatted_sealed_values_still_show_as_references` |
| 目的地填写 | 页面 host:port 须在授权目的地内；表单及它的每个提交按钮（含用 `form="id"` 挂在表单外的）的提交去向也须在目的地内；代理和 `secret_http` 不接受 `fill` 用途，封装值只能经浏览器 gate 填写 | 填到别的站点；目的地页面上的表单把值提交出去；绕过表单检查直接发请求 | 拒绝，不输入 | `tests/test_transfer.py::test_sealed_value_cannot_leave_through_the_proxy_or_secret_http`、 `tests/test_transfer.py::test_sealed_reference_fills_only_on_destination_and_stays_hidden`、`tests/test_transfer.py::test_sealed_reference_refused_when_form_submits_elsewhere`、`tests/test_browser_mcp_integration.py::test_transfer_grant_seals_page_data_into_references_end_to_end` |

## 日志与进程环境

| 入口 | 规则 | 挡什么 | 失败行为 | 测试 |
|---|---|---|---|---|
| 审计日志 `logs/browser-audit.jsonl` | 记录填写、封装、截图、拒绝及原因；只有 host、label、引用、计数；范围只记短哈希；0600 | 日志里出现值或范围 | 写不进去时只在 stderr 报告，不阻断 | `tests/test_transfer.py::test_audit_log_is_private_and_best_effort`、`tests/test_transfer.py::test_source_page_output_shows_references_and_legend` |
| 下游进程环境 | 去掉代理变量、修复通道、执行范围和授权 | 下游或页面拿到 gate 的能力 | — | `tests/test_browser_mcp_integration.py::test_downstream_env_strips_proxy_vars`、`tests/test_browser_mcp_integration.py::test_transfer_grant_without_scope_is_not_applied` |

## 共享浏览器的 agent 桥（daemon `src/browser/`，browser-v0 §5 第 3 步）

**2026-10-08 起，终端里的 agent 不经 gate**（用户定，`docs/profiles-v0.md` §8：网关只留在调度里；终端里的 agent 要浏览器工具，但不经网关）：它的浏览器工具就是桥本身。所以对终端里的 agent，上面“工具与参数”“填写”“截图”各表**不适用**——快照不遮盖、截图不打码、没有 `secret_fill`，页面上有什么它就看到什么，包括你登录之后的页面。它与你同一 uid、本来就能以你的身份运行任何命令，这一层对它从来不是边界。仍然适用于它的只有本节下面 daemon 一侧的各条。调度的任务照旧全程经 gate。

经 gate 时（调度的任务；2026-10-08 之前终端也是）agent 的浏览器工具是 `secret-gate browser -- <桥>`：上面各表逐条适用于它，桥只是 gate 的下游；下游背后的 Playwright MCP 跑在 daemon 进程里，连的是服务持有的浏览器。下面是 daemon 一侧另外守住的，测试在 `packages/daemon/tests/`：

- 会话令牌：daemon 为每个 agent 会话（目前是终端里的 agent）单独发一个令牌，写进 `$AGENTSWITCH_HOME/browser/sessions/<会话>.token`（0600，目录对调度的执行器禁读），桥从文件读，不进命令行、环境变量和模型上下文；每个请求核对令牌与会话 id，只对这个会话有效；会话结束（程序退出、终端删除、daemon 重启）即作废，已有连接随之断开。本机令牌不是会话令牌；桥的路由不在远程白名单（`browserAgents.test.ts`、`browserBridge.test.ts`）。对终端里的 agent 这只挡随手直连，不是边界：它与用户同一 uid，读得到令牌文件（terminal-v0 §3）。**例外（2026-10-31，terminal-v0 §10）**：被持有进程拿着、熬过重启的终端，其会话按原 id 与原令牌由下一个 daemon 认回（`BrowserAgents.adopt`），令牌记在该终端的 `terminals/<id>/meta.json`（0600；见下文“熬过重启的终端”）；桥断开后重连，对重启中 daemon 的 401 继续重试到等待期满。
- 标签隔离：Playwright MCP 拿到的 `BrowserContext` 是一个替身，只列出、只通告这个 agent 自己的标签（含它们弹出的窗口），新页面经宿主开成它的标签；路由、初始化脚本、Cookie、存储、权限、CDP 这类作用于整个配置的调用一律抛错，所以较新的 Playwright MCP 伸手更多时是失败，而不是碰到人的或别的 agent 的标签（`browserAgentContext.test.ts`；真 Chrome 冒烟：人的标签不在 agent 的 `browser_tabs` 列表里）。
- 桥自己的拒绝，不论调用方是否经过 gate：任何 `filename` 参数；`paths` 参数，只有下一条的上传除外；`browser_navigate` 与 `browser_tabs new` 只放行 http(s) 与 `about:blank`，AgentSwitch 自己的端口不放行（宿主对每个请求也检查）；`browser_resize`（尺寸归屏幕）；`browser_close` 只关这个 agent 的标签，且等每个被接手的标签交还后再关（`browserAgents.test.ts`）。
- 上传（2026-10-11，用户定：“改成允许上传”；此前对谁都拒绝）：**只对终端里的 agent**（不经 gate 的会话）。经 gate 的会话照旧：gate 拒绝（上面“工具与参数”的“上传”一行），桥也拒绝。放行的是 `browser_file_upload` 与 `browser_drop` 的 `paths`，每个路径过 `checkUploadFile`（daemon `src/browser/rules.ts`）：绝对路径、存在、是文件不是文件夹、不超过 1 GiB，且不是 AgentSwitch 自己的数据（含会话令牌、Playwright MCP 的未脱敏输出所在的 `browser/`、`nodes/`、`local-token`）、不在凭据目录里、不是凭据文件名（补上了 `.credentials.json`、`auth.json`）；按原样、真实路径与文件身份各查一次。一次最多 16 个。通过后复制到这个连接的私有目录再交给 Playwright MCP，它“只收工作区内文件”的限制不松开；副本留 30 分钟、连接结束即删。审计记 `upload`（谁、页面站点、文件路径）。**这不是对终端里 agent 的边界**（它与你同一 uid，读得到这些文件，也能用别的办法发出去）；它防的是误传和网页上的诱导，名单之外的私人文件（文档、照片）它照样传得出去（`browserAgents.test.ts`、`browserRules.test.ts`）。
- 代码只有 gate 的探测（2026-10-02）：`browser_run_code_unsafe` 在 Playwright MCP 所在进程（daemon）的 Node `vm` 里执行，拿到真实的 `page`：`page.constructor.constructor` 即 daemon 的 `Function`，`page.context()` 通向所有标签。桥只放行与 `browser_probe.py` 四个模板逐字相同的代码，模板中间只能是 JSON 字面量（`JSON.parse` 严格解析，代码放不进去），并按模板核对类型：目标为 1–500 字的字符串；遮罩截图的参数恰好是那六个键，路径为绝对路径、不含 `..`、文件名为 `secret-gate-mask-<16 位十六进制>.png`。`browser_evaluate`（在页面里执行，读得到人打在页面里的字）只放行 `() => location.href`。其余一律拒绝，不论调用方是否经过 gate（`browserProbes.test.ts`，含逃逸尝试；gate 环境在时用 gate 自己生成的代码核对）。剩下的：直连桥的进程仍可让 daemon 截一张页面图写到任意目录下一个上述名字的新文件。
- 接手：人接手的标签上，agent 的调用按顺序排队，交还后接着执行，2 分钟未交还即以“用户正在使用此标签”失败，调用不会执行。新连接在 Playwright MCP 第一次调用前不知道当前标签：此时按它将选中的第一个标签判断，判断不了时等这个 agent 的所有标签都无人接手；定位元素等耗时步骤之后、交给 Playwright MCP 之前再查一次，期间被接手就回去等（`browserAgents.test.ts`、`browserAgentContext.test.ts`）。
- 接手期间的网络与控制台（2026-10-02，daemon `src/browser/heldTraffic.ts`）：Playwright MCP 按标签保存网络请求（含请求体：人手动登录时的 POST 带着密码）并读页面的控制台，交还后 `browser_network_request(s)`、`browser_console_messages` 会把它们交给 agent；重新连上的桥还会从页面自己的记录（`page.requests()`、`page.consoleMessages()`）重建。daemon 从 agent 标签打开起（不论有没有连接）记录每次接手的起止，以及接手期间和交还后 1.5 秒内页面发出的每个请求；Playwright MCP 为 agent 页面建的每个标签对象在被使用前加一层过滤：请求列表去掉这些请求（以及开始时间落在接手期间的），控制台去掉接手期间的消息，接手期间不再记录新的请求、不写控制台日志文件；页面错误不带时间，交还 1.5 秒后从页面清掉；agent 交还后的下一个调用先等过这 1.5 秒。依赖 Playwright MCP 0.0.82 `Tab` 的内部成员，以它自己的 `Tab` 类测试固定（`browserHeldTraffic.test.ts`；真 Chrome 冒烟：手动登录的 POST 与控制台在交还后、以及重连的桥里都看不到，去掉过滤则看得到）；对象不符合预期时这个标签接手过后，这三个工具一律拒绝（失败即关闭）。
- 接手后仍可见的（不是边界）：页面本身。交还后 agent 的快照照样显示人在非密码输入框里手打的文字和页面显示、存下的任何内容；页面在交还之后自己再发出的请求（例如延迟提交）不算接手期间的；接手期间 agent 在标签列表里看得到这个标签的标题与网址。密码请在自己的标签里用 `Fill Ciphertext`，agent 的标签里不提供（见“人的 Fill Ciphertext”）。
- 屏幕上的动作说明只取元素描述、按键名和网址的域名，从不取输入的文字（gate 之后那是明文）；工具参数不记日志、不进审计（`describeCall`）。
- Playwright MCP 每个连接都会监听整个进程的未处理 rejection（会把 daemon 自己的报给 agent），daemon 在它加上时摘掉；之后 Playwright 自己的 rejection（如它试图保存被拒的下载）只记日志，其余照 Node 默认处理。
- 已知：共享浏览器不走网关代理（同用户自己的 Chrome），页面里的值只经 gate 的填写进入；执行器的会话槽浏览器照旧走代理。

## 共享浏览器的引擎、转发层与身份（daemon `src/browser/`，browser-v0 §7；2026-10-05）

装了 Camoufox 之后，服务持有的共享浏览器换成它（未装时仍是 Chrome，上一节与“已知缺口”里关于共享浏览器的各条照旧）。下面是这一部分新增的入口与各自守住的，测试在 `packages/daemon/tests/`（`browserForwarder`、`browserCamoufox`、`browserWindows`、`browserEngine`、`browserIdentity`），实机检查在 `packages/daemon/scripts/`（`browser_smoke.ts`、`browser_window_smoke.ts`、`browser_identity_smoke.ts`）：

- 转发层：浏览器的全部流量先到 daemon 在回环地址上的转发代理，每次运行一个随机口令，只有它启动的浏览器知道。AgentSwitch 自己的端口按名字与解析后的地址拒绝（重定向、WebSocket、指向本机的域名都算）；去本机与私网地址的直连，其余交给上游代理（没有就直连）。上游设了却用不了（密码取不到）时一律 502，不改走直连。
- 本地文件：Firefox 不让 `file:` 请求经过拦截。宿主检查过的导航照旧事先拒绝；页面里的链接、内嵌把页面带到受保护的文件时，是页面到了之后立刻换成拒绝页——内容会在页面里出现一瞬，见“已知缺口”。
- 窗口里的接手：在 agent 的窗口里，不是宿主自己发出的输入即视为人接手（`mac-window`），agent 的调用排队，接手期间的网络与控制台照上一节的规则不交给它；两分钟无输入或 `Hand Back` 交还，审计记一条。计数用的初始化脚本在页面看不到的世界里，只数次数，不取内容。
- 静止预览与 `show`：`GET /browser/tabs/:id/preview`、`POST /browser/tabs/:id/show` 只在本机，配对的手机不可用。
- 引擎下载：Camoufox 取自它在 GitHub 的发布，playwright-core 取自 npm；下载后核对对方公布的校验值（`sha256:`、`sha512-`），不符即弃；再经一次真启动的自检才切换。接口 `GET /browser/engine`、`POST /browser/engine/update`、`…/cancel` 只在本机。这是从外面取可执行文件：信任的是这两处发布与它们公布的校验值，没有另外的签名核对（Camoufox 的 Mac 版是临时签名）。
- 代理密码：只以密文进 daemon（Mac 应用用本机网关封好再发；配对的 iPhone 用网关的公钥在手机上封好再发，站点只有代理自己的 `host:port`、用途 `http` + `fill`，2026-10-09；接口拒绝明文），以密文存在 `browser/identity.json`（0600）。daemon 向网关要明文用的是人的 `Fill Ciphertext` 那条路（`secret-gate fill-value`，站点为代理自己的 `host:port`，网关按密文的站点与 `fill` 用途核对并记审计）。明文此后留在 daemon 的内存里，供转发层连接上游；不落盘、不进日志与错误（代理库不记日志，出错只给页面一句固定的话）、不进库、不进模型与执行器上下文。
- 出口查询：有上游代理时，daemon 经转发层（即经代理）向 `https://ipinfo.io/json` 发一次 GET，取出口地址、地点、时区；设置代理时与带着代理启动时各一次，没有代理时不发。对方看到的是代理的出口地址，与浏览器访问任何站点时一样。`AGENTSWITCH_BROWSER_EXIT_LOOKUP=off` 关掉。
- 指纹：只在本机接口上读写；导入的一份是用户选的文件，原样交给 Camoufox（它的属性里有 `addons`、`certificates` 这类能改变浏览器行为的项——导入等于信任那份文件）。

## 配置自己的代理与浏览器（daemon `src/browser/exits.ts`、`fleet.ts`，profiles-v0 §4.1、§5.1；2026-10-09）

- 配置的代理：密码同样只以密文进 daemon（Mac 应用用本机网关封好再发，配对的 iPhone 在手机上封好再发，站点都只有代理自己的 `host:port`；接口拒绝明文），以密文存在 `profiles/profiles.json`（0600）；屏幕只被告知“有密码”。daemon 向网关要明文走的仍是 `fill-value` 那条路；没有网关时带密码的代理不能用。
- 每个有代理的配置一个转发口（与共用浏览器的转发层同一个实现，同样拒绝 AgentSwitch 自己的端口、同样每次运行一个随机口令）。这个配置名下的 **agent 进程拿到的是转发口的地址连同这个随机口令**（`HTTPS_PROXY=http://agentswitch:<口令>@127.0.0.1:<口>`）：agent 读得到它，但它只能用来经这个配置的代理出去，不是代理自己的密码，服务一停就作废。**例外（2026-10-31）**：被持有的终端（terminal-v0 §10）在服务重启后按原端口、原口令重新监听（`ExitPool.address` 的 `pin`），口令随 `HTTPS_PROXY` 记在 `terminals/<id>/meta.json`（0600）；配置的代理在终端运行期间被删掉的，重启后不再在那个端口建转发口，终端保持不通，不改为直连。
- 上游不通时转发口一律 502，不改走直连；开终端前先经它查一次出口，不通不开。出口查询除 `ipinfo.io` 外，在它拒答时还会依次问 `ipwho.is`、`www.cloudflare.com/cdn-cgi/trace` 和 `api.ipify.org`（各一次 GET，经代理发出）。
- 配置自己的浏览器：与共用浏览器同一套规则（同一份受保护路径表、同样拒绝 AgentSwitch 的端口与目录），只是目录与状态各自一份、流量经这个配置的转发口。它的全部路由在 `/profile-browser/<agent>.<id>/…` 下，与共用浏览器的路由一样要本机口令；**放行的只有它的 agent 桥**（同共用浏览器的桥，凭会话口令）。配对的手机够得着 `GET /browsers` 和它那十三条与共用浏览器相同的路由（2026-10-09，§5.4；手机本来就能操作共用浏览器，这里是同一种权限用在另一个浏览器上），够不着它的身份与 agent 桥；从它的身份接口改代理一律拒绝（它的代理是配置的）。
- `POST /terminals/open`：终端里的 agent 要系统打开一个网址时由终端里的小程序调用，不带本机口令，凭这个终端自己的 hook 口令；正文是 JSON（2026-10-09 改：本机监听对一切带正文的请求只收 JSON，这条路由不例外，最初的小程序发的是表单，被一律拒绝）；拒绝时在服务日志里记原因，不记网址；只收 `http(s)` 网址，只在这个终端所属配置自己的浏览器里开一个标签，别的什么都不做。审计里只记网址的站点（登录链接里带一次性的参数）。没有自己浏览器的终端、没有窗口的浏览器一律拒绝；小程序这时报错退出，不退回系统浏览器。打开之后，本机的实时快照（`GET /live`，要本机口令）里带上“哪个浏览器、哪个标签、何时”，供 Mac 应用把那个窗口带到前面；给配对手机的快照里没有这一项。
- 没有代理的配置也有自己的浏览器（profiles-v0 §5.5，2026-10-09）：同一套规则与同一个转发层，只是转发口后面不接代理、直接出去（AgentSwitch 自己的端口照样拒绝）。这个配置名下的终端同样拿到 `open` 小程序，但只在浏览器有窗口时给；没窗口时不给，网址照旧交给系统浏览器（它和这个配置的出口相同，不构成另一条出路）。各配置的浏览器目录、指纹文件、标签与审计互不相通，也不与共用浏览器相通。
- 配置的 claude.ai session key（profiles-v0 §3.4，2026-10-11；daemon `src/browser/sessionKey.ts`）：只以密文进 daemon（Mac 应用用本机网关封好再发，站点只有 `claude.ai`；接口拒绝明文、拒绝配对设备），以密文存在 `profiles/profiles.json`（0600）；屏幕只被告知“有一个”，任何接口都不回显。daemon 向网关要明文仍走 `fill-value` 那条路（网关按 `https://claude.ai/` 核对），要到后只做一件事：作为 `.claude.ai` 的 `sessionKey` Cookie（Secure、HttpOnly）写进**这个配置自己的浏览器**——保存时浏览器开着就当场写，否则在它下次启动、交出第一个页面之前写；浏览器里已有同名 Cookie 时启动不覆盖。明文不写日志、不进审计、不进任何 agent 的文件或环境，daemon 不拿它向 claude.ai 发任何请求。形状不是 `sk-ant-sid…` 的一律拒绝、不保存。**要知道的**：写进去之后它就在那个浏览器的 Cookie 库里（与人手动登录留下的相同），这个配置名下终端里的 agent 用浏览器工具能以这个登录身份操作 claude.ai——和人在那个浏览器里手动登录后的情形一样，agent 桥仍不给它读 Cookie 的工具。`Remove` 只让 daemon 忘掉密文，不动浏览器里的登录。
- 配置的 API key（profiles-v0 §3.6，2026-10-13；daemon `src/profiles/apiKeys.ts`）：只以密文进 daemon（Mac 应用用本机网关封好再发，站点是它要发往的地址的站点；接口拒绝明文、拒绝配对设备），以密文存在 `profiles/profiles.json`（0600），任何接口都不回显。**明文会交给终端里的 agent**：Claude Code 的 `apiKeyHelper` / Codex 供应商的 `auth` 命令是终端自己的 hook 程序，凭终端的 hook 令牌向本机口 `POST /terminals/key` 要（本机令牌检查对它放行、不在远程名单上、令牌不对即拒），daemon 向网关要值仍走 `fill-value` 那条路、只对那一个站点。终端不在网关后面（profiles-v0 §8），这把 key 是 agent 自己要用的凭据，它运行同一条命令也能看到——网关在这里保证的只有两件：落盘是密文、只为那一个地址解开。key 不写进 agent 的参数、环境变量和设置文件；daemon 的日志只记“没给出”的原因，不记值。**daemon 自己也会把明文发往那个地址一次**（2026-10-15 起；`src/profiles/apiKeys.ts` `probeModels`）：建配置或改模型时、以及 `POST /profiles/models`（只在本机），用解开的 key 向地址自己的模型列表路由发一个 GET。2026-10-31 收紧：不跟随跳转（Node 的 fetch 会把 `x-api-key` 带到跳转去的另一个主机），3xx 按状态码报出；已有配置的请求走它自己的代理的转发口（有代理时），与它名下的 agent 一样从同一出口出去；刚建、还没有代理的配置从本机直接问一次。
- Claude Code 的设备标识（profiles-v0 §3.5，2026-10-11）：daemon 只读各配置目录里 `.claude.json` 的 `userID`（一串随机十六进制数，不是凭据），随 `GET /profiles` 与终端信息给屏幕；不写、不改、不替换。
- 配置是否已登录（profiles-v0 §3.1，2026-10-09）：开终端前 daemon 在这个配置的目录里跑一次 agent 自己的 `claude auth status`（`src/terminals/signIn.ts`）。它的回答里除了“是否登录”还有账号邮箱、组织名；daemon **只取 `loggedIn` 一个布尔值**，其余不存、不记日志、不给任何屏幕。daemon 自己不读钥匙串、不碰登录凭据；没登录时只是在启动命令末尾多带一个 `/login`，登录仍由 agent 自己完成。
- Codex 的账号配置（profiles-v0 §6.2，2026-10-20）：登录由 Codex 自己完成（`codex login --device-auth`，在终端里），凭据由 Codex 写成配置目录里的 `auth.json`（`$AGENTSWITCH_HOME/profiles/codex/<id>/home/`，启动时都带 `-c cli_auth_credentials_store="file"`，不进钥匙串）——与 `~/.codex/auth.json` 同一种明文文件，不是密文。daemon 读它只为一件事：解开身份令牌的中间一段取 `email`，随 `GET /profiles` 给屏幕（`Default` 读 `~/.codex/auth.json`，同样只取这一项）；令牌本身不存、不记日志、不给任何屏幕。是否已登录跑 Codex 自己的 `codex login status`，只取退出码（它也只说“已登录 / 没登录”）。整个 `profiles/` 在执行器的禁读名单里（`protected.ts` 的 `readDenied`），所以 Files 栏里它也锁着；Codex 执行器没有按路径的读限制这一条照旧。**终端里的 agent 读得到**任何配置的 `auth.json`，与它读得到 `~/.codex/auth.json` 一样（同一 uid，终端只关网关与节点，terminal-v0 §3）。
- 配置的浏览器与共用浏览器同一个引擎选择（装了 Camoufox 就是 Camoufox，各有自己的指纹，按配置出口的时区启动；否则 Chrome），由 daemon 带自动化接口启动、有窗口；人在里面登录时输入的内容，daemon 进程在技术上够得着（与共用浏览器一样）。

## 熬过重启的终端（daemon `src/terminals/held.ts`、`host.ts`，`native/pty-hold.c`，terminal-v0 §10；2026-10-15，2026-10-31 复审）

- 持有进程只在 Unix 套接字 `terminals/<id>/hold.sock`（目录 0700、套接字 0600）上收一个连接，连接要带只有 daemon 知道的令牌（恒定时间比较；令牌经 stdin 传入，不上命令行）。令牌错的连接顶不掉已连着的 daemon。
- `terminals/<id>/meta.json`（0600）里有明文的 hook 令牌（凭它可 `POST /terminals/key` 取到配置的明文 API key）、转发口口令、浏览器会话令牌、companion 服务的口令。所以 `$AGENTSWITCH_HOME/terminals/` 对调度的执行器禁读（`defaultProtected.readDenied`），对终端里的 agent 也禁读（`terminalProtected`：别的终端的令牌是静置的凭据，自己的在环境变量里；2026-10-31）。文件栏按同一张表不列它。
- 服务不在的那段时间（重启、换版）：被持有终端的 hook 程序对 `PreToolUse` 一律拒绝（`AGENTSWITCH_TERMINAL_HELD=1`，`hookClient.ts`），不放行——受保护路径的底线只在有服务应答时才成立；随服务一起结束的终端没有这一条。卡片等到超时的仍照旧不答。
- 下一个 daemon 接不回的终端（接回出错、持有功能关了、运行时里没有持有进程）：结束它的程序和它 companion 的服务（`endHeld`、`endLeftHeld`），不留下无人看管、hook 无人应答的 agent。
- 旧 daemon 还连着时新 daemon 接走终端：持有进程给旧连接发一条 `replaced` 再断开；旧 daemon 把它当作放手——不删 `meta.json`、不停 companion 的服务、不记失败的一轮。持有进程被杀的同样处理（下一个 daemon 发现持有进程不在才忘掉）。
- 持有进程对连着的 daemon 做反压：没发完的输出接近环形缓冲的容量就停读伪终端，程序在写上等，与 node-pty 一样不丢字节（复审时 60 MB 洪水曾丢 22.6 MB）；没有 daemon 时缓冲只留最后一段，这是设计。

## 凭据网关服务（gate-service-v0）

| 入口 | 规则 | 挡什么 | 失败行为 | 测试 |
|---|---|---|---|---|
| `gate.sock` 连接 | socket 0666；连接时由内核（`LOCAL_PEERCRED`）给出对端 uid，只放行 root 和 `gate-service.json` 的 `ownerUid`；配置缺失或无效时只放行 root | 本机其他用户调用网关 | 不读请求，直接断开 | `tests/test_rpc.py::test_socket_is_0666_and_only_allowed_uids_get_an_answer`、`tests/test_rpc.py::test_peer_uid_is_the_kernels_record_of_the_other_end`、`tests/test_rpc.py::test_allowed_uids_come_from_gate_service_json` |
| 请求格式 | 每行一个 JSON，单个请求 ≤ 1 MiB；每个方法按字段白名单和类型校验参数；每个连接一个线程，慢调用不阻塞其他客户端 | 超大请求、多余参数、单个慢调用拖住服务 | 回中文原因；超长行回错误后断开 | `tests/test_rpc.py::test_requests_over_one_mebibyte_are_refused`、`tests/test_rpc.py::test_protocol_errors_are_answered_in_chinese_and_the_connection_survives`、`tests/test_rpc.py::test_a_slow_call_does_not_hold_up_other_clients` |
| 返回值 | 同 uid 分不出 daemon 和 agent，每个方法按“调用方可能是 agent”设计：没有方法返回私钥；只有 `browser.resolve` 返回明文；`mcp.http` / `mcp.exec` 的结果先脱敏；HTTP 传输错误只回异常类名（原文可能带着替换后的 URL） | 调用方拿到私钥或明文 | — | `tests/test_rpc.py::test_mcp_methods_run_inside_the_service_and_redact`、`tests/test_rpc.py::test_mcp_http_transport_errors_name_the_failure_only`、`tests/test_mcp_forward.py::test_every_tool_is_forwarded_with_this_executions_scope` |
| `browser.resolve` | 密文用途必须含 `fill`（只有 `http` 不够；例外：用迁入的旧密钥封的、用途含 `http` 的密文，那把私钥本来就对登录用户可读过）；`host` 必须是具体的 `host:port` 且在密文允许列表内；引用只在其范围内解析 | 同用户进程借浏览器接口取只用于 http / exec / otp 的密文明文 | 拒绝，浏览器什么都不输入 | `tests/test_rpc.py::test_browser_resolve_is_fill_only_and_host_checked`、`tests/test_rpc.py::test_browser_resolve_lets_http_tokens_of_moved_in_keys_be_typed_but_not_new_ones`、`tests/test_remote_resolver.py::test_remote_resolver_policy`、`tests/test_remote_resolver.py::test_browser_gate_fills_through_the_service_and_redacts` |
| 审计 `logs/rpc-audit.jsonl` | 每次调用一行：时间、方法、对端 uid、范围的短哈希、label、host、结果和原因；不写值、密文、范围本身；0600 | 日志里出现值或范围 | 写不进去只报 stderr | `tests/test_rpc.py::test_mcp_methods_run_inside_the_service_and_redact`、`tests/test_rpc.py::test_browser_resolve_is_fill_only_and_host_checked` |
| 密钥变更（`keys.new/use/retire`） | 在服务内串行；legacy 密钥只解密、不能设为当前，当前密钥不能删；变更后原子写 `keys.json`（只含公钥）并向代理发 SIGHUP，代理重新加载全部私钥，加载失败时保留原有密钥 | 把暴露过的旧密钥设回当前；代理继续用旧的密钥集合 | 拒绝；重载失败保留旧密钥并记日志 | `tests/test_keyring_legacy.py::test_legacy_keys_decrypt_but_never_become_current`、`tests/test_keyring_legacy.py::test_retire_deletes_only_legacy_keys`、`tests/test_rpc.py::test_status_and_keys_methods_publish_and_signal_the_proxy`、`tests/test_publish.py::test_keys_json_is_published_atomically_with_public_keys_only`、`tests/test_publish.py::test_sighup_reloads_every_key_of_the_home`、`tests/test_publish.py::test_a_failed_key_reload_keeps_the_previous_keys` |
| 登录用户的 CLI、MCP、浏览器组件 | `gate.sock` 属于其他 uid 时进入服务模式：`keys.json` 按不可信输入校验；`keygen`、`check`、`proxy`、`service`、`install-ca`、`rpc` 拒绝；服务无响应时报错，从不退回本地网关或在用户目录生成密钥 | 服务模式下悄悄在用户侧恢复私钥，撤销隔离 | 退出码 2，“凭据网关服务无响应” | `tests/test_service_cli.py::test_commands_the_service_owns_are_refused`、`tests/test_service_cli.py::test_unavailable_service_is_reported_not_bypassed`、`tests/test_service_cli.py::test_client_mode_needs_a_socket_of_another_user`、`tests/test_publish.py::test_keys_json_is_validated_as_untrusted_input` |
| 安装：登录用户的目录 | root 只经以 O_NOFOLLOW 打开的目录描述符访问 `~/.secret-gate`、`~/.mitmproxy`、`~/Library/LaunchAgents`；目录须属于 `ownerUid`；只读属于 `ownerUid`、只有一个硬链接的普通文件；`MOVED.txt` 以 O_EXCL 新建 | 预置的符号链接或硬链接让 root 读取、删除或覆盖别处的文件 | 跳过该项 | `tests/test_system_install.py::test_symlinks_in_the_users_home_are_never_followed` |
| 安装：密钥迁移 | 先复制并校验（读回比对、私钥须推出同一公钥）；服务启动并列出这些密钥后才删除原件，且只删服务中有相同副本的；任何一步失败即停止并列出已做、未做的步骤，不回滚 | 安装中途失败丢失私钥 | 停止；原件保留 | `tests/test_system_plan.py::test_install_plan_orders_the_steps_so_no_key_is_ever_lost`、`tests/test_system_install.py::test_originals_stay_when_the_service_never_answers`、`tests/test_system_install.py::test_a_failing_command_stops_the_install_and_says_what_was_not_done`、`tests/test_system_install.py::test_unusable_old_keys_are_reported_and_kept` |
| 安装：运行时副本 | 服务只运行 root 拥有的 `<root>/runtime/`，从不运行 App 包里的程序；目录 0755、文件 0644/0755；指向副本之外的符号链接使安装失败 | 登录用户改 App 包里的 Python 即拿到服务账户 | 安装停止 | `tests/test_system_install.py::test_a_runtime_symlink_leaving_the_copy_is_refused`、`tests/test_system_install.py::test_install_migrates_everything_and_leaves_moved_txt` |
| LaunchDaemon | `UserName`/`GroupName` 为 `_agentswitchgate`；环境只有 `SECRET_GATE_HOME`、`HOME`、`SECRET_GATE_PUBLIC` 和由 root 拥有的目录组成的 `PATH`，没有代理变量；`Umask` 077；网关目录安装时 `chmod -R go-rwx` | 代理变量或用户可写目录里的程序进入服务 | — | `tests/test_system_plan.py::test_launch_daemon_plists`、`tests/test_system_plan.py::test_install_plan_commands_and_paths` |

## 已知缺口（不要当成已解决）

- 截图用的快照和实际截图之间页面仍可能变化：新插入的节点若含敏感值，不在遮罩计划里。像素核对只能证明计划内的框被盖住。
- 遮罩计划来自无障碍快照：`aria-hidden` 的元素、CSS `content:` 生成的文字画面上可见，但不在快照里，不会被遮。
- 跨域 iframe 的内容若没出现在快照里、关闭的 Shadow DOM、图片和与受保护值无关页面上的 canvas 不会被识别；只在持有过受保护值的页面整块遮 canvas。
- 个人信息只按邮箱、手机/电话、身份证号、银行卡四类模式识别；姓名、地址等不在模式内的字段既不遮也不封装。
- 普通凭据（非页面封装值）填写时不核对表单提交去向，只核对页面 host；同 host 其他路径的提交仍依赖密文的 host 绑定。
- 执行器的路径限制（daemon `protected.ts`，gate 家目录、浏览器会话槽位、远程 TLS 私钥禁读）对工具参数里的路径按规范写法与文件身份比较（2026-10-02 起，`src/core/paths.ts`）：`..`、符号链接、大小写、数据卷的写法 `/System/Volumes/Data/Users/…` 都落到同一个根（此前 Claude 的 Read/Edit/Grep 与终端的 PreToolUse 底线用 `/System/Volumes/Data<路径>` 或换大小写即可读到 gate 的密钥）；OpenCode、Claude Code、Codex 自己的按文字匹配的规则另加数据卷写法。shell 命令仍是字符串匹配：绝对路径、`~`、`$HOME`、`${HOME}`、引号和转义的各种写法都认得出，但 `cd` 之后的相对路径、通配、shell 变量、`find ~ -exec` 认不出；OpenCode 不检查参数带 `$` 的 `cd`；Codex 没有按路径的读限制（它在沙箱里读哪都行；申请到沙箱外跑的命令才按禁区检查，2026-09-25）。这些防的是执行器误读，不防有意绕过。装了凭据网关服务后，网关目录对登录用户在文件系统层面不可读，这些规则对它退为锦上添花；没装服务时它们仍是唯一的屏障。
- 浏览器登录会保留（daemon 的三个会话槽位，threads-v0 §4b）：gate 进程只认得本会话填过、封装过的值，旧会话留在页面上的账号名、页面数据不在它的状态里，截图遮罩和文本脱敏都不覆盖（个人信息四类模式仍生效）。profile 目录对 Claude、OpenCode 执行器禁读；Codex 没有按路径的读限制，能读到 cookie 数据库。
- 服务持有的共享浏览器（daemon `src/browser/`，browser-v0 §5；人在 App 里用，终端里的 agent 经 agent 桥用——2026-10-08 起不经 gate，见上一节；调度的任务仍用会话槽）：Chrome 只经管道连到 daemon，无调试端口；`file:` 只有人的标签可开，凭据名单与 AgentSwitch 自己的数据、端口在打开前与浏览器内每个请求上按真实路径与文件身份检查（数据卷写法、大小写、符号链接都认得出；`packages/daemon/tests/browserRules.test.ts`、`browserHost.test.ts`）。AgentSwitch 自己的端口（本机接口、远程、网关代理、各 OpenCode 服务）是纵深防御：`localhost.` 等写法、解析到本机的主机名也拦；跳转到这些端口时，子资源由 Chrome 自己拦（`Network.setBlockedURLs`），页面导航无法在发出前拦住（Playwright 不让路由看到跳转的下一跳），请求会到达服务、页面随即停下并显示拒绝；Chrome 自己解析名字，DNS 重绑定绕得过名字检查。这些服务各自要凭证。`main` 配置的登录态会与终端里的 agent 共用；该目录对执行器禁读，对终端里的 agent 不禁读（与用户同一 uid，terminal-v0 §3），它们能读到 cookie 数据库。人在页面里打的字直接进页面，不经网关脱敏；在 agent 的标签里手打的，交还后 agent 的快照看得到（非密码框），见上一节。
- 共享浏览器为 Camoufox 时（browser-v0 §7）：页面里的链接或内嵌指向受保护的本地文件，拦截是事后的（页面到了再换成拒绝页），内容会出现一瞬，画面流与截图在那一瞬可能带到它；只有人的标签能开 `file:`，所以碰得到的是人自己的标签。
- 共享浏览器的上游代理密码：解密后的明文在 daemon 进程的内存里（转发层连接上游要用），直到换代理或服务退出。它不进任何持久的地方，但 daemon 与登录用户同一 uid，同用户的进程读得到进程内存；要让 daemon 也不持有，需要网关自己去连上游代理（一个新入口），未做。
- 共享浏览器的登录状态在 Camoufox 自己的配置目录里（`$AGENTSWITCH_HOME/browser-profiles/main-camoufox`），与 Chrome 那份不通；它与 `browser/`（身份文件、引擎）都在执行器的禁读名单之内（`protected.ts` 的 `readDenied`），Codex 没有按路径的读限制这一条照旧。
- 同一 macOS 用户下，其他进程能读到 gate MCP 进程的环境变量（含执行范围）和 shell 的代理地址。执行范围防的是误用和跨任务串值，不防同用户的主动窥探；凭据网关服务也不改变这一点（范围仍在用户侧进程里，`gate.sock` 分不出 daemon 和 agent）。
- 凭据网关服务：浏览器组件仍以登录用户身份运行，所以用途含 `fill` 的密文，同用户的进程可以冒充浏览器组件，对它声称的、在允许列表里的站点经 `browser.resolve` 取到明文。服务逐次记审计，但无法核实调用方真的是浏览器组件、页面真的在那个站点。只用于 http / exec / otp 的密文不受影响。
- 凭据网关服务：`browser.resolve` 只认 `fill`，所以只有 `http` 用途的新密文在服务模式下不能由浏览器填写（用旧密钥封的除外）。2026-09-27 起调度模型封装网站表单要填的值、手机新建密文（默认）、`credential-reissue` 修复出的种子导入密文都带 `http` + `fill`；只由工具放进请求的接口密钥只带 `http`，浏览器那条路取不到它。模型若把网站密码误标成只有 `http`，浏览器填写会被拒绝（失败即关闭），需重新提交。
- 凭据网关服务：浏览器组件在用户侧做的判断（截图遮罩、填写前的拒绝、封装）不再写 `browser-audit.jsonl`，服务只记录 `browser.resolve` / `browser.register` 调用本身。
- 凭据网关服务：`secret_exec` 以服务账户运行模板命令。模板若指向登录用户可写位置的程序（如 Homebrew 目录），该程序以服务账户身份拿到明文并可交给登录用户；模板应只写 root 拥有的程序的绝对路径。服务的 `PATH` 只含 root 拥有的目录。
- 凭据网关服务不防 root 或管理员，也不防安装、更新那一刻 App 包已被篡改：用户输入管理员密码时信任的是当时的 App 包。
- 本机回环地址上的目标（`127.0.0.1:<port>`）谁先占端口谁拿到明文，与账户无关。
- `logs.tail` 把代理和 rpc 服务的日志尾部返回给登录用户（Mac 应用的日志按钮）：其中有 host 和错误摘要，不含值，但同 uid 的 agent 也能读到。

## 配对的手机管理代理（daemon `src/api/clash.ts`、`profiles.ts`、`browserIdentity.ts`，`src/remote/routes.ts`；2026-10-09）

- 手机够得着的：Clash Integration 的十条页面接口、配置自己的代理（设、撤、查出口）、共用浏览器的代理（看、设、撤、重启浏览器）。都要配对设备的令牌，走钉了证书的那条连接；每次写操作在 daemon 日志里留一行（方法、路径、状态，不含正文）。
- 手机够不着的：Clash Verge 与内核取订阅的四类地址（只在本机回环、只认地址里的口令），以及带着这个口令的 `install` 链接——给手机的 Clash 页面里它是空串；浏览器指纹的正文（手机只拿到摘要一行）与更换指纹（403）；配置自己的浏览器的身份；浏览器引擎的更新；新建、删除配置与配置的颜色。
- 订阅链接是凭据（多数带口令）：它由人在手机上粘贴，经那条连接进 daemon，和在 Mac 上粘贴一样存在 `clash/` 目录（0600），此后任何屏幕都只拿到它的主机名。它不进执行器上下文、任务库和日志。
- 代理密码不以明文离开手机：封成只对代理自己 `host:port` 有效的密文后才发；daemon 向网关要明文时，网关照旧按密文的站点与 `fill` 用途核对并记审计。手机用的公钥先现要一次（`GET /gate/pubkey`），要不到才用配对时存下的；公钥过期时封出来的密文网关解不开，接口拒绝、什么都不改。
- 设备丢失：在 Mac 上移除这台设备，令牌即失效。手机能改出口，不比它原本就能做的（在这台 Mac 上开终端、派任务并批准）更多。

## 节点之间（daemon `src/nodes/`、`src/api/nodes.ts`、`src/remote/`，mesh-v0；2026-10-10）

- 配对的设备可以是另一个节点（另一台 Mac 上的服务）。它够得着的和手机一样，是同一张远程路由表、同样的限制；多出的三条：`DELETE /me`（设备移除自己）、`GET /node`（这个节点叫什么、有什么）、`GET /live`（在忙什么、几件事在等人，只读）。
- 原样按键（`POST /terminals/:id/write`）对配对的设备放开了，由节点自己的开关管（`PUT /settings/mesh`，只在本机；默认开）。它不比已有的入口多出权限：文字入口本来就能打任何命令再回车，指定按键里本来就有 ⇧Tab。配对的设备往一个终端里打字，每分钟在终端审计里记一行（不含内容）。
- 配对默认两个方向：兑换配对码的节点可以附上自己的配对载荷，出码的节点据此反过来兑换一次。出码时可以声明只要单向（`POST /pairing {back:false}`）。回程只让出码的节点多了“能用对方”，不增加对方在这边能做的事。载荷里的地址只认私网、链路本地、Tailscale 网段和 `*.ts.net` 的名字：载荷不能让这台机器去连别处。
- 这个节点保管着它在别的节点那里的设备令牌（`$AGENTSWITCH_HOME/nodes/peers.json`，目录 0700、文件 0600）。**拿到其中一个就能在那台机器上开终端。** 所以：
  - `nodes/` 在禁读名单里，执行器和终端都一样（终端里别的服务文件是开着的，这里不是）。
  - 经本机服务去用别的节点（`/nodes/<节点>/…`）、配对、移除，除了 `local-token` 还要节点钥匙（`nodes/key`，请求头 `x-agentswitch-nodes`）。终端里的 agent 读得到 `local-token`，光凭它到不了下一台机器。
  - 这两条都是底线而不是墙：禁读是字符串匹配（经 `cd`、通配符、变量、`find` 到达的路径看不见），同一个用户的进程存心要读是读得到的。
- 去别的节点的连接只在证书指纹与配对时一致之后才交给 HTTP：令牌不会发到别的证书后面。调用方自己出示的 `Authorization`（本机令牌）不转给对方，对方收到的是这个节点的设备令牌。
- `/nodes/…` 只在本机接口上，远程路由表里没有：配对进来的设备不能借这个节点去用第三个节点。没有跨节点调度，密文不跨节点（每个节点自己的网关和密钥对）。
- **风险是对称的**：互通的两个节点，一个上面的 agent 越过了上面的底线，就能在另一个上面开终端。只留一个方向、或移除，随时可以在任一边做；移除时会请对方吊销自己这台设备。

## 文件栏（daemon `src/files/browse.ts`、`src/api/browse.ts`、`src/remote/admin.ts`，files-v0 §7；2026-10-16）

- 文件内容第一次经服务到了配对的设备上：`GET /files`（一层）、`/files/stat`、`/files/preview`（文字的前 64 KB）、`/files/thumbnail`（图片的小图）、`/files/content`（原样的字节，给配对设备的一次至多 25 MB）。都只读，没有写的接口。
- AgentSwitch 自己存凭据的地方（与执行器的禁读名单同一张表：网关目录与 socket、浏览器会话槽位与共用浏览器的状态目录、远程 TLS、`local-token`、`nodes/`）：列出时只有名字和锁，没有大小、时间；进不去、读不到、不能作为 `{path}` 附件交给 agent——本机的屏幕也一样。按真实位置与文件身份比较（`src/core/paths.ts`）：符号链接按目标、指向它们的硬链接按身份、经它们里面的链接出去的路径也拒。路径只收绝对、写法干净的（不收 `..`、`.`、双斜杠）。
- 可能含凭据的文件（`~/.ssh/` 的私钥、`.env`、`~/.aws/credentials`、各 agent 的登录文件、`*.pem` 等，只按路径和名字判断）**不锁**（用户定：看就行）：能列、能预览，手机上也能；交给 agent 前界面问一次（`/files/stat` 的 `sensitive`）。服务不拦：这是提醒，不是边界。
- 配对的设备读文件受两样管，都只在这个节点自己身上设（本机接口，不在远程名单）：节点自己的开关（`PUT /settings/mesh {files}`，默认开；关了 `/files…` 与它的 `{path}` 附件一律 403）和每个设备的范围（`PUT /devices/:id/files`：家目录（默认）、全部、几个文件夹、无；存在 `mesh.json`，设备吊销时一并删掉）。范围之上的几层只列通往授权文件夹的那几项。范围外的回 403。
- 配对的设备每读一次文件内容（预览、小图、字节）在 `$AGENTSWITCH_HOME/files/audit.jsonl` 记一行：设备、路径、字节数，不记内容。列目录不记。
- **范围不是沙箱**：配对的设备照样能开终端，让 agent 读范围外、甚至可能含凭据的文件（配对的设备本来就等于能以用户身份跑命令，见上一节）。范围管的只是文件栏和附件能看到、能交出去的。
- **文件栏能改文件了**（files-v0 §12，daemon `src/files/change.ts`、`src/api/fileChanges.ts`；2026-10-18）：`POST /files/{folder,file,rename,trash,restore}` 与 `PUT /files/content`（手机传进来的文件，原样字节，一个至多 200 MB，边收边写进同一个文件夹里的临时文件，收完才改成真名；配对设备取文件的上限也随之放到 200 MB，为了在手机上分享/存下）。
  - 不动的：AgentSwitch 自己存凭据的地方、**装着它们的文件夹**（家目录、`~/.agentswitch` 一串：移走或改名就把凭据一起搬走了）、`/` 和它下面一层；指进禁区的链接按禁区算。新建、传进来的东西也不能落进禁区。
  - 删除一律是移到废纸篓（Mac：系统的 `NSFileManager.trashItem`，经 `osascript` 的脚本桥；Linux：freedesktop 的废纸篓）；只有废纸篓不收、并且再次明确要求时才永久删除。`restore` 只从废纸篓里往外搬，不能当成一般的移动。
  - 配对的设备改文件另受一个开关管（`PUT /settings/mesh {changes}`，默认开，本机接口），并且只能改它读得到的地方（同一个范围）。有终端在里面运行的文件夹，移走或改名前先问（409 `in-use`）。
  - 每次改动（本机和远程）在 `files/audit.jsonl` 记一行：设备、动作、路径（改名多一个新路径，传文件多字节数），不记内容。
  - 本机网页的防跨站规则只多放行 `PUT /files/content` 的 `application/octet-stream`（浏览器对它本来就要先预检）。

## Linux 节点（`packages/linux`、daemon `src/keeper/`，mesh-v0 §4；2026-10-13）

- **凭据网关与登录用户同一个账户**（mesh-v0 §4.5 的“同用户”一档；独立账户那一档还没做）。私钥在 `~/.secret-gate`（0700），挡住 agent 的只有禁读规则——字符串匹配的底线，同一个用户的进程存心要读是读得到的。这是 Mac 在 2026-09-27 装上网关服务之前的状态。服务器上 agent 更常以自动或跳过权限的方式跑，所以独立账户是要补的下一步，不要把现在的样子当成隔离。
- 网关服务的公开目录在 Linux 上按 `/var/lib/agentswitch/gate-public` 算进禁读名单（daemon `src/executors/protected.ts`），为以后的独立账户留好；同用户一档下那里没有东西。
- 看护进程（`agentswitch node run`）交给网关和 daemon 的环境是一张白名单（daemon `src/keeper/plan.ts`）：不带代理变量、不带任何密钥，`PATH` 取登录 shell 的；和 Mac 应用的 `ChildEnvironment` 同一个原则。
- 工作目录与浏览器打开文件的禁区补上 Linux 的凭据位置：`~/.local/share/keyrings`（GNOME 钥匙串）、`~/.local/share/opencode`（OpenCode 的登录与库）、`~/.pki`（NSS 的证书和私钥）；工作目录另禁 `~/.mozilla`。Claude Code 在 Linux 上把登录放在 `~/.claude/.credentials.json`（Mac 上在钥匙串），`~/.claude` 本来就在工作目录禁区里、文件名本来就在浏览器的凭据文件名里。
- 远程口的来源限制不变（私网、链路本地、100.64/10、IPv6 ULA）。配对载荷里的地址去掉了容器与虚拟机的网卡，不改变谁能连进来。
