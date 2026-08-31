# Spec 250, criterion 6 — the iPad acceptance run

**What this proves.** That the tree, the gate and the approval are reached from an iPad over the
tailnet, with no account and no cloud relay, and that a builder is driven to completion from it.

**It closes one of two ways and never a third.** Either the run happens and criterion 6 is met, or
no iPad is available and it closes **UNMET with this runbook attached**. It does not close as
passed on a simulation, and it does not stay open. (Ruled 2026-08-31.)

Everything below is a thing to type or a thing to tap. Where a step can fail in a way that looks
like success, the step says so.

---

## Before the iPad is picked up

These run on the Mac. Each ends in something to check, not just something to run.

### 1. Put the WEB dev server on the tailnet, not on loopback

**`HOST`, not `T3CODE_HOST`.** Verified against `apps/web/vite.config.ts:30-31`: Vite reads
`process.env.HOST` and falls back to `localhost`. `T3CODE_HOST` is the *backend's* bind address
(port 3811) and should stay loopback — the iPad talks to Vite, and Vite proxies `/api` to the
backend on the Mac.

```bash
export PATH=$HOME/.nvm/versions/node/v22.22.2/bin:$PATH
cd /Users/chris/dev/t3code-codev/apps/web
T3CODE_SINGLE_ORIGIN_DEV=1 \
  T3CODE_PORT=3811 \
  PORT=5733 \
  HOST=0.0.0.0 \
  T3CODE_CODEV_AGENT_ORIGINS="local=http://127.0.0.1:4100" \
  npx vp dev
```

Get the Mac's tailnet name with `tailscale status --json | jq -r .Self.DNSName` (drop the trailing
dot).

