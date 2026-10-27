# From a trading hypothesis to a recorded decision engine

I began with a question: could I recognize a new token launch early enough to trade its initial demand, then leave before that demand disappeared? The venue was Pons on Robinhood Chain. Prices followed bonding curves, and the launch sequence exposed information a bot could observe before making an entry.

## The first hypothesis

V1 screened launches using creator tax, the creator's initial buy, tax-exempt wallets, and deployer history. These were measurable fields. They were also fields a launcher could control.

The [August pilot postmortem](history/POSTMORTEM.md) reported a $35 loss across 22 trades in roughly 90 minutes. A pattern that had looked useful in research had become a recognizable launcher preset. Aggregating several days concealed how badly the newest period had deteriorated.

The lesson was more specific than “markets change.” I needed to ask who controlled each feature, what it cost to imitate, and whether the newest observations still supported the selection rule. The [build brief](history/BUILD_BRIEF.md) and [decision rules](history/DECISIONS.md) preserve those early assumptions and amendments.

## When the dataset was wrong

An August acquisition script enlarged log-query chunks when responses looked small. The RPC could silently cap a response. The resulting export lost part of the newest block range, so the research and bot evaluated different populations.

The amended decision rules record 9,117 missing rows and a mismatch in creator-buy measurements. I corrected the pull and retained the acquisition tools under `research/`. A fast replay was not useful until the input population was complete.

This became a recurring requirement: freeze the inputs, name the cutoff, check coverage, and retain the correction. A chart without those details could tell a convincing story about an incomplete market.

## The profitable period was real feedback

The historical dashboard captures show periods of profitable trading. The early capture in this repository shows +$460.55 over 256 trades in the displayed 24-hour window. Another preserved preview shows +$910.45 over its own window. Those screens used different cutoffs and must not be combined.

The [13 September error profile](../v1/research/SIMULATION_ERROR_PROFILE_20260913.md) gives a more useful comparison. Its matched 900-attempt September 4–7 sample reports +0.551015 ETH actual net cash. Its matched 282-attempt September 8–13 sample reports -0.408750 ETH. Eight additional labels were unreconciled in that study, so the matched total and the all-recorded total differ.

I want both periods visible. A winning screenshot establishes what the interface displayed at one moment. It does not establish the final account result or the persistence of the edge.

The remembered $1,700 profit screenshot has not been located in the inspected project material. I have not recreated it or inferred its dollar value from an ETH balance.

## Guards, recovery, and simulation error

I tested entry filters, exits, market windows, drawdown stops, and recovery thresholds. The [research index](../research/README.md) keeps those experiments and their protocols together. Several candidates looked better under one execution assumption and worse under another.

The [11 September fidelity study](../v1/research/BACKTEST_FIDELITY_FINDINGS_20260911.md) illustrates the problem. The independent account replay produced a net loss close to the actual account, but selected a different set of trades. It matched only 82 of 190 actual entries and added 27 others. Similar aggregate P&L concealed different behavior.

The later error profile found that a small average signed error hid large errors that canceled. The simulator could understate earlier profit and later losses at the same time. These studies remained diagnostic. Passing curve arithmetic checks did not make the strategy forecasts accurate.

## Why I built V2

V1's replay did not record everything the live decision used. In particular, the unconfirmed feed overlay was not on its tape. A replay built from confirmed chain logs could provide an independent opinion, but it could not reproduce a decision made from evidence it never received.

V2 made the recorded event tape the input to a pure decision engine. One appender assigned event order and time. The core returned intents. A separate driver signed and sent transactions. Dashboard projections read the resulting state and history.

That separation answered three practical questions: what evidence did the bot have, which rule refused or admitted the trade, and which effects actually happened? The [architecture document](architecture.md) connects those questions to the code and its dependency tests.

V2 also separated the taxed and untaxed books. Each book had a complete policy rather than a filter followed by shared hidden rules. The dashboard could compare their outcomes while keeping the wallet-wide stop distinct.

## Real execution still found bugs

An event-driven design did not make execution infallible. A September incident involved failed approvals, repeated reverted sells, and receipt tracking that kept looking at an older hash. Timing assumptions also differed between replay and live fills.

The [incident account](incidents/stuck-exit.md) preserves the recorded diagnosis, repair, and evidence limits. It is a historical operational account, not a fresh replay certificate. The available tests exercise approval ordering, uncertain sends, receipt handling, and recovery.

Gas also mattered outside successful trades. A reverted transaction could consume funds while a position ledger still looked unchanged. The code therefore carries gas separately, and the public results keep position deltas distinct from net wallet accounting.

## Provider costs became part of the experiment

I later examined paid RPC usage during quiet or halted periods. The [halted-mode study](../v2/docs/halted-rpc-economy.md) records short production measurements, coverage checks, and projected costs. Its monthly figures were estimates from a short sample, not provider invoices.

The [manual routing notes](../v2/docs/manual-api-mode.md) distinguish implementation checks from activation evidence. A historical test count is evidence about a particular check, not proof that every later configuration ran in production.

## Retirement

I retired Snipe on 25 October 2026. Before the server was removed, the shutdown checks found zero open positions and no in-flight nonce obligations. Wallet recovery material and financial records were preserved privately.

This public edition preserves the engineering experiment. It includes code, research, an interface people can inspect without credentials, and results whose limits remain visible. The original development history and sensitive operational material remain in a private recovery archive.
