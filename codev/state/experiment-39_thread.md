# experiment-39 thread

Soft-mode EXPERIMENT for issue #39 (spike: HTTPS on a phone via Tailscale, through to one delivered push). Spawn prompt pointed at the old shipped spec 0039-codev-cli.md. Same number collision as experiment 38.

## Hypothesis

Locked in `codev/experiments/39-https-on-a-phone/notes.md` before any prototype. Five gates from the issue. Part 6 Q4 is in scope.

Environment already checked, not scored: Tailscale is not installed. Tower is up on *:4100 with BRIDGE_MODE. Host allowlist will reject MagicDNS names. Restarting Tower is off the table, so the spike is a new ingress on :4110 that rewrites Host.

## Design

Ingress on 4110. Serve points at the ingress, not at Tower. PWA and push live under `/v2/spike/`. No edits to tower-server.ts or existing tower-routes handlers.

## Execute (local)

Local probes in `artifacts/local-probes.json`:

- Host reject of a fake MagicDNS name: pass (401 vs 200).
- Ingress rewrite: pass.
- Echo WS: pass.
- Throwaway `cat` terminal through the ingress with that fake Host: pass. Session deleted.
- Tower sources untouched.

## Standing instruction (19:45Z)

Do not stop at experiment-complete. Device handoff (steps 3-5) is the only remaining stop.

## Redirect (19:54Z)

Tailscale dropped. Cloudflare Tunnel + Access. Ingress on :4110 stays. New tunnel and hostname only. Do not touch the six existing credential files or the live `git` / `vault-k8s` tunnels. One subdomain level. Name the hostname and wait before any DNS.

## Hold (20:06Z)

Cloudflare work is off, permanently. Architect deleted `exp39-ade`, the process, the credential, and `cloudflared.yml`. Do not recreate. DNS and Cloudflare are GitOps, not ours.

**Gate 1 is blocked on an external GitOps change, not a technical failure.**

## Execute (local, continued)

PNG home-screen icons. `Service-Worker-Allowed: /v2/spike/` on `sw.js`. Local probe now covers PWA assets, VAPID, subscribe, and a web-push send that dies at `ENOTFOUND exp39.invalid`.

Ingress on 127.0.0.1:4110. Tower untouched.

Present state checked 20:15Z: `exp39-ade` is gone. Only `git` and `vault-k8s` in `cloudflared tunnel list`. No process, no credential, no yml, NXDOMAIN.

Access-cookie questions written in notes as reasoned, not scored. SW has no fetch handler. Push send does not go through the origin. A2HS vs Access login is the open one.

Route messages to `architect:uiv2`, not `architect`.

Root-scoped variant added. `public/` and :4110 untouched. `public-root/` + `src/server-root.mjs` on :4111. Chromium registered SW at `http://127.0.0.1:4111/`, subscribed via FCM, server send `ok: true`. Evidence: `artifacts/root-probes.json`.

A2HS vs Access now has an A/B/C/D observe list in notes. That is the question this spike is for.

LAN-only approvals. Gate 2 out of scope by decision, not a gap.

public-root only: echo and push buttons gone. Subscribe prints JSON, no POST. Static `vapid-public.json` is public key only. sw.js untouched. public/ and :4110 untouched.

Re-proved 22:49Z: SW active at `/`, subscribe printed FCM endpoint + keys to the page. `artifacts/root-probes.json`.

Infra owner has the eight root-scoped files and is unblocking a stale branch in their repo. Outside our control. Not a spike finding.

Committing WIP. Then idle until a hostname exists.
