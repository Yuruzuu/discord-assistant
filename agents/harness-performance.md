# Harness performance verification

Run the reproducible comparison from the repository root:

```sh
node scripts/benchmark-harness.mjs --baseline d7ac201 --samples 20 --delay-ms 30
```

The script archives the specified Git commit into a temporary directory, links the already-installed dependencies, and imports the actual baseline and current working-tree conversation and scheduler modules. The baseline is explicit so a release commit does not accidentally become its own comparison. Temporary files are removed afterward.

Both versions run against the same in-process fake Codex backend. It creates no Discord messages, performs no network calls, and consumes no model quota. Workers are warmed before collecting twenty samples. Output reports nearest-rank p50/p95 and signed after-minus-before differences for:

- Time to the first response under two simulated 30 ms progress callbacks per tool call.
- Admission delay for an independent conversation while another conversation runs a simulated 30 ms job. Rate limiting and post-reply cooldown are disabled for this isolation check.
- Serialized input bytes when an approved memory snapshot stays unchanged across warm turns.
- Serialized input bytes for short chats with empty memory/expression snapshots, verifying revision metadata does not inflate their context.

These measurements establish harness behavior under controlled conditions. They do not predict provider response latency, Discord API latency, actual billed tokens, or end-to-end percentage speedups. Input byte estimates in live status are approximate and must not be reported as tokenizer measurements.

The October 7, 2026 run used twenty samples, 30 ms simulated delays, baseline `d7ac2018e0c5eab64e97761b879431682b054c4b`, and the implementation working tree:

| Synthetic measurement | Baseline p50 / p95 | Working tree p50 / p95 |
| --- | --- | --- |
| First reply with slow progress callbacks | 64.1 / 65.3 ms | 1.6 / 2 ms |
| Independent conversation admission wait | 31.1 / 31.7 ms | 0 / 0 ms |
| Repeated approved memory input | 12,494 / 12,494 bytes | 236 / 236 bytes |
| Short chat input | 194 / 194 bytes | 194 / 194 bytes |

Timer results vary between runs. The synthetic approved-memory fixture is smaller than Nova’s 16 KiB memory limit. The input-byte results exclude stable base instructions, native conversation history, images, and provider-internal context. They measure repeated turn payloads only.

Live stage metrics retain bounded numeric samples and counters only. Relevant stages separate scheduler wait, context preparation, worker startup, model/first-output time, host tools, settlement, and actual reply delivery. Recent p50/p95 measurements should be compared with the same requests and model settings. Counters and percentile windows remain local to each runtime; restarting a listener resets them. Prompts, memory contents, tool arguments, raw errors, and source results are not retained by the metrics collector.

For reliability, targeted tests cover slow/failing progress rendering, queue fairness and cancellation, RPC late responses and worker failure, partial message delivery, recoverable turn failures, native compaction, context rollback, bounded result handles, and private-source retrieval guards. Passing synthetic tests establishes these contracts, not live Discord or provider health.
