# Problem statement — 2026-08-27-board-card-retention

<!-- IMMUTABLE. Written once at kickoff, in the user's words; never edited.
     The ratify gate's cold-read checks the spec against THIS file — not
     against the spec, and not against anyone's memory of the conversation.
     If the problem itself changes, abandon this notebook and start a new one. -->

"we need to completely audit the rules for stuff disappearing from the
board. the read/done state many parent/orchestration agents stick with
means that stuff just gets cleared when i look at it. at this point i'm
wondering if stuff should persist until swipe/manually
cleared/archived/done-for-over-24h but never in a done/read state"

"the read/done state many parent/orchestration agents stick with" —
orchestrated (Paseo subagent) work leaves no trace on the board the moment
it finishes, and parent agents consuming their children's results in Paseo
clears those results off the board within seconds. Tap-to-open a finished
card is itself the dismissal, so reviewing a result removes it.

"idk what about coming back after the weekend" — a flat 24h expiry would
wipe Friday's unviewed results before Monday morning; the clock must not
run while results sit unviewed.

Done looks like: nothing leaves the board by being seen or by finishing; a
card leaves only through an explicit act (swipe, manual clear, Paseo
archive) or a clock that started after the user actually viewed it.
Orchestrated subagent results surface at the parent's card without adding
cards to the board.

Hard constraints named at kickoff: the Stream Deck plugin codebase is out
of scope — "long press dismisses but we also don't have to work on that
codebase at all"; its current press behavior must keep working unchanged.
