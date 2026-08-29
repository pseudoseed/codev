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

## Expose the service to a tailnet

Loopback is the default and needs no configuration. Exposing an interface is an
explicit act with two parts, and **both are required** — the service refuses to
start if you do only one.

1. Put a TLS terminator in front. With Tailscale:

   ```bash
   npx t3 pair --tailscale
   tailscale serve --https=443 http://127.0.0.1:4100
   ```

2. Declare it, and set the bind:

   ```bash
   export BRIDGE_MODE=1
   export BRIDGE_TOWER_HOST=0.0.0.0
   export CODEV_BRIDGE_TLS=terminated
   ```

If `CODEV_BRIDGE_TLS` is absent or is anything other than `terminated`, Tower
logs `INSECURE_NON_LOOPBACK_BIND_REFUSED` and **exits**. This is a deliberate
change from the previous behaviour, which warned and started anyway.

**What the declaration means.** The process cannot see the proxy in front of it,
so it is not verifying that traffic is encrypted — it is recording that you said
so. What the refusal buys is that an accidental plaintext exposure is impossible
to do silently.

Add the public origin to the allowlist so the browser boundary matches the
deployment:

```bash
export CODEV_TOWER_ALLOWED_ORIGINS=https://<host>.<tailnet>.ts.net
```

## Tear down

**The Tailscale Serve mapping persists across reboots until you remove it.**
Stopping Tower does not remove it; the mapping stays and starts serving again the
moment something binds that port.

```bash
tailscale serve --https=443 off
tailscale serve status          # expect no mapping for this host
```

Then drop the exposure from the service:

```bash
unset BRIDGE_MODE BRIDGE_TOWER_HOST CODEV_BRIDGE_TLS CODEV_TOWER_ALLOWED_ORIGINS
```

Restart Tower and confirm the log line reads `BIND_LOOPBACK_ONLY`.

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

Revoking the device you are calling from works and locks you out; use another
paired machine, or re-pair at the host.

## If you are locked out

Everything above is per-machine and file-backed under `~/.agent-farm`:

- `machines/` — one JSON file per machine, named by a hash of the machine name.
  Deleting one file un-pairs that machine.
- `pairing/tokens.json` — outstanding and spent pairing tokens.
- `approval/` — approval capabilities and nonces (Phase 6).

Shell access on the host is above all of this, by design. There is no recovery
path that a local process could use and an attacker with the same user could not.
