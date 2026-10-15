# Intent accuracy: Lumen Telecom

Run `lumen-main` on 974 questions in `questions.jsonl` (sha256 34c0577d3f86...). Created 2026-10-15T14:48:19.623Z.
stealth-01: threshold 0.45, context boost 0.05. gpt-6-luna: reasoning effort low.

## Result

**gpt-6-luna wins (McNemar p = 0.0000, 974 paired questions).**

| Arm | Evaluated | Accuracy (95% CI) | Top-3 (in scope) | Right area | False fallback (in scope) | False answer (out of scope) | Errors | p50 ms | p95 ms | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| stealth-01 | 974 | 58.0% [54.9%, 61.1%] | 84.1% | 84.0% | 0.0% | 34.5% | 0 | 303 | 749 | n/a (set BENCH_PRICE_* in .env.local) |
| gpt-6-luna | 974 | 74.7% [71.9%, 77.4%] | 88.8% | 93.2% | 0.1% | 10.9% | 0 | 3572 | 10430 | n/a (set BENCH_PRICE_* in .env.local) |

Accuracy counts a prediction as correct only when it is the exact expected intent (or "none" for out-of-scope questions). "Right area" counts a prediction under the same top-level business area as correct, so it separates near-duplicate confusion from real misses.

## Paired comparison

Questions answered by both arms: 974. stealth-01 right and gpt-6-luna wrong: 72. gpt-6-luna right and stealth-01 wrong: 235. Exact McNemar p = 0.0000 (two-sided).
Accuracy on those questions: stealth-01 58.0%, gpt-6-luna 74.7%.

## By expected depth

| Depth | stealth-01 n | stealth-01 acc | gpt-6-luna n | gpt-6-luna acc |
| --- | --- | --- | --- | --- |
| depth 1 | 182 | 36.8% | 182 | 6.6% |
| depth 2 | 523 | 63.5% | 523 | 90.6% |
| depth 3 | 150 | 58.7% | 150 | 90.7% |
| out of scope | 119 | 65.5% | 119 | 89.1% |

Depth 3 questions are follow-ups labeled with their parent as the active intent. Depth 3 is not reachable cold.

## By style

| Style | stealth-01 n | stealth-01 acc | gpt-6-luna n | gpt-6-luna acc |
| --- | --- | --- | --- | --- |
| casual | 99 | 59.6% | 99 | 77.8% |
| formal | 97 | 53.6% | 97 | 79.4% |
| fragment | 96 | 55.2% | 96 | 77.1% |
| frustrated | 97 | 59.8% | 97 | 72.2% |
| indirect | 96 | 45.8% | 96 | 69.8% |
| non_native | 98 | 56.1% | 98 | 76.5% |
| question | 98 | 71.4% | 98 | 77.6% |
| rambling | 98 | 58.2% | 98 | 75.5% |
| terse | 96 | 57.3% | 96 | 70.8% |
| typos | 99 | 62.6% | 99 | 70.7% |

## By business area

| Area | stealth-01 n | stealth-01 acc | gpt-6-luna n | gpt-6-luna acc |
| --- | --- | --- | --- | --- |
| (out of scope) | 119 | 65.5% | 119 | 89.1% |
| Account, contract and moving | 60 | 56.7% | 60 | 70.0% |
| Billing and payments | 59 | 61.0% | 59 | 66.1% |
| Business plans | 69 | 65.2% | 69 | 78.3% |
| Devices and accessories | 60 | 46.7% | 60 | 78.3% |
| Home broadband | 61 | 44.3% | 61 | 70.5% |
| Home security and smart home | 56 | 66.1% | 56 | 69.6% |
| Loyalty and promotions | 67 | 56.7% | 67 | 76.1% |
| Mobile postpaid plans | 49 | 42.9% | 49 | 61.2% |
| Network and outages | 65 | 69.2% | 65 | 81.5% |
| Prepaid mobile | 54 | 50.0% | 54 | 70.4% |
| Privacy, safety and accessibility | 64 | 46.9% | 64 | 73.4% |
| Roaming and international | 54 | 55.6% | 54 | 66.7% |
| Stores and support | 68 | 60.3% | 68 | 72.1% |
| TV and streaming | 69 | 69.6% | 69 | 78.3% |

## stealth-01 threshold sweep

Tuned on this same test set, so treat the best point as optimistic. The headline uses the configured threshold.

| Threshold | Accuracy | False fallback (in scope) | Configured |
| --- | --- | --- | --- |
| 0.35 | 53.8% | 0.0% |  |
| 0.40 | 56.1% | 0.0% |  |
| 0.45 | 58.0% | 0.0% | yes |
| 0.50 | 58.8% | 0.4% |  |
| 0.55 | 58.4% | 2.6% |  |
| 0.60 | 57.1% | 8.4% |  |

## Cost and volume

- stealth-01 tokens are estimated from question length (about 4 characters per token).
- LLM tokens: input 40593845 (cached 40542706), output 62574.
- Cost: stealth-01 n/a (set BENCH_PRICE_* in .env.local), gpt-6-luna n/a (set BENCH_PRICE_* in .env.local).

## Caveats

- 174 paired questions were missed by both arms. Read `disagreements.csv` (category "both missed") for likely label noise before you trust a gap of a few points.
- gpt-6-luna wrote the intent catalog and is also a contestant. Haiku wrote the questions from the brief and intent descriptions only, never the examples or replies.
- Questions are synthetic. Treat results as a proxy for real customer traffic.
- Coverage: stealth-01 974/974, gpt-6-luna 974/974. Rerun `bench:run` with the same `--run` id to finish missing rows.
