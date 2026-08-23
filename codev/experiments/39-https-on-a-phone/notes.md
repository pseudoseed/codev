# Experiment 39: HTTPS on a phone via Tailscale, through to one delivered push

**Status**: In Progress · **Date**: 2026-08-23 · **Hostname live**: `ade.pseudoseed.com`. Cloudflare work still off for us. Gate 2 out of scope. Device handoff next.

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
| 1. Trusted HTTPS | **Pass on curl** | `https://ade.pseudoseed.com/` 2026-08-23T04:22:24Z. Issuer `C=US, O=Google Trust Services, CN=WE1`. SAN `pseudoseed.com` and `*.pseudoseed.com`. `ssl_verify_result=0`. Phone Safari "no warning" still needs the device. |
| 1b. Access enforced | **Pass** | Unauthenticated GET `/`, `/sw.js`, `/manifest.webmanifest`, `/vapid-public.json` all **302** to `https://pseudoseed.cloudflareaccess.com/cdn-cgi/access/login/ade.pseudoseed.com?...`. Body is Cloudflare's 302 page, not the PWA. |
| 2. WebSocket through trusted HTTPS | **Out of scope** | Human decision, LAN-only approvals. Not a gap. |
| 3. PWA install | **Not run** | Needs the phone after a hostname exists. |
| 4. Push permission | **Not run** | Needs the installed PWA. |
| 5. Delivered push | **Not run** | Needs the locked device. |

Source: `artifacts/local-probes.json` at `2026-08-22T20:13:32.508Z`. Root: `artifacts/root-probes.json` at `2026-08-22T22:49:31.206Z`.

**Cloudflare episode, then withdrawn.** Tunnel `exp39-ade` was created at 20:00Z. DNS was never created. Architect tore the tunnel down at 20:06Z and forbade recreating it.

**Present state, verified 2026-08-22T20:15:28Z.** `exp39-ade` does not exist. `cloudflared tunnel list` shows only `git` and `vault-k8s`. No `cloudflared` process. Credential `~/.cloudflared/2be5cb2a-a1bb-44fd-bc16-d63a1d4d1e7e.json` is gone. `cloudflared.yml` is gone. `ade.pseudoseed.com` is NXDOMAIN. Do not read any earlier sentence as "the tunnel is up."

## What worked / what didn't

**Worked.** The additive ingress gets a foreign `Host` past Tower without touching Tower or restarting it. A real terminal WebSocket echoes through that rewrite on loopback. PWA files, VAPID, subscribe, and the web-push send path run locally.

**Did not run.** Gate 1 needs a trusted hostname this spike is not allowed to create. Phone gates wait on that.

**Not tried, on purpose.** Setting `CODEV_TOWER_ALLOWED_ORIGINS` on the live Tower. Recreating any Cloudflare tunnel, DNS record, Access app, or identity provider.

## Access cookies, reasoned, not scored

No Access app exists. Nothing below was run. Sources are Cloudflare's authorization-cookie page (updated 2026-08-03) and Apple's Home Screen web-app posts (Feb and Mar 2023).

**What Access puts on the wire.** Every HTTP request to the protected host needs a `CF_Authorization` cookie or Access blocks it. There are two JWTs. One lives on `*.cloudflareaccess.com` (HttpOnly, SameSite None). One lives on the app host. The app-host table says HttpOnly and SameSite are admin choices, default None. A later section on the same page says the HttpOnly toggle is on by default. I did not resolve that contradiction.

**Service worker.** Our `sw.js` has no `fetch` handler. It cannot cache an Access login page and it cannot strip cookies from page or API requests. Registration is a GET of `sw.js`. Access will challenge that GET if the cookie is missing. After login, same-origin SW registration should see the app-host cookie. That is the documented cookie rule applied to a GET. It is not a measured iOS result.

**WebSocket.** A `wss://` upgrade is still an HTTP request. Access will check `CF_Authorization` on it. Same-origin `wss` sends first-party cookies unless SameSite is Strict, which Cloudflare warns causes `ERR_TOO_MANY_REDIRECTS`. Reasoned pass if SameSite stays None or Lax. Not scored.

**Add to Home Screen vs Access login. This is the question the spike is for.**

Apple (Feb 2023): a Home Screen web app "opens like any other app... separate from Safari." Access login is on `*.cloudflareaccess.com`, a different site from the PWA host. The app-host `CF_Authorization` cookie is set after that redirect. The standalone app may or may not see it.

Our SW has no `fetch` handler. If the icon opens a login page, that is Access or WebKit, not a cached document we served.

**What to observe on the device, in order. Write down the letter.**

1. Safari tab to `https://<hostname>/`. Finish Access login. Confirm the PWA page, not the login form. Note the address bar host.
2. Share, Add to Home Screen. Do this while the app page is showing, after login.
3. Swipe Safari away so it is not sitting in the app switcher.
4. Tap the icon. Pick one:
   - **A.** Standalone chrome. App page. No login. Session carried.
   - **B.** Standalone chrome. Cloudflare Access login. Session did not carry. Try to finish the PIN inside the icon. Does it return to the app, bounce to Safari, or loop?
   - **C.** Opens Safari instead of standalone.
   - **D.** Blank, error, or redirect loop.
5. Read the on-page `standalone:` line. Gates 3 to 5 need it `true`.
6. If A or a completed B: Ask notification permission, Subscribe, Send test push, lock the device.

B is the finding that changes FR-36 and FR-16. A means Access and A2HS can live together. Do not guess from a Safari tab.

**Push delivery.** Apple: iOS Web Push uses the Apple Push Notification service. `web-push` posts to the subscription endpoint (`*.push.apple.com` on a real iOS sub), not to our origin. Access never sees that POST. Our local send already left the box toward the subscription URL (`ENOTFOUND exp39.invalid`). Architecture says push delivery does not go through the hostname. A locked-device arrival is still unscored.

## Next steps

**Hostname exists.** `ade.pseudoseed.com` resolves to Cloudflare (`172.67.207.128`, `104.21.45.14`). Access is in front. I did not create this DNS or Access app. I probed it.

I have no Access token. `cloudflared access token` has no login. I cannot see whether the origin is serving `public-root/` until someone logs in.

**Device, now:**

1. Safari to `https://ade.pseudoseed.com/`. Finish Access login. Confirm the PWA page (Experiment 39 root), not a 404 or the nested `/v2/spike/` tree.
2. Share, Add to Home Screen. Swipe Safari away. Tap the icon. Score **A / B / C / D** from the Access section.
3. If A or a completed B: Ask notification permission. Subscribe. Copy the printed JSON off the phone.
4. Lock the device. I send with `node scripts/send-push.mjs <that.json>`. Tell me if it arrived.

When a name is handed over, serve `public-root/` at `/` on that host. Do not ship the `/v2/spike/` tree there. A nested SW scope on a root host fails registration and looks like an iOS bug.

The dedicated host is static. `public-root/` has `vapid-public.json` (public key only). Subscribe prints JSON on the page. Copy it off the phone. Send the push from this machine with that JSON and the private key. The private key does not go in notes, committed artifacts, or messages.

**Device handoff, only after gate 1 passes.** Follow the A/B/C/D list in the Access section. Use `https://<hostname>/`, not `/v2/spike/`. After subscribe, copy the printed JSON. I send the push from here.

Do not use Playwright WebKit. Do not use a Safari tab for permission, subscribe, or the locked-device push.

**Q4.** No verdict yet. The local half is not the question. The question is still which trusted cert sits in front, and this spike is not allowed to put one there.

