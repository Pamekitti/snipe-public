# September 24 stuck-exit incident

Historical operational notes record a position that could not exit after its approval attempts failed. The diagnosis found `intrinsic gas too low`, followed by 20 reverted sells. The recorded reverted-sell gas was 0.000183025800202 ETH. Approval eventually succeeded after the sell-attempt budget was exhausted.

Receipt tracking also retained an earlier sell hash. Later retries inspected stale evidence. The recorded repair added approval gating, allowance confirmation, receipt deduplication, incomplete-receipt retry, and an explicit operator recovery control.

The same investigation found replay entry timing at launch block +20 while important live fills occurred at +28 and +31. Accounting and execution timing had to be investigated separately.

The wallet safety detector used a paired window across both books. Its alert was not proof that the taxed book alone was responsible. The recorded activation preserved operator STOP and the actual wallet state.

## Surviving evidence

This account was reconstructed from retained operational notes. The original incident artifact directory is absent from the inspected source trees. Receipts and the complete incident replay tape are not published here. No fresh reproduction of the incident is claimed.

The retired source and tests retain approval, receipt, uncertain-send, and exit-recovery behavior. Those tests verify their specified cases; they do not recreate every condition of this historical incident.