**No allowlist entry is needed for a tailnet name.** `vite.config.ts:152` already carries
`allowedHosts: [".ts.net", ...]` — tailnet DNS is controlled by tailscale, so it cannot be rebound.
A LAN IP or an ngrok name would need `T3CODE_DEV_ALLOWED_HOSTS` (note **`_HOSTS`**;
`T3CODE_DEV_ALLOWED_ORIGINS` is the backend's CORS list and is a different thing).

**Check, from the Mac:** `curl -s -o /dev/null -w '%{http_code}\n' http://<mac>.<tailnet>.ts.net:5733`
prints `200`. A `000` means it bound to loopback only, and the iPad will show a blank page with no
error worth reading — which is why this is checked here rather than discovered there.

### 2. Confirm the server actually read the proxy's upstream

`T3CODE_CODEV_AGENT_ORIGINS` is in step 1's command because the backend reads it from its **own
environment at start**. Setting it afterwards does nothing, and the symptom is an empty picker
rather than an error.

Loopback (`127.0.0.1:4100`) is correct: the proxy hop is Mac-to-Mac. **The iPad never talks to
`codev-agent`** — that is the whole point of the same-origin proxy.

**Check:** with a t3code session in a desktop browser, open
`http://<mac>.<tailnet>.ts.net:5733/api/codev/agent-targets`. It must answer
`{"targets":[{"id":"local"}], ...}`.

If it answers `{"signal":"CODEV_AGENTS_UNCONFIGURED", ...}`, the variable was not in the server's
environment. **That is the failure this check exists to catch** — the page's picker would be empty
and would read as a broken feature rather than an unconfigured one.

### 3. Mint the two tokens the iPad will need

They are different secrets with different purposes, and one does not substitute for the other.

```bash
afx pair issue --purpose machine-credential --ttl-minutes 30   # step 11 on the iPad
afx pair issue --purpose client-session     --ttl-minutes 30   # step 13 on the iPad
```

`--purpose` is required and has no default, and a token minted for one ceremony is refused at the
other — so a wrong guess fails later and elsewhere.

**The default TTL is 10 minutes and the maximum is 60.** Ten is tight for a token typed on an iPad
keyboard, which is why `--ttl-minutes 30` is written out here rather than left to the default.
Mint them when the iPad is in hand.

Both are single-use. Write them somewhere you can retype from — they are transcribed by a human,
which is the whole reason the token field on the form is not masked.

### 4. Have a real builder at a real gate

Criterion 6 says "driven to completion", so this must be a live builder, not a fixture.

```bash
porch status <id>          # confirm it is at a gate a human owns
```

Note the project id and the gate name. You will read both back on the iPad.

---

## On the iPad

Safari. No app, no account, no cloud relay.

| # | Do this | You should see | If not |
|---|---|---|---|
| 5 | Open `http://<mac>.<tailnet>.ts.net:5733` | t3code's pairing screen, "Enter a pairing token to start a session" | A blank page means step 1 bound to loopback. A timeout means the iPad is not on the tailnet — check `tailscale status` on the Mac lists the iPad |
| 6 | Paste the t3code pairing credential — `POST /api/auth/pairing-token` on the Mac with your bearer, or open the `/pair#token=<credential>` URL directly | The app loads with the sidebar | Landing back on the pairing form means the credential was already spent — mint another |
| 7 | Tap the sidebar toggle if the sidebar is off-canvas | **The tree: workspace → architect → its builders**, indented, with `Architect` captions | A flat list means `hasCodevHierarchy` is false — the threads carry no `role`, so this is not an iPad problem |
| 8 | Tap **Builders** in the sidebar | The grid, one pane per agent, each showing its porch phase and its last three messages | Panes reading "Phase needs a codev-agent credential" is expected here — you have not paired with the agent yet. That is step 9 |
| 9 | Open the gated builder's thread | A rose **Waiting on you: `<gate>`** panel with the question and the choices | If the panel is absent the gate is not on the thread; check `porch status` again |
| 10 | Tap **Pair this browser** | The pairing form: a `codev-agent` picker, machine name, workspace path, token | An empty picker means step 2's check was skipped |
| 11 | Fill it in: agent `local`; machine `ipad`; workspace the **absolute path on the Mac** (`/Users/chris/dev/codev-1455`); token = the `machine-credential` token from step 3 | The form closes and the panel now says **as ipad on local** | A red line quoting an agent signal is the agent refusing — read the signal, it is the agent's own words |
| 12 | Go back to **Builders** | The panes now carry the real porch phase and real messages | Still "needs a credential" means the pairing did not store — private browsing blocks it, and the panel says so in those words |
| 13 | Paste the `client-session` token into **Session token** | — | — |
| 14 | Tap **Approve `<gate>`** | "Approving…", then a progress line naming the server's phase and checks, then a green line with a timestamp, a machine and a session id | See the outcome table below |
| 15 | On the Mac: `porch status <id>` | The gate is `approved`, and `status.yaml` records the same session id and machine the iPad showed | A mismatch here is the finding this whole run exists to surface |
| 16 | Drive the builder to completion from the iPad | The builder proceeds past the gate | — |

### Reading step 14's outcome — four answers, and two of them are not "no"

| On screen | What it means | What to do |
|---|---|---|
| Green, with a timestamp / machine / session | Approved. Those three came from the server, not the page | Step 15 |
| **"Could not tell — …"** (informational, not red) | The server answered and the page could not read it. **The gate may well be approved** | Check `porch status`. Do **not** tap Approve again first |
| Amber, "The session ended" | The session idled out (30 minutes). Ordinary | Mint another `client-session` token and repeat from step 13 |
| Red, with a signal | A real refusal, in the agent's own words | Read the signal |

---

## What to capture, for `codev/resources/250-acceptance-evidence.md`

- The iPad model and iOS version, and that it was **Safari, no app**.
- `tailscale status` showing the iPad and the Mac on the tailnet, and that the URL used the tailnet
  name rather than a LAN IP.
- Screenshots from the iPad at steps 7, 8, 9, 12 and 14.
- The `porch status <id>` output from step 15, beside the session id the iPad displayed.
- Anything that needed a retry, and why. A run that needed three attempts and says so is worth more
  than a clean one that does not say what it skipped.

## Teardown

```bash
afx pair revoke ipad     # withdraws the machine credential AND its approval capabilities
afx pair list            # confirm: `ipad  REVOKED`, and nothing else changed
```

`afx pair list` prints no secrets. Revoking one machine is per-machine by design — criterion 3 of
the phase-10 e2e asserts exactly that, so if another paired device stops working too, that is a
finding worth reporting rather than expected behaviour.

## If no iPad appears

Criterion 6 closes **UNMET**, and the review records:

- that it was not run, and why — no device available, not a failure of the code;
- that this runbook exists and is executable;
- that the same path was exercised in a desktop browser by the phase 10 Playwright suite, over the
  same proxy and the same ceremony, and that **this is not a substitute**: what the iPad closes is
  the tailnet reach and the touch target sizes, and nothing on the Mac tests either.
