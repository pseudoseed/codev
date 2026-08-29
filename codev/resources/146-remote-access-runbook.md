# Remote access runbook — codev-agent and Tower (Spec 146, Phase 7)

Pairing a device, exposing the service, and tearing both down.

Read the first section before the others. It says what each mechanism actually
guarantees, and every procedure below depends on that being understood rather
than assumed.

## What each boundary is, and is not

Reaching this service is **equivalent to shell access** in every worktree it
serves: the server executes arbitrary agent shell. Treat exposure decisions the
way you would treat handing out an SSH key.

| Mechanism | What it guarantees | What it does not |
|---|---|---|
| Loopback binding | **Reachability.** Only this machine's own processes can send a packet to the port. | Nothing about *who* sent it. Over loopback TCP the peer is not attributable — `remoteAddress` is `127.0.0.1` for a builder, an architect and a browser alike. |
| Machine credential | **Authentication against a remote peer**, and per-machine revocation. A remote peer cannot read `~/.agent-farm`. This is the only credential the `/api/agent/v1/` surface accepts. | Nothing against a local process running as your user. It can read every file this service can. |
| Host key (`~/.agent-farm/local-key`) | That a caller **can read a file on this host**. It guards the rest of Tower: terminals, overview, the dashboard. | Nothing per-device: it is one secret shared by every client, so it cannot revoke one and keep the others. That is why the agent surface does not use it, rather than using it as well. |
| Human-paired session | That an approval carries evidence of **which browser session** performed it. | It is not proof a human typed. See `146-approval-threat-model.md`. |
| Origin rules | That a **page you happen to visit** cannot drive this service with the credentials your browser would attach. | Nothing against a non-browser caller, which is why they are never the only check. |
| Tailnet | **Transport.** Who can route to the host. | It is not an authentication model. A device on your tailnet still has to pair. |

## Pair a new device

Issue a token on the **host** (the Mac or Mac Studio running Tower). There is no
`afx` subcommand for this yet — the operator surface lands with the client phase —
so issue it directly from the store, which is the same code path the server uses:

```bash
node --input-type=module -e "
  const { PairingStore } = await import('@cluesmith/codev/dist/agent-farm/lib/pairing.js');
  const issued = new PairingStore().issue();
  console.log(issued.token);
  console.log('expires', issued.expiresAt);
"
```

That prints a token of the form `<pairingId>.<secret>`, valid for **10 minutes**
and redeemable **once**. Run it in a terminal you are looking at; do not redirect
it to a file. Then on the device, the client exchanges it:

```
POST /api/agent/v1/pairing/redeem
x-codev-pairing-token: <pairingId>.<secret>
{"machine": "ipad"}
```

**No request on this surface needs the host key**, including this one. That is
deliberate, and it is worth being precise about, because "keyless" here does not
mean "unauthenticated".

`~/.agent-farm/local-key` is one shared secret for every client on the host. A
remote device has no way to get it that is not "send the all-or-nothing secret
over the wire", which is the thing pairing exists to replace. So the
`/api/agent/v1/` surface does not use it. It uses the machine credential instead,
which is per device, stored only as a hash, and revocable for one device without
touching any other — every property the shared key cannot express. Requiring both
would add no boundary and would make every procedure below impossible to run.

Redemption is the one route that takes a **pairing token** rather than a
credential, because the device has no credential yet. It is still authenticated:
single-use, ten-minute TTL. Every other route requires a machine credential, and
the privileged ones require a human session on top of it.

The rest of Tower — `/api/terminals`, `/api/overview`, the dashboard — is
unchanged and still requires the host key. Only the agent surface authenticates
itself.

The response carries the machine credential once. The host stores only a hash of
it, so it cannot be recovered later — if the device loses it, issue a new pairing
token and redeem again, which replaces the old credential.

**Handling the token.** It is the one secret a person retypes, so its leak surface
is different in kind from the others:

- Do not pass it as a command-line argument. `argv` is visible in `ps` and lands
  in shell history.
- Do not paste it into a file in a repository.
- Do not paste it into a chat or an issue. Issue a fresh one instead; that costs
  nothing.

The service never logs it. If you write tooling around this flow, use
`redactPairingToken` from `lib/pairing.ts` on any line you log.

## Reach the service from a tailnet

**Do not set `BRIDGE_TOWER_HOST`. Tower stays on loopback.**

That is the whole recipe, and it is worth being blunt about why: Tailscale Serve
runs *on the host* and proxies to `127.0.0.1`, so it already reaches a
loopback-bound Tower. Binding `0.0.0.0` as well opens every interface on the
machine — the LAN, any other network it is attached to — and buys nothing the
proxy was not already doing. It is the exposure this phase exists to prevent, and
an earlier draft of this runbook told you to do it.

The origin allowlist is read by the Tower **process**, so it has to be in the
environment before Tower starts. Exporting it in a shell next to an
already-running Tower changes nothing, and the symptom is a browser that fails at
the preflight while the variable is visibly set — set it first, then start:

```bash
export CODEV_TOWER_ALLOWED_ORIGINS=https://<host>.<tailnet>.ts.net
afx tower stop && afx tower start
```

**That restart kills every running agent session.** There is no reload for this;
the variable is read at boot. Do it when nothing is mid-phase, or accept the cost
knowingly — it is not a step to run casually while builders are working.

