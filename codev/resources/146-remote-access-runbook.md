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
| Machine credential | **Authentication against a remote peer**, and per-machine revocation. A remote peer cannot read `~/.agent-farm`. | Nothing against a local process running as your user. It can read every file this service can. |
| Human-paired session | That an approval carries evidence of **which browser session** performed it. | It is not proof a human typed. See `146-approval-threat-model.md`. |
| Origin rules | That a **page you happen to visit** cannot drive this service with the credentials your browser would attach. | Nothing against a non-browser caller, which is why they are never the only check. |
| Tailnet | **Transport.** Who can route to the host. | It is not an authentication model. A device on your tailnet still has to pair. |

## Pair a new device

Issue a token on the **host** (the Mac or Mac Studio running Tower):

```bash
afx pair issue --purpose machine-credential
```

**`--purpose` is required and has no default.** There are two ceremonies and a
token is bound to one: `machine-credential` pairs a device, `client-session` opens
the session that authorizes gate approvals. A token presented at the wrong one is
refused — and, deliberately, not consumed, so it still works at its own.

`--authority <text>` records what authorized the mint, verbatim, and travels to
the session, the capability and `status.yaml`. Omit it and the command records
itself and the invoking account, which claims **no** human presence — nothing
here can verify that, because anything able to write the pairing store can mint a
token.

That prints a token of the form `<pairingId>.<secret>`, valid for **10 minutes**
and redeemable **once**. Run it in a terminal you are looking at; do not redirect
it to a file and do not pass it as an argument to anything — argv is world-readable
through `ps` and lands in shell history.

> This used to say there was no `afx` subcommand and showed a direct
> `new PairingStore().issue()` call. That call now **throws**: `purpose` and
> `authority` are both required. The runbook is the operator surface, so it says
> what an operator runs.

Then on the device, the client exchanges it:

```
POST /api/agent/v1/pairing/redeem
x-codev-pairing-token: <pairingId>.<secret>
{"machine": "ipad"}
```

**No request on this surface needs the host key.** The whole `/api/agent/v1/`
prefix is exempt from Tower's shared local key and authenticates itself instead:
every route requires a per-machine credential, and the approval routes require a
human-paired session on top of it.

That is deliberate, and it is the only arrangement that works. A device being
paired for the first time does not have `~/.agent-farm/local-key`, and sending it
over the wire to admit a device would hand every client an all-or-nothing secret
that cannot be revoked for one machine without rotating it for all — which is the
thing pairing exists to replace. Requiring both meant a device could pair and then
reach nothing.

**Exempt is not unauthenticated.** Redemption is authenticated by the pairing
token: single-use, ten minutes. Every other route is authenticated by the machine
credential. Tower's own routes (`/api/status`, `/api/instances`, everything
outside this prefix) still require the key, and a test asserts that the exemption
did not widen past the surface.

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

```bash
npx t3 pair --tailscale
tailscale serve --https=443 http://127.0.0.1:4100
```

Then add the public origin to the allowlist, so the browser boundary matches the
deployment. **This must be in the environment Tower is started with.** Tower reads
it in its own process; exporting it in your shell after Tower is already running
changes nothing, and the symptom is a browser that gets a CORS failure while the
variable looks correctly set in the terminal you typed it in.

```bash
export CODEV_TOWER_ALLOWED_ORIGINS=https://<host>.<tailnet>.ts.net
afx tower restart          # Tower must be restarted to inherit it
```

Verify against the running process rather than the shell, because those are the
two things that just disagreed:

```bash
# 1. the value Tower actually has
ps eww -p "$(pgrep -f tower-server | head -1)" | tr ' ' '\n' | grep CODEV_TOWER_ALLOWED_ORIGINS

# 2. an allowed origin is reflected, a disallowed one is not
curl -si -X OPTIONS -H "Origin: https://<host>.<tailnet>.ts.net" \
  http://127.0.0.1:4100/api/agent/v1/session | grep -i access-control-allow-origin
curl -si -X OPTIONS -H "Origin: https://evil.example" \
  http://127.0.0.1:4100/api/agent/v1/session | grep -i access-control-allow-origin   # expect nothing
```

Tower needs no `BRIDGE_MODE` for this. Confirm the boot log says
`BIND_LOOPBACK_ONLY`.

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

Revocation is per machine and does not disturb any other.

```bash
afx pair list                 # what is outstanding, and which machines are paired
afx pair revoke <machine>     # withdraw its credential AND its approval capabilities
```

**This is the command to use**, and it works **holding nothing** and with Tower
stopped — which is when you most want it. It writes both stores directly: the
machine credential and that machine's approval capabilities, because revoking
only the first would leave a withdrawn device still able to present a live
capability to `porch approve`.

The HTTP route below is `human-session`, and `human-session` includes
`machine-credential` — so revoking there requires already holding the credential
you are withdrawing. That is why the CLI exists, and the trade it makes is
recorded in `146-approval-threat-model.md` under *Who can revoke, and the trade
that decides it*: an availability trade, not a confidentiality one, stated as a
trade.

> This section used to say **"Today, revoke at the host"** because
> `completePairing` had no production caller and the HTTP route was unreachable
> by a person. Both facts changed: phase 11 added `POST /api/agent/v1/human-sessions`
> as that caller, and spec 236 added `afx pair`. The route is reachable now; it is
> simply not the one to reach for at a terminal.

Revocation is a tombstone: that machine's every request then fails closed with
`MACHINE_CREDENTIAL_REVOKED`, no other machine is touched, and the old secret can
never be revived. Re-pair with `afx pair issue` if it was a mistake.

<details>
<summary><strong>Superseded:</strong> the two <code>node -e</code> one-liners this replaced</summary>

**Do not run these.** They are kept only so an operator who finds them in an
older copy of this runbook, or in their shell history, can see what replaced
them and why. `afx pair revoke <machine>` does both, in one command, holding
nothing.

They are also the reason the CLI exists. The split was the hazard: the first
revokes the machine credential *only*, so an operator who ran it and stopped —
which is what an operator asked to remember two commands eventually does — left
a withdrawn device still able to present a live approval capability to
`porch approve`.

```bash
# SUPERSEDED by: afx pair revoke <machine>
node --input-type=module -e "
  const { MachineCredentialStore } = await import('@cluesmith/codev/dist/agent-farm/lib/machine-credentials.js');
  console.log(new MachineCredentialStore().revoke(process.argv[1]) ? 'revoked' : 'nothing live to revoke');
" -- '<machine>'

# SUPERSEDED — and the half that was forgotten.
node --input-type=module -e "
  const { ApprovalCapabilityStore } = await import('@cluesmith/codev/dist/agent-farm/lib/approval-capability.js');
  console.log('capabilities revoked:', new ApprovalCapabilityStore().revokeMachine(process.argv[1]));
" -- '<machine>'
```

</details>

**The HTTP route, for a client that holds a session.** It does both in one call,
which is why it exists — an operator asked to remember two commands will
eventually run one. No host key: this surface authenticates itself.

**It is not the route to reach for at a terminal.** It is `human-session`, which
includes `machine-credential`, so it requires already holding the kind of
credential you are usually trying to withdraw. Use `afx pair revoke <machine>`
instead (above); this route is for the client, which has a session by the time it
offers you the button.

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
