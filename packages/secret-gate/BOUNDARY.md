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
| `browser_evaluate`、`browser_run_code_unsafe` | 不对模型列出；调用一律拒绝。gate 自己用它们做 URL 探测、字段状态、表单去向和遮罩截图，代码只来自 `browser_probe.py` 的固定模板 | 模型用 JS 读 DOM 里的真实值 | 拒绝，不转发 | `tests/test_browser_gate.py::test_list_tools_hides_dangerous_ones_adds_secret_fill_keeps_annotations`、`tests/test_browser_gate.py::test_denied_tools_file_args_and_schemes`、`tests/test_pii_mask.py::test_probe_snippets_embed_only_json_literals` |
| 任意 `filename` 参数（快照、控制台、网络、截图落盘） | 拒绝，并从工具 schema 里去掉 | 未脱敏内容写进模型可读的文件 | 拒绝 | `tests/test_browser_policy.py::test_strip_file_output_removes_only_filename`、`tests/test_browser_policy.py::test_static_refusals` |
| 上传（`paths`） | 一律拒绝 | 把 Playwright 自己的未脱敏输出文件喂给页面 | 拒绝 | `tests/test_browser_gate.py::test_denied_tools_file_args_and_schemes`、`tests/test_browser_mcp_integration.py::test_fill_through_real_mcp_processes` |
| 下载与下游输出目录 | 下游 cwd 和 `--output-dir` 在 gate 家目录下（0700），每次调用后清空 | 快照 `.yml`、控制台/网络日志、遮罩截图文件被模型读到 | 清理失败不影响拒绝逻辑；文件名脱敏不代表文件内容受保护 | `tests/test_browser_mcp_integration.py::test_downstream_command_forces_private_output_dir`、`tests/test_browser_gate.py::test_output_dir_is_swept_after_every_call` |
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
- 执行器的路径限制（daemon `protected.ts`，gate 家目录、浏览器会话槽位、远程 TLS 私钥禁读）是字符串匹配：绝对路径、`~`、`$HOME`、`${HOME}`、引号和转义的各种写法都认得出，但 `cd` 之后的相对路径、通配、shell 变量、`find ~ -exec` 认不出；OpenCode 不检查参数带 `$` 的 `cd`；Codex 没有按路径的读限制（它在沙箱里读哪都行；申请到沙箱外跑的命令才按禁区检查，2026-09-25）。这些防的是执行器误读，不防有意绕过。装了凭据网关服务后，网关目录对登录用户在文件系统层面不可读，这些规则对它退为锦上添花；没装服务时它们仍是唯一的屏障。
- 浏览器登录会保留（daemon 的三个会话槽位，threads-v0 §4b）：gate 进程只认得本会话填过、封装过的值，旧会话留在页面上的账号名、页面数据不在它的状态里，截图遮罩和文本脱敏都不覆盖（个人信息四类模式仍生效）。profile 目录对 Claude、OpenCode 执行器禁读；Codex 没有按路径的读限制，能读到 cookie 数据库。
- 同一 macOS 用户下，其他进程能读到 gate MCP 进程的环境变量（含执行范围）和 shell 的代理地址。执行范围防的是误用和跨任务串值，不防同用户的主动窥探；凭据网关服务也不改变这一点（范围仍在用户侧进程里，`gate.sock` 分不出 daemon 和 agent）。
- 凭据网关服务：浏览器组件仍以登录用户身份运行，所以用途含 `fill` 的密文，同用户的进程可以冒充浏览器组件，对它声称的、在允许列表里的站点经 `browser.resolve` 取到明文。服务逐次记审计，但无法核实调用方真的是浏览器组件、页面真的在那个站点。只用于 http / exec / otp 的密文不受影响。
- 凭据网关服务：`browser.resolve` 只认 `fill`，所以只有 `http` 用途的新密文在服务模式下不能由浏览器填写（用旧密钥封的除外）。2026-09-27 起调度模型封装网站表单要填的值、手机新建密文（默认）、`credential-reissue` 修复出的种子导入密文都带 `http` + `fill`；只由工具放进请求的接口密钥只带 `http`，浏览器那条路取不到它。模型若把网站密码误标成只有 `http`，浏览器填写会被拒绝（失败即关闭），需重新提交。
- 凭据网关服务：浏览器组件在用户侧做的判断（截图遮罩、填写前的拒绝、封装）不再写 `browser-audit.jsonl`，服务只记录 `browser.resolve` / `browser.register` 调用本身。
- 凭据网关服务：`secret_exec` 以服务账户运行模板命令。模板若指向登录用户可写位置的程序（如 Homebrew 目录），该程序以服务账户身份拿到明文并可交给登录用户；模板应只写 root 拥有的程序的绝对路径。服务的 `PATH` 只含 root 拥有的目录。
- 凭据网关服务不防 root 或管理员，也不防安装、更新那一刻 App 包已被篡改：用户输入管理员密码时信任的是当时的 App 包。
- 本机回环地址上的目标（`127.0.0.1:<port>`）谁先占端口谁拿到明文，与账户无关。
- `logs.tail` 把代理和 rpc 服务的日志尾部返回给登录用户（Mac 应用的日志按钮）：其中有 host 和错误摘要，不含值，但同 uid 的 agent 也能读到。