Then put the proxy in front of it:

```bash
npx t3 pair --tailscale
tailscale serve --https=443 http://127.0.0.1:4100
```

Tower needs no `BRIDGE_MODE` for this. Confirm the boot log says
`BIND_LOOPBACK_ONLY`, then check the allowlist took effect from a browser-shaped
request rather than from the variable:

```bash
curl -si -H "Origin: https://<host>.<tailnet>.ts.net" \
  https://<host>.<tailnet>.ts.net/api/agent/v1/session | head -1
```

Want `401` with a `MACHINE_CREDENTIAL_REQUIRED` body — the origin was accepted and
the credential is what is missing. A `403` with `ORIGIN_NOT_ALLOWED` means Tower
did not inherit the variable.

### When you actually do need a non-loopback bind

Only when the TLS terminator runs on a **different host** from Tower, so it
cannot reach `127.0.0.1`. Then exposing an interface is an explicit act with two
parts, and **both are required** — the service refuses to start if you do only
one.

```bash
export BRIDGE_MODE=1
export BRIDGE_TOWER_HOST=0.0.0.0     # or the single interface the proxy uses
export CODEV_BRIDGE_TLS=terminated
```

Prefer the specific interface address over `0.0.0.0`; `0.0.0.0` is every
interface, which is almost never what a single proxy needs.

**Understand what this does not give you.** A declared bind is still a plain-HTTP
listener on that interface. Anything that can route to `<interface>:4100` reaches
Tower directly and never passes through the terminator, so "all remote transport
is HTTPS/WSS" is not true of this configuration — it is true of the loopback
recipe above. No check inside Tower can change that; only not binding there can.
If you use this path, put a firewall rule in front of the port, and treat the
declaration as a note to your future self rather than as a control.

If `CODEV_BRIDGE_TLS` is absent or is anything other than `terminated`, Tower
logs `INSECURE_NON_LOOPBACK_BIND_REFUSED` and **exits**. This is a deliberate
change from the previous behaviour, which warned and started anyway.

**What the declaration means.** The process cannot see the proxy in front of it,
so it is not verifying that traffic is encrypted — it is recording that you said
so. What the refusal buys is that an accidental plaintext exposure is impossible
to do silently.

## Tear down

**The Tailscale Serve mapping persists across reboots until you remove it.**
Stopping Tower does not remove it; the mapping stays and starts serving again the
moment something binds that port.

```bash
tailscale serve --https=443 off
tailscale serve status          # expect no mapping for this host
```

Then drop any exposure from the service:

```bash
unset BRIDGE_MODE BRIDGE_TOWER_HOST CODEV_BRIDGE_TLS CODEV_TOWER_ALLOWED_ORIGINS
```

Restart Tower and confirm the log line reads `BIND_LOOPBACK_ONLY`. Check what it
is really listening on, rather than trusting the variables:

```bash
lsof -nP -iTCP:4100 -sTCP:LISTEN   # want 127.0.0.1:4100, not *:4100
```

## Revoke one device

Revocation is per machine and does not disturb any other:

```
DELETE /api/agent/v1/machines/<machine>
x-codev-machine-credential: <an operator machine's credential>
x-codev-human-session: <sessionId>.<credential>
```

Afterwards every request from that machine is refused with
`MACHINE_CREDENTIAL_REVOKED` and HTTP **403** — a distinct answer from
`MACHINE_CREDENTIAL_UNKNOWN` (never paired) and from `CAPABILITY_REVOKED` (an
approval credential, not a machine). The revocation is a tombstone in that
machine's own file; other machines' files are not read or written.

**This call revokes two things**, because they are two stores keyed by the same
machine name and an operator would reasonably assume they are one:

- the machine credential, so that device cannot reach any route; and
- that machine's approval capabilities, so it cannot present a live capability to
  `porch approve` afterwards.

The response reports each separately — `revoked` for the credential,
`approvalCapabilitiesRevoked` for the count of capabilities. Padding in the name
is trimmed, so `"ipad "` and `"ipad"` revoke the same device.

Revoking the device you are calling from works and locks you out; use another
paired machine, or re-pair at the host.

## If you are locked out

Everything above is per-machine and file-backed under `~/.agent-farm`:

- `machines/` — one JSON file per machine, named by a hash of the machine name.
  Deleting one file un-pairs that machine.
- `pairing/tokens.json` — outstanding and spent pairing tokens.
- `approval/` — approval capabilities and nonces (Phase 6).

**One corrupt file under `machines/` locks out every machine.** Verification scans
the directory to find a credential by id, and a file that exists but will not
parse raises `MACHINE_STORE_UNREADABLE` rather than being skipped — so every
request, from every device, answers HTTP **503**. That is the right failure
direction (skipping the file would tell a device "you were never paired", which
is a definite answer this host cannot honestly give), but the blast radius is the
whole service, not one device.

Find the bad file:

```bash
for f in ~/.agent-farm/machines/*.json; do
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$f" >/dev/null 2>&1 \
    || echo "unparseable: $f"
done
```

Move it aside — do not delete it until you know which machine it was; the name is
a hash, so the file is the only record of it. Removing it un-pairs that one
device and restores service for the rest.

Shell access on the host is above all of this, by design. There is no recovery
path that a local process could use and an attacker with the same user could not.
