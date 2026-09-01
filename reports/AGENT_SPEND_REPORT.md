# Where agent spend goes on dj-station

Question: *why are agents spending so much on this project lately, and what is
taking up all the context — test/build output, or exploring files?*

**Short answer: it is reading, not building.** Test and build output is ~2 % of
spend; file reads, greps and the fixed per-call overhead are ~65 %. The single
biggest lever is not "run fewer tests", it is "put fewer tokens into the context
in the first place, and finish the ticket in fewer LLM calls".

---

## 1. Method

Data source: the local agent server (`http://127.0.0.1:18000`),
`GET /api/conversations/search` plus `GET /api/conversations/<id>/events/search`
for the 20 most recent dj-station conversations (2026-08-31T03:17 →
2026-09-01T21:14; this analysis conversation excluded).

Two things make the attribution exact rather than a guess:

- every LLM call leaves a `ConversationStateUpdateEvent(key="stats")` carrying
  *cumulative* cost / prompt / cache-read / cache-write / completion tokens, so
  differencing consecutive snapshots gives the real per-call cost and token
  counts;
- `Condensation` events list `forgotten_event_ids`, so the exact set of events
  live in the context at every call can be reconstructed.

For each call the measured cost is split across the events actually in its
context, in proportion to their token size (tiktoken `o200k_base`; the absolute
counts differ a few percent from Anthropic's tokeniser, the shares do not).
Every dollar figure below is therefore a share of really-spent money, and the
buckets sum to the real total.

Scripts were throwaway (`/tmp/spend/{fetch,attrib,cache_waste,extra}.py`); the
method above is enough to rebuild them.

## 2. The numbers

Whole project, from the conversation list (all 331 dj-station conversations the
server still holds):

| day | $ | convs | LLM calls | $/call | mean context/call |
|---|---|---|---|---|---|
| 2026-08-26 | 54.51 | 29 | 602 | 0.091 | 112,658 |
| 2026-08-28 | 108.55 | 19 | 1,060 | 0.102 | 135,526 |
| 2026-08-29 | 198.53 | 45 | 1,647 | 0.121 | 128,767 |
| 2026-08-30 | 532.70 | 209 | 5,755 | 0.093 | 108,084 |
| 2026-08-31 | 231.28 | 24 | 1,825 | 0.127 | 138,186 |
| 2026-09-01 | 13.43 | 5 | 148 | 0.091 | 116,822 |
| **total** | **1,139.00** | **331** | **11,037** | **0.103** | — |

The price per call is flat. What varies is **how many calls a ticket takes and
how big the context already is** — every call re-reads 108k–138k tokens on
average.

The 20-conversation sample: **$209.93, 1,692 LLM calls, 238.8 M prompt tokens**.
Six conversations are 96 % of it:

| conv | $ | calls | $/call | condensations |
|---|---|---|---|---|
| 58140037 (Grid page, 10 user asks) | 61.59 | 571 | 0.108 | 8 |
| 07cfed2f (Decks V2) | 53.52 | 180 | 0.297 | 1 |
| a003a386 (clip editor fixes) | 38.54 | 340 | 0.113 | 4 |
| debf7fd4 (deck/clip small changes) | 26.40 | 265 | 0.100 | 3 |
| 220427be (Grid fixes) | 10.74 | 95 | 0.113 | 0 |
| 0c5d66e7 (One offset) | 10.70 | 107 | 0.100 | 0 |
| 14 short conversations | 8.44 | 134 | 0.063 | 0 |

Cost is roughly *calls × context*, and context grows with calls, so a ticket's
total grows about **quadratically** with how long the agent rambles:

| prompt size of the call | calls | mean $/call |
|---|---|---|
| 0–25k | 21 | 0.020 |
| 50–75k | 135 | 0.056 |
| 100–125k | 306 | 0.106 |
| 150–175k | 289 | 0.129 |
| 200–225k | 123 | 0.186 |
| 225–250k | 116 | 0.245 |

Blended price over the sample: **$0.88 per M prompt tokens**. Practical rule:
**1,000 tokens dropped into the context early in a 300-call ticket costs ~$0.26
by the end** — the output of one careless `cat` of a 400-line file costs about
$1.50, not $0.005.

## 3. Where the money actually goes

Real dollars, split across the context each call had to read:

| context source | $ | % |
|---|---|---|
| observations: `cat`/`sed`/`head` file reads | 55.42 | 26.4 % |
| system prompt + tool schemas (fixed ~20k tok/call) | 52.96 | 25.2 % |
| agent's own actions (thoughts + tool-call arguments) | 38.83 | 18.5 % |
| observations: `grep`/`find` | 21.22 | 10.1 % |
| observations: `str_replace` echo-back of edited files | 17.10 | 8.1 % |
| observations: `file_editor view` | 5.58 | 2.7 % |
| user messages (ticket text + follow-ups) | 4.82 | 2.3 % |
| condenser summaries | 4.40 | 2.1 % |
| **observations: vitest / tsc / cargo test / cargo check / clippy** | **3.88** | **1.8 %** |
| observations: git | 1.76 | 0.8 % |
| observations: python/node one-liners | 2.09 | 1.0 % |
| everything else (other file edits, browser, misc shell, agent replies) | 1.87 | 0.9 % |

Same picture per conversation ($ per source):

| conv | $ | cat/sed | grep | edit-echo | sysprompt | agent-acts | cargo+vitest |
|---|---|---|---|---|---|---|---|
| 58140037 | 61.59 | 9.48 | 4.36 | 5.70 | 17.08 | 17.88 | 1.87 |
| 07cfed2f | 53.52 | 19.91 | 6.39 | 6.61 | 8.53 | 9.52 | 0.51 |
| a003a386 | 38.54 | 9.24 | 4.42 | 1.72 | 11.16 | 5.25 | 0.77 |
| debf7fd4 | 26.40 | 8.07 | 4.07 | 1.88 | 7.54 | 3.37 | 0.48 |
| 220427be | 10.74 | 3.98 | 0.65 | 0.83 | 2.01 | 1.43 | 0.06 |
| 0c5d66e7 | 10.70 | 4.39 | 1.31 | 0.35 | 2.71 | 1.21 | 0.15 |

Raw output produced (once), by producing command:

| category | invocations | tokens | avg | biggest |
|---|---|---|---|---|
| file read (cat/sed) | 398 | 420,714 | 1,057 | 8,096 |
| grep/find | 413 | 169,386 | 410 | 10,317 |
| file edit (str_replace) echo | 314 | 147,691 | 470 | 4,636 |
| python/node scripts | 106 | 57,365 | 541 | 6,695 |
| other shell (mostly `vibectl.py snapshot`) | 31 | 50,520 | 1,630 | 9,021 |
| git | 88 | 44,501 | 506 | 3,467 |
| file_editor view | 21 | 37,593 | 1,790 | 5,948 |
| npm/vitest | 123 | 27,902 | 227 | 2,100 |
| tsc / npm build | 60 | 9,197 | 153 | 2,059 |
| cargo test | 21 | 4,600 | 219 | 455 |
| cargo check/clippy/fmt | 9 | 713 | 79 | 295 |

**Test and build output is already cheap** — the existing AGENTS.md discipline
works. Agents pipe vitest through `grep -E "Tests |Test Files|×"`, so a test run
costs ~200 tokens, and cargo is barely used because of the "lean on CI" rule.
Do not spend more effort there.

## 4. Cache behaviour

| | tokens | share |
|---|---|---|
| prompt total | 238,784,422 | |
| cache **read** | 233,872,824 | 97.9 % |
| cache **write** | 4,908,248 | 2.1 % |
| uncached | 3,350 | 0.0 % |
| completion | 1,421,634 | 0.6 % of prompt |

The prompt cache is working: 98 % hit rate, and completions are noise (0.6 %).
There is exactly one pattern that busts it — **condensation**. When the
condenser drops old events the prompt prefix changes, so the whole remaining
context is re-written at the 1.25× write price:

- 21 mid-conversation calls read <60 % of their prompt from cache;
- they are **1.2 % of calls but 7.0 % of all spend ($14.62)**;
- worst single call: 07cfed2f call 46, 202,015 prompt tokens, 0 % cache hit,
  **$2.54 for one call** (25× a normal call);
- 58140037 condensed 8 times, each costing $0.5–$1.1 extra.

Condensation is not a bug — it is triggered by the context getting too big in
the first place. Every condensation is the bill for earlier over-reading.

## 5. Specific waste found

**a) `cat AGENTS.md` is both expensive and broken.** AGENTS.md is 173 KB =
**46,143 tokens**. Terminal output is capped at 30,000 chars and clipped
*middle-out*: the observation keeps the first ~15k chars and the last ~15k chars
with `<response clipped>` in between. So an agent that runs `cat AGENTS.md`
pays ~8,100 tokens (~$1–4 over the ticket) and still never sees ~82 % of the
file — including most of `## Conventions`. Three of the six expensive
conversations did exactly this, then spent more tokens `grep`-ing and
`sed`-ing the same file later: **109 AGENTS.md-touching observations,
103,188 tokens across the 20 conversations** (~5.2k tokens per conversation).

