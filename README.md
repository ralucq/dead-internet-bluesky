# Dead Internet Theory: an analysis of behavior and social connections among Bluesky accounts

Code for a master's thesis. It builds a graded bot-likeness score for Bluesky accounts from profile, posting-behaviour, interaction, text and social-graph signals, tests it against accounts that declare themselves bots (the `bot` self-label) and against ordinary accounts, and offers a small web page that applies it to one account.

- `app/`  the web page (static, runs in the browser, calls only Bluesky's public API). Open it through `node app/serve.mjs`.
- `*.mjs` in this folder: the study scripts (Node 18+, no packages), in the order described in the methods log.
- `data/` is NOT part of this repository. It holds public posts and follower lists of ordinary people. It stays on the author's computer.

The score describes how much an account looks like declared, mostly scheduled feed bots. It cannot see AI-run or fake-person accounts that behave like people. It is a level of evidence, never proof, and must not be used to accuse a person.
