# Phase 1 iteration 2 rebuttals

## Codex — REQUEST_CHANGES

### Charset and ANSI string-control families were incomplete

**Accepted and fixed.** The earlier sanitizer handled OSC and CSI but its final two-byte expression
was not a complete ECMA-48 escape grammar. It rejected charset selection such as `ESC ( B`, and a
DCS/SOS/PM/APC string could lose only its introducer/terminator while leaving control payload as
fabricated visible evidence.

The sanitizer now processes ANSI in semantic order:

1. OSC strings introduced by 7-bit `ESC ]` or C1 OSC, through their first BEL/ST terminator;
2. DCS, SOS, PM, and APC strings introduced by either 7-bit ESC or C1 forms, through ST, removing
   the complete control payload;
3. CSI sequences in their 7-bit or C1 forms; and
4. general ECMA-48 ESC sequences with zero or more intermediate bytes and a final byte, which
   covers charset designation/reset such as `ESC ( B`.

String/CSI introducers are excluded from the general fallback. An unterminated string therefore
retains its ESC/C1 control and is rejected instead of losing its introducer and exposing its
payload as ordinary text.

New regressions cover `ESC ( B`, an ST-terminated DCS payload, a C1 SOS payload terminated by C1
ST, and an unterminated OSC. The focused gate-request suite passes all 35 tests and the Codev
package typecheck passes.