**b) 60 % of all file-read tokens are re-reads.** Of 458k tokens of file-read
output, **277,211 (60 %) came from reading a file that had already been read in
the same conversation** — different line ranges, so the condenser and the cache
cannot help. Worst offenders: a003a386 read `ClipView.test.tsx` 64× and
`ClipView.tsx` 61× (89.7k re-read tokens vs 10.7k of first reads); 58140037 read
`GridView.tsx` 46×, `styles.css` 28×. Byte-identical repeats are only 3,895
tokens, so this is "wander back into the same file", not a literal retry loop.

**c) Whole-file `cat`s of big files.** `cat app/src/components/DecksView.tsx`
(7,323 tok), `cat DecksSlot.tsx DecksClipPicker.tsx beatClip.ts` (7,661 tok),
`cat app/src/decks.ts` (5,380 tok) — in 07cfed2f, which is why that conversation
runs at **$0.297/call, 3× the project average**. The frequently-read files are
huge: `styles.css` 6,404 lines, `decks.rs` 3,138, `ClipView.tsx` 2,303,
`ClipView.test.tsx` 2,236, `GridView.tsx` 1,428.

**d) Unbounded greps.** `grep -rn "Trim to selection\|Clear automation\|Cut
selection" app crates PRD.md README.md` returned **10,317 tokens** — the single
biggest observation in the sample — and hit the output cap. 413 grep
invocations cost $21.22 in carried context.

