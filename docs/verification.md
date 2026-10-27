# Publication preparation checks

This is a local review candidate prepared on 27 October 2026. It has not been pushed, published, or connected to a remote repository.

## Current software checks

| Check | Result |
|---|---|
| V1 Vitest suite | 1,128 tests passed across 92 files |
| V2 Vitest suite | 801 tests passed across 40 files |
| Research Python suite | 353 cases, successful with one skip |
| V1 and V2 TypeScript | Passed |
| Research and demo TypeScript | Passed |
| Historical acquisition-tool syntax | Passed |
| Public ledger derivation | 2,679 V1 rows and 1,693 V2 rows matched their original numerical fields |
| Public input hashes | Checked by the publication checker |
| Relative documentation links | Checked by the publication checker |

The skipped research case requires a local frozen candidate dataset absent from this public edition. Its skip is explicit in the source. Live-chain curve validation was not rerun for publication. The default clone excludes its large historical chain inputs.

The V1 suite creates disposable SQLite sidecars through an old in-memory fixture path. These generated files were removed from the candidate and are ignored by Git.

## Demo checks

The in-app browser verified the September trading view, the final retirement view, and the missing-data fixture. Both book tabs, chart windows, the exits filter, expandable trade details, keyboard expansion, and chart tooltips worked.

Desktop layout was checked at 1,600 CSS pixels. Phone layout was checked at 390 CSS pixels with no page overflow. Long tables remain in their scroll containers. The browser reported no warning or error console entries during the final checks.

The demo loads bundled scripts only. Its content-security policy blocks external origins and all connection APIs. It contains no trading controls. Verification used this restricted policy; it did not require turning off the computer's network adapter.

[Desktop capture](../assets/screenshots/v2-demo-desktop.jpg) and [phone capture](../assets/screenshots/v2-demo-phone.jpg) show new historical reconstructions. They are not original live captures.

## Privacy and preservation

The source tree and compressed fixtures were scanned with Gitleaks. Contract addresses and the reviewed public event topic have narrowly defined false-positive allowances. Plain-text scanning also covered two JavaScript files that the archive detector incorrectly interpreted as compressed data.

A separate private check searched for the two original wallet/provider credentials, the owner identity, and 7,338 known own transaction hashes. None was found in the candidate. Published images were inspected and checked with OCR for direct identifiers. The fresh local Git history was scanned separately.

All 12,519 original working-file members were authenticated, hash-verified, and restored privately. A restored Git mirror passed its full integrity check. All 26 restored SQLite databases passed `quick_check`. Original dependency installations were additionally preserved in an encrypted supplement before removal.

Original evidence and unmodified development history remain private. The public package intentionally omits direct wallet and transaction identifiers. This reduces independent on-chain verifiability and does not promise anonymity against indirect correlation.

## Evidence gaps

- The $1,700 profit screenshot remains unlocated in the inspected material.
- Several full September research datasets and the original incident artifact directory are absent from the inspected trees.
- The complete final production tape and feed overlay are not in the retirement export.
- Public figures do not establish lifetime wallet profit, future returns, or a prospective simulator certificate.

The [availability manifest](../datasets/manifests/research-availability.json), [methodology](../results/methodology.md), and [source reconciliation](source-reconciliation.md) retain these boundaries.
