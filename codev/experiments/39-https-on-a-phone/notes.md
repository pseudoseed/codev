# Experiment 39: HTTPS on a phone via Tailscale, through to one delivered push

**Status**: Complete · **Date**: 2026-08-23 · **Host**: `ade.pseudoseed.com`

**Headline.** Cloudflare Access does not break Add to Home Screen or service worker registration on the device we used. Outcome **A**. The Access session carried into the standalone PWA even though every path, including `/sw.js`, is challenged when unauthenticated. **B** would have forced a rewrite of FR-36. It did not happen. One device, one iOS version. Not a general guarantee.

Spawn prompt named `codev/specs/0039-codev-cli.md` (already shipped). Issue #39 and porch project `39-spike-v2-ui-https-on-a-phone-v` are the work. Same template-fill collision as experiment 38.

## Goal

**Question.** Can the FRD's mobile path be walked end to end: Tailscale Serve puts Tower behind trusted HTTPS, a terminal WebSocket survives the proxy, iOS Add to Home Screen gives a PWA, push permission is granted, and one notification lands on a locked device? If step 1 fails, is Tailscale a hard MUST for v1 (Part 6 Q4), or is there another path that gives iOS a certificate it trusts without a manually installed profile?

**Hypothesis, locked before any prototype.**

1. Tailscale Serve can terminate TLS in front of loopback Tower and present a MagicDNS name whose Let's Encrypt cert iOS Safari trusts with zero device configuration.
2. A real Tower terminal WebSocket (`/ws/terminal/:id`) attaches through that HTTPS URL and echoes. Mixed content does not break it (`wss://` over the same name).
3. Tower's Host allowlist will reject a MagicDNS `Host` header. Direct Serve-to-:4100 therefore fails unless something additive rewrites Host or sets `CODEV_TOWER_ALLOWED_ORIGINS`. That is a config/ingress problem, not a reason to edit `tower-server.ts` or existing `tower-routes.ts` handlers.
4. Add to Home Screen on iOS Safari 16.4+ gives standalone chrome. Web Push permission is grantable only from that installed PWA, not from a Safari tab.
5. One Web Push notification can be delivered to a locked device from a fork-owned module. No edit to `broadcastNotification` or existing SSE handlers.

**Success.** All of these, scored against this list, not against whatever the run produces:

- Each of the five issue gates is marked pass or fail with evidence (command output, response headers, screenshot note, or a written "not run because X").
- A working configuration is reproducible from these notes alone.
- Experiment code lives under `codev/experiments/39-https-on-a-phone/`. `git diff --stat -- packages/codev/src/agent-farm/servers/tower-server.ts packages/codev/src/agent-farm/servers/tower-routes.ts` is empty.
- Part 6 Q4 gets a verdict: Tailscale is a hard MUST, or another path is named with the same evidence bar.

**Failure of the hypothesis.**