**e) Giant JSON dumps.** `vibectl.py snapshot` unfiltered is ~9,015 tokens and
hits the output cap; it appears in 6 short manager-ish conversations where it is
roughly a third of the entire context.

**f) Long multi-ask conversations.** 58140037 was one conversation for ten
separate asks. After the first ask finished, every later ask ran at
**127k–168k mean context per call** — e.g. "add zoom in/out on the grid" cost
$0.70 for 6 calls at 142k context each, and the final ask ran 205 calls at
$18.10. A fresh conversation starts at ~22–49k tokens. The stale first-ask
exploration was re-read on every one of those ~400 calls.

**g) Failure loops are NOT a significant cost.** Observations containing error
markers: 46 vitest, 10 cargo test, 8 grep, 5 tsc — 24k tokens total. Retries are
fine here.

**h) The fixed floor is 20k tokens/call.** System prompt (~15.6 KB) + tool
schemas (~49 KB JSON) ride along on every single call: $52.96, 25 % of spend,
and nothing an agent does in the repo changes it. The only lever is **fewer,
bigger steps** — 1,692 calls at ~20k of pure overhead is 34 M tokens (~$30) of
scaffolding.

## 6. Recommendations

Ranked by measured impact.

1. **Never read a whole file over ~200 lines.** `grep -n` for the symbol, then
   `sed -n 'START,ENDp'` a ±60-line window, or `file_editor view` with an
   explicit `view_range`. A whole-file `cat` of a 1,000-line component costs
   ~$1–4 over a long ticket, not nothing.
2. **Never `cat AGENTS.md`.** It is 46k tokens and gets clipped middle-out at
   30k chars, so you pay 8k tokens for a file with its middle missing. Read the
   heading list (`grep -n '^#' AGENTS.md`) and `sed -n` only the sections you
   need.
3. **Read a file once.** Before opening a file, check whether it is already in
   the conversation. If a second look is genuinely needed, re-read the narrow
   range, never the file.
4. **Cap every command's output.** `| head -40` on greps, `-m 20` on
   `grep -rn`, `--stat` before `git diff`, `| grep -E` on test runs, `python3 -c`
   filters instead of dumping JSON. Anything that can produce >200 lines needs a
   cap; anything that hits the 30k-char clip was a mistake.
5. **Scope greps to a directory and a file type** (`grep -rn foo app/src
   --include='*.tsx'`), not to `app crates PRD.md README.md`.
6. **One ticket, one conversation; one conversation, as few calls as possible.**
   Cost is ~quadratic in call count. Batch related shell commands into one
   action, and open a fresh conversation for a genuinely new ask instead of
   piling a tenth follow-up onto a 500-call session.
7. **Keep doing what is already working:** piping test output through
   `grep`/`head`, leaning on CI instead of running full sweeps, scoped
   `cargo`/`vitest` targets. Build/test output is 1.8 % of spend — the test
   discipline section of AGENTS.md has already won that fight.
8. **Repo-level: AGENTS.md needs splitting.** At 46k tokens it can no longer be
   read in one command, which is exactly why agents grep it repeatedly. A short
   root file (discipline + conventions + an index) with the per-page deep-dives
   moved to `reports/`- or `docs/`-style pages would make it cheaply readable
   again. Left as a follow-up: it is a content change, not a spend fix, and this
   ticket is analysis-only.
