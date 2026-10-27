# Historical validation data

`v1/scripts/validate.ts` depends on three ignored files:

- `data/v2_launches.json`
- `data/trades.jsonl.gz`
- `data/buybacks.json`

The tracked links `v2_launches.json`, `anchors.json`, `states.json`, and
`buybacks.json` point into `data/` for the retained historical scripts.

The datasets are local, regenerable chain exports. They are excluded from Git because they
are large. Do not delete the three validator inputs unless they have been copied elsewhere
and `npm run validate` has been updated deliberately.

The acquisition scripts in this directory document how the exports were produced.
`pull_more.mjs` contains the response-cap correction found on 18 August 2026. Current
strategy research must use frozen exports under `v1/data/`, not these August datasets.
