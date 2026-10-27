# Public data and availability

The sanitized ledger exports under `samples/` retain all surviving numerical rows for their stated scope. “Samples” refers to a limited export of the original runtime state, not a random subset of those rows.

| Material | Availability | Reproducibility |
|---|---|---|
| V1 retirement position ledger | 2,679 sanitized rows, including 2,551 live rows | Public tables rebuild offline |
| V2 retirement closed-position ledger | 1,693 sanitized records | Position-return tables and display history rebuild offline |
| Final retirement report | Sanitized point-in-time values | Its published values can be inspected; no fresh chain proof |
| Public test fixtures | Included; owner identities pseudonymized | Software tests run offline |
| August validation inputs | Preserved privately, excluded from Git | Acquisition tools retained; default clone lacks these inputs |
| Several September audit datasets | Surviving local data preserved privately | Partial; see the availability manifest |
| September 14 focused-grid source directories | Not found in the inspected local trees | Documentation-only until originals are located |
| Full final production tape and raw feed | Not included in the retirement archive | Full retired-run replay unavailable from this clone |
| Original credentials and wallet recovery material | Private only | Never required by the demo |

See [historical study availability](manifests/research-availability.json) for the document and surviving-input inventory. A missing input is not evidence of a zero result. Data acquisition commands may use external providers and should not run as part of an offline review.