- Serve cannot obtain a cert iOS trusts, and no other path can either. The mobile half of the FRD is fiction.
- WebSocket upgrade dies through the proxy (Host, subprotocol, or Serve's upgrade handling).
- PWA install or push permission fails on a real device in a way that is structural, not a setup miss.
- Push never arrives on a locked device (iOS suspension, APNs, or Web Push limits).
- The Host/auth problem cannot be solved additively.

**Not a failure.** Tailscale is not installed on this machine at the start of the run. That is an environment gap. The notes must say so and stop at the first gate that cannot proceed, not paper over it.

## Approach

A v2-owned ingress listens on port 4110. Tailscale Serve (when available) points at that port, not at Tower. The ingress:

- Serves the spike PWA under `/v2/spike/`.
- Proxies everything else to `127.0.0.1:4100` with `Host` rewritten to `localhost:4100`. The live Tower key is not committed; the process reads `~/.agent-farm/local-key` at runtime.
- Offers a spike echo WebSocket at `/v2/spike/echo` so Serve+WS can be proven even if a terminal attach is refused.

**Why not Serve straight at 4100.** `isAllowedHost` in `packages/codev/src/agent-farm/utils/server-utils.ts:252` allows loopback, configured `CODEV_TOWER_ALLOWED_ORIGINS` hosts, and (in `BRIDGE_MODE`) IP literals. A MagicDNS name matches none of those. Setting the env var would require restarting Tower. Restarting Tower is forbidden without explicit human permission. Host rewrite in a new process is the additive seam.

**Why not edit Tower.** Part 0: v2 owns new files. This spike is a new process under the experiment directory. Production mount would later be a `v2-*.ts` module plus one `/v2/` block. Not this PR.

**Why not Funnel.** Funnel is the public internet. Serve is tailnet-only. FR-36 wants an explicit opt-in, not a public hole.

**Alternatives considered for Q4.**

| Path | Trusted cert on iOS without a profile? | Why it is or is not a substitute |
|---|---|---|
| Tailscale Serve | Yes, if MagicDNS + Let's Encrypt works | The FRD's stated answer |
| Plain `http://10.10.20.190:4100` | No. Not a secure context | Costs SW, Web Push, installability |
| mkcert / self-signed | No. Needs a profile + trust toggle per device | FRD already rejected this |
| codevos.ai cloud tunnel | Maybe. Not connected on this machine at start | Different product surface; still not LAN-from-the-sofa |
| Caddy + public DNS + Let's Encrypt | Yes, if a public name exists | Outward-facing, not on the tailnet, not this spike |

**Measurements.**

| Gate | Pass |
|---|---|
| 1. Serve HTTPS | `curl -vI https://<magicdns>/v2/spike/` shows a publicly trusted cert. Phone Safari loads it without a warning. |
| 2. WebSocket | A throwaway `cat` session attached at `wss://<magicdns>/ws/terminal/<id>` echoes a known string. Localhost through the ingress is a weaker preview, not a substitute. |
| 3. PWA install | Human confirms standalone chrome after Add to Home Screen. Playwright WebKit does not count. |
| 4. Push permission | `Notification.permission === "granted"` inside the installed PWA. |
| 5. Delivered push | Human confirms one notification on a locked device, from a server-side send logged in `artifacts/`. |

Gates 1 and 2 the builder can do alone once Tailscale is installed and logged in. Gates 3 to 5 need the physical device. Stop and wait at the first fail, and at the device handoff.

## Decision: LAN-only approvals (2026-08-22)

Human decision. Notifications may reach the device anywhere. Reading the terminal and approving requires the LAN. **Gate 2 is out of scope.** That is a decision, not a gap. A remote `wss://` attach is no longer something this spike scores.

The dedicated hostname serves only the root-scoped PWA as static files. No subscribe or push API on that origin. The page prints the subscription JSON. A push is sent later with `curl` from this machine using that JSON and the VAPID private key, which never leaves this machine.

## Redirect addendum (locked 2026-08-22)

Human dropped Tailscale. A hostname was approved, then a tunnel was created, then that whole path was withdrawn.

**Cloudflare work is off for this spike, permanently.** Architect deleted tunnel `exp39-ade`, killed its process, removed its credential, and deleted `cloudflared.yml`. Do not recreate any of it. DNS and Cloudflare in this estate are GitOps, owned by a different architect. Hold all external-hostname work until that owner says a hostname exists.

**Gate 1 is blocked on that external GitOps change, not on a technical failure.** The :4110 ingress, Host rewrite, local WebSocket, PWA files, service worker, VAPID, and push send path all work on loopback. What is missing is a trusted name in front of them.

**New question, locked before the tunnel exists.** What is the cheapest source of a certificate iOS trusts with zero device configuration, and what auth layer sits in front of it? Specifically:

- Cloudflare Tunnel + Universal SSL on a one-level hostname issues a publicly trusted cert.
- Cloudflare Access challenges unauthenticated requests. They never reach Tower.
- After login, `CF_Authorization` survives service worker registration and Add to Home Screen, or it does not.
- `wss://` upgrades pass Access once the cookie is present.
- Web Push delivery does not go through the tunnel.

**Revised gates.**

| Gate | Pass |
|---|---|
| 1. Tunnel HTTPS | `curl -vI https://ade.pseudoseed.com/v2/spike/` shows a publicly trusted Cloudflare cert. Issuer recorded, not assumed. |
| 1b. Access enforced | Unauthenticated request is challenged. Not proxied to the ingress. |
| 2. WebSocket | Throwaway `cat` echoes over `wss://ade.pseudoseed.com/ws/terminal/<id>` through the tunnel, authenticated. |
| 3–5 | Unchanged. Phone required. Access session must still be intact at install. |

Those Cloudflare-specific gates were withdrawn with the tunnel. They stay here as what was asked that afternoon, not as work still to do. Gate 1 is now: a trusted hostname exists in front of :4110. That hostname is a GitOps change.

## Environment and reproduction

Machine at start of run (verified, 2026-08-22):

- Tower PID 2964 listening on `*:4100` (`BRIDGE_MODE=1`, `BRIDGE_TOWER_HOST=0.0.0.0`). Do not restart it.
- LAN `10.10.20.190`. `http://10.10.20.190:4100/` returns 200. `GET /api/health` returns 401 without the key.
- `tailscale` is not on PATH. `/Applications/Tailscale.app` is absent. Homebrew cask is absent.
- Local key exists at `~/.agent-farm/local-key`. Never commit it.

Local ingress (no Tailscale):

```bash
node codev/experiments/39-https-on-a-phone/src/server.mjs
node codev/experiments/39-https-on-a-phone/scripts/probe-local.mjs
node codev/experiments/39-https-on-a-phone/src/server-root.mjs
node codev/experiments/39-https-on-a-phone/scripts/probe-root.mjs
```

Do not start `cloudflared`. Do not create DNS. Do not create Access. Local only until a hostname is handed over.

Untouched check:

```bash
git diff --stat -- packages/codev/src/agent-farm/servers/tower-server.ts packages/codev/src/agent-farm/servers/tower-routes.ts
```

## Code

| File | What it is |
|---|---|
| `src/server.mjs` | Ingress on 127.0.0.1:4110. PWA + push under `/v2/spike/`. Everything else proxied to Tower with `Host` rewritten to `localhost:4100`. Unchanged. |
| `public/` | Nested PWA. Still what :4110 serves. Do not delete. |
| `src/server-root.mjs` | Dedicated-host preview on 127.0.0.1:4111. Serves `public-root/` at `/`. No Tower proxy. |
| `public-root/` | Root-scoped PWA for the GitOps hostname. `start_url` `/`, `scope` `/`, SW `/sw.js` scope `/`, `notificationclick` opens `/`. |
| `scripts/probe-local.mjs` | Nested variant on :4110. |
| `scripts/probe-root.mjs` | Root variant on :4111. SW register + subscribe print. Writes `artifacts/root-probes.json`. |
| `scripts/send-push.mjs` | Reads a subscription JSON and `artifacts/vapid.json`. Sends one push. Private key stays in the untracked vapid file. |
| `artifacts/local-probes.json` | Nested local evidence. |
| `artifacts/root-probes.json` | Root local evidence. |

VAPID private key and push subscriptions stay untracked.

## Results

Local preview ran. Gate 1 did not. Criteria were not rewritten after the run.

| Gate | Result | Evidence |
|---|---|---|
| Host reject MagicDNS (hypothesis 3) | **Pass** | `GET /health` Host `localhost:4100` → 200. Host `chris-mac.tailnet.ts.net` → 401 Unauthorized. |
| Ingress Host rewrite | **Pass** | Same fake MagicDNS Host through :4110 → spike 200 and `/health` 200. |
| Local echo WS | **Pass** | `/v2/spike/echo` returned `exp-39-ping`. |
| Local terminal WS through ingress | **Pass** | Created `cat` session `20785f92-4152-450b-8b12-bf54501f8191` via the ingress. Sent `exp-39-terminal-ping`. Got it back as a 0x01 data frame (twice: PTY echo + cat). Deleted after. `git diff` on `tower-server.ts` and `tower-routes.ts` empty. |
| PWA assets on :4110 | **Pass** | HTML, manifest, `sw.js` with `Service-Worker-Allowed: /v2/spike/`, `app.js`, `icon-180.png`, `icon-192.png`. All 200 with the expected types. |
| VAPID | **Pass** | `GET /v2/spike/vapid-public.json` 200. Public key 87 chars, 65 uncompressed bytes starting `0x04`. |
| Subscribe + push send (:4110) | **Pass** | `POST /v2/spike/subscribe` 200. Fake-endpoint send died at `ENOTFOUND exp39.invalid`. |
| Root PWA assets on :4111 | **Pass** | `/`, `/manifest.webmanifest` (`scope` `/`), `/sw.js` with `Service-Worker-Allowed: /`, `/app.js`, both PNGs. |
| Root SW register in Chromium | **Pass** | Scope `http://127.0.0.1:4111/`, `active: true`. |
| Root subscribe prints JSON | **Pass** | Click Subscribe. Page log contains a subscription with endpoint host `fcm.googleapis.com` and p256dh/auth keys. No `POST /subscribe`. Public key only, 87 chars. This is Chromium/FCM, not iOS. |
| 1. Trusted HTTPS | **Pass** | Issuer `C=US, O=Google Trust Services, CN=WE1`. SAN `pseudoseed.com` and `*.pseudoseed.com`. `ssl_verify_result=0`. Human: no warning on the device. |
| 1b. Access enforced | **Pass** | Unauthenticated GET of every path, including `/sw.js`, **302** to `pseudoseed.cloudflareaccess.com`. Not the PWA. |
| 2. WebSocket through trusted HTTPS | **Out of scope** | Human decision, LAN-only approvals. Not a gap. |
| 3. PWA install | **Pass** | `standalone` true, `secureContext` true, service worker registered at `https://ade.pseudoseed.com/`. |
| 4. Push permission | **Pass** | Permission granted inside the installed PWA. |
| 5. Delivered push | **Pass** | Subscription against `web.push.apple.com`. First send 403 BadJwtToken. Second send 201 after VAPID subject change. Human confirmed the notification arrived. |

Source: `artifacts/local-probes.json` at `2026-08-22T20:13:32.508Z`. Root: `artifacts/root-probes.json` at `2026-08-22T22:49:31.206Z`.

**Cloudflare episode, then withdrawn.** Tunnel `exp39-ade` was created at 20:00Z. DNS was never created. Architect tore the tunnel down at 20:06Z and forbade recreating it.

**Present state, verified 2026-08-22T20:15:28Z.** `exp39-ade` does not exist. `cloudflared tunnel list` shows only `git` and `vault-k8s`. No `cloudflared` process. Credential `~/.cloudflared/2be5cb2a-a1bb-44fd-bc16-d63a1d4d1e7e.json` is gone. `cloudflared.yml` is gone. `ade.pseudoseed.com` is NXDOMAIN. Do not read any earlier sentence as "the tunnel is up."

## What worked / what didn't

**Worked.** Additive Host rewrite on :4110. Root-scoped static PWA on a dedicated hostname. Access in front. A2HS + SW + push on one iOS device. Push itself never hit the origin.

**Did not run.** Gate 2, by decision.

**Failed once, then fixed.** First APNs send 403 `BadJwtToken`. Cause below.

## Finding: Access and Add to Home Screen (outcome A)

On this device, Cloudflare Access did not break Add to Home Screen or service worker registration.

Unauthenticated every path, including `/sw.js`, 302s to `pseudoseed.cloudflareaccess.com`. After login, the standalone PWA opened the app page. Session carried. `standalone` true. SW registered at `https://ade.pseudoseed.com/`. Permission granted inside that PWA. Push arrived.

**B** was the outcome that would have forced FR-36 to be rewritten. It did not happen.

Caveat: one device, one iOS version. Not a general guarantee.

## Finding: VAPID subject cannot be localhost

First push to `web.push.apple.com` failed with **403 BadJwtToken**. `vapid.json` had `subject: mailto:exp39@localhost`. Apple rejects a VAPID subject on a non-real domain. The error names nothing useful.

Changing the subject to `https://ade.pseudoseed.com` made the same keys and the same subscription send **201**. Keys and subscription were unchanged.

**Requirement.** The VAPID subject must be a real `https` origin or a real `mailto`. Never localhost. This would have bitten in production.

`artifacts/vapid.json` subject is now `https://ade.pseudoseed.com`. That file is not committed. Server defaults that create a new file use the same subject.

## Access cookies, now scored on one device

The reasoned section above was written before the device run. Outcome **A** is the score. SW still has no `fetch` handler. Push still goes device-to-APNs, not through Access.

iOS would not let the human select text out of a `<pre>`. `public-root/` log is now a readonly textarea with a Copy log button. Not yet deployed to the origin.

## Conclusions

**Q4.** Tailscale is not a hard MUST. A one-level hostname on Cloudflare Universal SSL (issuer Google Trust Services WE1, SAN `*.pseudoseed.com`) is a cert iOS trusted with zero device configuration. Cloudflare Access is the auth layer in front of it. Notifications can land off-LAN. Reading the terminal and approving stays LAN-only, by decision.

Tower sources were not edited. `git diff` on `tower-server.ts` and `tower-routes.ts` stayed empty.

**Next.** Production mount is a later spec. This spike is done.

