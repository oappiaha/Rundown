# AI timeout diagnosis and real-story evaluation

Preserve the existing UI, 30-second provider timeout, 90-second analysis lease,
zero SDK retries, source data and pending push. Sole checkout owner; no commit or
push authorized. Existing handoff/NEXT-STEPS edits are preserved.

Baseline real HTTP experiment: loopback provider disconnect failed in 0.01s;
a 31s delayed response failed in 30.02s. Both previously returned the same error.
This reproduces the diagnostic ambiguity, not the cause of the historical live
failure. Add safe phase/elapsed/run-ID diagnostics, no provider secrets or input.

Acceptance: real HTTP success/disconnect/delay cases, exact-ID recovery without
another call, mismatched-ID409, daily cap429, unchanged source/live state, focused
regression tests and repository checks. Evidence and owned runtime lease:
/private/tmp/deez/rundown-timeout-20260924/state.md.

Recreate a public-only nine-video sample plus manual duplicate and freeze the
rubric and bounded input before requesting permission for one billed attempt.
No persistent AI enablement, no automatic retry, no timeout increase on conjecture.
