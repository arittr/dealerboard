# Problem statement — 2026-08-27-quota-account-staleness

<!-- IMMUTABLE. Written once at kickoff, in the user's words; never edited.
     The ratify gate's cold-read checks the spec against THIS file — not
     against the spec, and not against anyone's memory of the conversation.
     If the problem itself changes, abandon this notebook and start a new one. -->

"Why is the active claude account greyed out" — the strip's Claude quota
group dims the active seat's row when nothing is wrong with it. The dim
currently means "this account's reading is older than three dealerboard
collector passes (6 minutes)", but the per-account timestamp comes from
cswap's own usage probe, whose designed cadence is 3–10 minutes healthy and
up to 30 minutes under 429 backoff — so rows grey out during normal
operation and the user reads a fault where there is none. "I'm confused as
to why we're not getting data for them regularly, like why is it stale."

Done looks like: a dimmed account row means something true and actionable;
readings that are merely on cswap's schedule render normally; genuinely bad
states (dealerboard's collector dead, cswap unable to fetch) remain visibly
distinct.

Hard constraints named at kickoff: cswap is a third-party tool
(realiti4/claude-swap) — its JSON (`cswap list --json`) exposes per-account
`usage`, `usageStatus`, `usageFetchedAt`, `usageAgeSeconds` and no poll
schedule; upstream changes are out of reach for this fix, and reading
cswap's private cache files would couple to undocumented internals.
