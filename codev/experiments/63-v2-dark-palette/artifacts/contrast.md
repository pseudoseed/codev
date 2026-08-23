# Contrast — designed dark palette

Generated 2026-08-23T21:29:19.286Z

## Designed tokens

| Token | Hex |
|---|---|
| bone | #2A251E |
| chalk | #353027 |
| concrete | #8A8070 |
| ink | #EDE4D4 |
| graphite | #C4B8A4 |
| well | #0A0908 |
| rust | #ED7C48 |
| rustdark | #D26432 |
| ochre | #D9A84C |
| moss | #9AAA86 |

well darker than bone: true (fill contrast 1.31:1 against bone, 1.52:1 against chalk).

The hole is not an AA pairing. Two near-black fills cannot hit 3:1. Distinctness is the well being darker plus the ink/rust edge, which is scored below.

rust chroma 119.3 > ochre 101.2 > moss 25.5: true

| Pairing | Fg | Bg | Ratio | Need | |
|---|---|---|---:|---:|---|
| ink on bone (body) | #EDE4D4 | #2A251E | 12.05:1 | 4.5:1 | pass |
| ink on chalk (header, tickets, plots) | #EDE4D4 | #353027 | 10.38:1 | 4.5:1 | pass |
| graphite on bone (machine meta) | #C4B8A4 | #2A251E | 7.77:1 | 4.5:1 | pass |
| graphite on chalk (ticket body, footer) | #C4B8A4 | #353027 | 6.7:1 | 4.5:1 | pass |
| graphite on chalk, no fade (held time) | #C4B8A4 | #353027 | 6.7:1 | 4.5:1 | pass |
| ink on well (terminal, rail chrome) | #EDE4D4 | #0A0908 | 15.77:1 | 4.5:1 | pass |
| ink/85 on well (terminal body) | #cbc3b5 | #0A0908 | 11.38:1 | 4.5:1 | pass |
| ink/70 on well (GATE QUEUE) | #a9a297 | #0A0908 | 7.87:1 | 4.5:1 | pass |
| ink/65 on well (rail footer) | #9e978d | #0A0908 | 6.88:1 | 4.5:1 | pass |
| rust on bone (footer 3 gates) | #ED7C48 | #2A251E | 5.48:1 | 4.5:1 | pass |
| rust on chalk (GATE stamp) | #ED7C48 | #353027 | 4.73:1 | 4.5:1 | pass |
| rust on chalk large (held 24:07) | #ED7C48 | #353027 | 4.73:1 | 3:1 | pass |
| rust on well (3 waiting, awaiting gate) | #ED7C48 | #0A0908 | 7.18:1 | 4.5:1 | pass |
| ochre on chalk (STUCK?) | #D9A84C | #353027 | 6.02:1 | 4.5:1 | pass |
| ochre on well (terminal warning) | #D9A84C | #0A0908 | 9.15:1 | 4.5:1 | pass |
| moss on bone (online badge) | #9AAA86 | #2A251E | 6.13:1 | 4.5:1 | pass |
| moss on chalk (spark is graphic; badge-on-plot) | #9AAA86 | #353027 | 5.28:1 | 3:1 | pass |
| well on rust (badge glyph, Approve drop) | #0A0908 | #ED7C48 | 7.18:1 | 4.5:1 | pass |
| ink border on bone (plot, workspace) | #EDE4D4 | #2A251E | 12.05:1 | 3:1 | pass |
| ink border on chalk (header, ticket) | #EDE4D4 | #353027 | 10.38:1 | 3:1 | pass |
| concrete on bone (grid, divider) | #8A8070 | #2A251E | 3.91:1 | 3:1 | pass |
| rust border on chalk (needs-attn ticket) | #ED7C48 | #353027 | 4.73:1 | 3:1 | pass |
| ochre border on chalk (stuck row) | #D9A84C | #353027 | 6.02:1 | 3:1 | pass |
| moss on bone (online pip) | #9AAA86 | #2A251E | 6.13:1 | 3:1 | pass |
| ink border of a well on bone (terminal edge) | #EDE4D4 | #2A251E | 12.05:1 | 3:1 | pass |
| rust border of a well on bone (gate terminal) | #ED7C48 | #2A251E | 5.48:1 | 3:1 | pass |

Failed: 0

## Invert control

well vs bone 13.56:1, well darker than bone: false

rust loudest: false (rust 101.6, ochre 104.4, moss 19.8)

Failed pairings: 9
- ink on well (terminal, rail chrome) 1:1 need 4.5:1
- ink/85 on well (terminal body) 1:1 need 4.5:1
- ink/70 on well (GATE QUEUE) 1:1 need 4.5:1
- ink/65 on well (rail footer) 1:1 need 4.5:1
- rust on well (3 waiting, awaiting gate) 1.89:1 need 4.5:1
- ochre on chalk (STUCK?) 4.35:1 need 4.5:1
- ochre on well (terminal warning) 3.39:1 need 4.5:1
- well on rust (badge glyph, Approve drop) 1.89:1 need 4.5:1
- concrete on bone (grid, divider) 1.28:1 need 3:1
