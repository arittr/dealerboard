# Problem statement — 2026-08-27-board-paging-peek

<!-- IMMUTABLE. Written once at kickoff, in the user's words; never edited.
     The ratify gate's cold-read checks the spec against THIS file — not
     against the spec, and not against anyone's memory of the conversation.
     If the problem itself changes, abandon this notebook and start a new one. -->

"Swipe to next page doesn't work. In this state it's super unclear what's
going on as most of my sessions are on the next page — and this much blank
space makes it hard to know I should be going to the next page. I think we
have to both reflow, indicate pages/activity on pages you're not on, and
implement the swipe gesture better."

The state in question: the strip's board showed five cards in one column
with the second column empty, while a nine-card orchestrator group sat
whole on page 2 — invisible except for two 0.6vw pager dots in the rail's
bottom corner. Swiping to reach it silently failed.

Done looks like: the swipe gesture works and its failures are visible; a
page you are not on announces its existence, its activity, and its unread
state from the page you are on; and the board does not strand half the
screen blank while sessions overflow to a page you cannot see.
