# claude-code-turbo

[![test](https://github.com/Mossab28/claude-code-turbo/actions/workflows/test.yml/badge.svg)](https://github.com/Mossab28/claude-code-turbo/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/claude-code-turbo)](https://www.npmjs.com/package/claude-code-turbo)

Run Claude Code faster — less waiting, a fraction of the bandwidth, and none of it at the cost of quality.

```bash
npm install -g claude-code-turbo
cct            # instead of `claude`  (`cct` still works)
```

That's the whole thing. Same Claude Code, same everything — faster turns,
fewer bytes on your connection, and a number telling you how much of each.

---

## The problem nobody measures

The Messages API is stateless, so the client re-uploads **the entire
conversation on every single call**. Prompt caching saves server compute, not
bytes on your wire.

Measured on real local sessions:

| session | requests | uploaded | downloaded |
|---|---|---|---|
| 549 turns | 549 | **851 MB** | 6 MB |
| 674 turns | 674 | **835 MB** | 6 MB |
| 159 turns | 159 | **183 MB** | 3 MB |

Upload beats download by a factor of about 100. Two consequences follow, and
they shape everything this tool does:

1. **Cost is quadratic in session length.** Every byte you add to the context
   is paid again on every remaining turn.
2. **Every tool call is a full turn.** An `ls` on a 200k-token context costs
   ~700 KB of upload — the same as a real question.

## The counterintuitive part

**A Claude that reasons more uses less bandwidth.**

Thinking is output tokens: it comes *down*, and it weighs about 6 MB per
session. Flailing is input tokens: every tool call re-uploads the whole
context. One well-aimed command beats five approximate ones, on your data plan
as much as on your patience.

So `cct` never trades reasoning quality for bytes. That trade would lose on
both sides.

## What it does

`cct` starts a local proxy, points Claude Code at it, and runs the real
`claude` underneath. No fork, no server, no account, no third party.

```
claude (child process)  ->  127.0.0.1:<ephemeral>  ->  api.anthropic.com
                                 cct proxy
                          measure · compress · trim · guard
```

| lever | effect |
|---|---|
| **Image downscaling** | The big one. The 3 most recent images pass untouched; older ones are re-encoded at 1024px. Nothing is ever removed. |
| **Request body compression** | Probed on the first call, used only if the API accepts it. Worth far more once images are out of the way — see below. |
| **Tool-output cap** | Caps any single tool result at 32 KB, truncating the middle and marking the elision. Claude Code already caps its own bash output, so this mostly catches MCP results and large file reads. |
| **Effort router** | Turns that answer only successful read-only tool results (Read, Glob, Grep, LS, Todo) run at `medium` effort instead of the session default. Less thinking on turns with nothing to think about — user messages, errors, writes and unknown tools are never touched. `cct gain` shows the measured time saved. |
| **Connection reuse** | Keep-alive. A TLS handshake is ~6 KB and a long session makes hundreds of requests. |
| **Non-conversation traffic** | Telemetry, error reporting, auto-updater and non-essential model calls, all off. |

Every transform is a **stable function of its input**, so the same content
always produces the same bytes and the prompt cache stays valid. The one
exception is an image crossing out of the recent window, which invalidates the
cache once for that image.

## How much does it actually save

About **3x** — measured by replaying real 1600-message sessions through the
levers, not extrapolated from a toy example.

| | image-heavy session | ratio |
|---|---|---|
| raw | 19.6 MB | — |
| compression only | 12.7 MB | 1.5x |
| image downscaling only | 10.3 MB | 1.9x |
| **both** | **6.4 MB** | **3.0x** |

The interesting part is why compression alone is so weak. On a session with
screenshots, **86% of the uploaded body is base64 image data**, and base64 of
an already-compressed PNG does not compress. Shrinking the images is what lets
the compressor reach the text underneath, so the two levers multiply instead of
overlapping.

On a session with no screenshots, compression alone lands between 2.4x and
3.5x, depending on how much of the payload is tool schemas — those are
repetitive JSON and compress beautifully.

## What you see

At the end of a session:

```
  cct — 4 requests
  sent      219 KB
  received  3.5 KB
  saved     590 KB — without cct: 809 KB (3.7x)
  levers    compression
  breakdown tool schemas 683 KB, text 126 KB, tool results 259 B
```

And across sessions:

```bash
cct report    # per-session history and lifetime totals
cct gain      # time saved by the effort router, across sessions
cct doctor    # which levers are active here, and what to fix on your side
```

## Runaway protection

On by default, with thresholds wide enough that a normal session never meets
them:

- warning at 500 MB uploaded in one session
- hard stop at 2 GB, closing cleanly — resume with `cct --resume`
- warning on any single request over 5 MB, naming the dominant category

```bash
cct --cap 200MB      # tighter, for a metered connection
cct --no-cap         # off
```

The guard **never modifies the conversation.** Injecting an instruction into
the prompt to save bandwidth would degrade the reasoning, which is the opposite
of the point.

## Options

```
cct [claude args...]   run Claude Code in lite mode
cct report             bandwidth per session
cct gain               time saved by the effort router
cct doctor             which levers are active on this machine

--cap <size>       session cap, default 2GB (--no-cap to remove)
--warn <size>      warning threshold, default 500MB
--tool-cap <size>  cap per tool result, default 32KB
--effort <level>   effort for mechanical turns, default medium
--no-effort        disable the effort router
--no-images        disable image downscaling
--no-gzip          disable request body compression
```

Everything else is passed through to `claude`, so `cct --resume`,
`cct -p "..."` and the rest work exactly as you'd expect.

## Things you can do that cct can't do for you

`cct doctor` will remind you, but the three biggest wins are on your side:

- **Turn off MCP servers you don't use.** Their tool schemas are re-uploaded on
  every request. Seventy-five connector tools is roughly 50k tokens per turn,
  which is ~100 MB over a long session.
- **Raise your reasoning effort.** See above — it lowers bandwidth.
- **`/clear` between topics.** Upload scales with the square of session length,
  so a fresh session is dramatically cheaper than a long one.

## Not doing

- **A delta relay.** Turn N's body is turn N−1's plus a suffix, so sending only
  the diff would cut upload by 20-50x. It needs a server the user doesn't have,
  and that server would decrypt the conversation. Out of scope, on purpose.
- **Aggressive context compaction.** Losing context makes Claude redo work, so
  more turns, so more bytes — and it violates the one rule this project has.
- **Forking Claude Code.**

## Requirements

Node 18+, and Claude Code installed. **Zero npm dependencies** — `http`,
`https` and `zlib` from the runtime are enough.

Runs on macOS, Linux and Windows. Image downscaling shells out to whatever is
already on the machine and stays inactive if none is present:

| platform | image tool |
|---|---|
| macOS | `sips`, built in — nothing to install |
| Linux | ImageMagick or ffmpeg |
| Windows | ImageMagick or ffmpeg |

Without one, `cct` still runs and still compresses; you just get the ~1.5x from
compression instead of ~3x. `cct doctor` tells you which case you are in.

## Privacy

The proxy runs on `127.0.0.1` and talks only to `api.anthropic.com`.
Authentication headers are forwarded verbatim, never read, stored, or logged.
The ledger under `~/.ccl/` records byte counts and nothing else — no prompts,
no responses.

## License

MIT
