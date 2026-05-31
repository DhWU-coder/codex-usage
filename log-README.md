# Codex 用量项目日志接入规范

这份文档是给 AI 代理或其他模型看的。目标是让它在另一个项目里注入日志写入逻辑，使那个项目运行时产出 `codex-usage` 可以直接导入识别的 token 用量日志。

不要默认把本文件复制到目标项目。读取本文件后，在目标项目代码里实现日志写入，让目标项目生成：

```text
<target-project>/.codex-usage/usage.jsonl
```

只要这个文件存在，`codex-usage` 前端的“导入目录”就可以导入 `<target-project>` 目录。

## 接入任务

1. 找到目标项目里实际调用 Codex、`codex-oauth` 或 OpenAI-compatible 模型 API 的代码路径。
2. 在每次请求成功返回后，从响应对象中读取真实 token usage。
3. 每次请求向 `.codex-usage/usage.jsonl` 追加一行 JSON。
4. 如果 `.codex-usage/` 不存在，先创建它。
5. 除非用户明确要求提交本地用量日志，否则把 `.codex-usage/` 加入目标项目的 `.gitignore`。
6. 不要记录 prompt、completion、messages、API key、OAuth token、cookie、Authorization header 或完整请求/响应正文。
7. 如果响应里没有真实 token usage，不要估算。跳过这条事件，或在 `usage.jsonl` 之外输出本地 warning。

## 日志位置

默认日志文件必须是：

```text
<target-project>/.codex-usage/usage.jsonl
```

格式是 JSONL，不是 JSON 数组。每一行是一条独立 JSON 对象。

## JSONL Schema

每行推荐格式：

```json
{
  "schema_version": "codex-usage.project-log.v1",
  "timestamp": "2026-05-31T12:00:00.000Z",
  "source": "codex-oauth",
  "channel": "Codex OAuth",
  "project_root": "/absolute/path/to/project",
  "cwd": "/absolute/path/to/project/or/current/workdir",
  "session_id": "stable-session-or-run-id",
  "request_id": "provider-request-id-if-available",
  "model": "gpt-5.5",
  "usage": {
    "total": 12345,
    "input": 10000,
    "cached": 6000,
    "output": 2345,
    "reasoning": 500
  }
}
```

必填字段：

- `schema_version`：固定为 `codex-usage.project-log.v1`
- `timestamp`：请求完成时间，ISO 8601 格式
- `source`：机器可读来源，例如 `codex-oauth`、`openai-api`
- `channel`：前端展示名称，例如 `Codex OAuth`
- `project_root`：目标项目根目录的绝对路径
- `cwd`：这次请求发生时的工作目录绝对路径
- `session_id`：一次会话、一次批处理或一次进程运行的稳定 ID
- `model`：请求使用的模型名
- `usage.total`：服务商返回的总 token 数
- `usage.input`：服务商返回的输入 token 数
- `usage.output`：服务商返回的输出 token 数

可选字段：

- `request_id`：服务商 request id，如果能拿到就写
- `usage.cached`：缓存输入 token；没有就写 `0`
- `usage.reasoning`：推理输出 token；没有就写 `0`

## Token 语义

- `cached` 通常是 `input` 的子集，不要把它再额外加进 `total`。
- `reasoning` 通常是输出 token 的明细或子集；只有服务商返回真实值时才写。
- `usage.total` 优先使用服务商返回的 `total_tokens` 或等价字段。
- 不要根据 prompt 或 response 文本倒推历史 token 用量。

## 常见字段映射

OpenAI 风格响应通常可以这样映射：

```text
usage.total_tokens -> usage.total
usage.input_tokens or usage.prompt_tokens -> usage.input
usage.output_tokens or usage.completion_tokens -> usage.output
usage.cached_input_tokens or usage.prompt_tokens_details.cached_tokens -> usage.cached
usage.reasoning_output_tokens or usage.output_tokens_details.reasoning_tokens -> usage.reasoning
```

如果目标项目实际调用的是 `codex-oauth`，请设置：

```json
{
  "source": "codex-oauth",
  "channel": "Codex OAuth"
}
```

## 写入规则

追加 JSONL，不要每次重写整个文件。

伪代码：

```text
ensure directory "<project_root>/.codex-usage" exists
build event from real response usage
append JSON.stringify(event) + "\n" to "<project_root>/.codex-usage/usage.jsonl"
```

如果目标项目可能并发发起多个请求，使用目标语言的 append mode。不要把日志读出来、拼接、再整体写回。

## 最小校验

完成接入后，让目标项目实际跑一次模型请求，然后在目标项目根目录执行：

```bash
test -s .codex-usage/usage.jsonl
node -e 'const fs=require("fs"); for (const line of fs.readFileSync(".codex-usage/usage.jsonl","utf8").trim().split(/\n/)) JSON.parse(line);'
```

如果这两个命令通过，且日志里没有 prompt、response 正文或密钥，目标项目目录就可以被 `codex-usage` 导入。
