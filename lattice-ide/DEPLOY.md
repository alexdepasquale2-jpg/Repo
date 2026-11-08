# Lattice private deployment runbook

This runbook covers running `worker.py` inside a customer's own cloud account or on-prem GPUs,
operated by us or by the customer. It is an engineering document, **not legal advice**.

> **Legal gate.** The commercial offering described here (a managed private deployment we
> sell) **requires counsel sign-off before selling**. Open questions for counsel include who
> the HY-World "Licensee" is when we operate the worker for a customer, how the §4 1M-MAU
> threshold is counted, whether "Territory" follows the cloud region, the end user, or both,
> and confirming the OpenMDW version (1.1) against https://openmdw.ai/license/. Until signed
> off, deploy Cosmos-only, or HY-World only for internal evaluation in allowed regions.

## 1. What we must not do

- **No public model API.** Do not expose the worker as a general, public inference endpoint.
  The OpenMDW terms restrict offering Cosmos as a competing public model API, and HY-World
  output via a "Hosted Service" is still HY-World Output subject to its license. Each
  deployment serves one customer, behind auth.
- **No bundled weights.** We ship no Cosmos or HY-World weights in images, AMIs or installers.
  The customer downloads them with their own Hugging Face account and accepts each license
  themselves. If that ever changes, the license and notice duties apply (OpenMDW notices;
  HY-World §3 license copy + NOTICE, Territory only).
- **No HY-World in excluded territories.** HY-World 2.0's license does not apply in the EU-27,
  the UK or South Korea (preamble, §1(l), §5(c)), including use or display of its Outputs there.
  Do not deploy HY-World in cloud regions located there, and do not serve HY-World jobs or
  outputs to users there. The worker enforces a gate (section 4); the gate helps, but it does not
  make a deployment compliant on its own.
- **No training on HY-World outputs.** HY-World Outputs may not be used to improve any other AI
  model (§5(b)). Do not sell or hand over HY-World outputs as training data. `batch.py` datasets
  are Cosmos-only for this reason.
- **Never persist tokens.** HF tokens are sent only as `X-HF-Token` and live in memory only.

## 2. Customer license acceptance

Before the first HY-World or Cosmos job, the customer (not us on their behalf) must:

1. Read and accept the OpenMDW license (Cosmos 3) and Tencent's HY-World 2.0 `License.txt`
   including its Acceptable Use Policy, on Hugging Face with their own account.
2. Sign our service agreement, which must flow down HY-World §5(a)/(b) use restrictions
   (required by §5(a)) and state the territory limits.
3. Confirm in writing that they are under the §4 1M-MAU threshold, or hold a Tencent license.

The PWA also records acceptance per job (`license.accepted`, `acceptedAt`). Keep those job
records (`runs/<id>/job.json`) as the audit trail.

Each job's license acceptance (license id, `acceptedAt`, territory, user, IP) is appended to
`runs/_audit/audit.jsonl`. Keep it with `job.json` as the audit trail, include it in backups, and
export it with `GET /audit.csv` (admin).

## 3. Host setup

- GPU VM in the customer account (see the cost brief for sizing; Super 64B = datacenter only,
  HY-World = RTX-class or datacenter).
- Python 3.10+, NVIDIA driver + `nvidia-smi`, optional `ffmpeg`. The worker itself is stdlib only.
- Install the engines the customer licensed. Then either:
  - **systemd host:** `sudo sh install.sh --dry-run` to review, then `sudo sh install.sh`. It installs to
    `/opt/lattice`, creates the `lattice` user, `/etc/lattice/worker.env` (root-owned, 0600, random token) and
    the hardened `lattice-worker.service`. It never starts the service or downloads engines or weights.
  - **Docker Compose:** `cd deploy && cp worker.env.example worker.env`, edit it, then
    `LATTICE_DOMAIN=<host> docker compose up -d --build`. Caddy serves the app at `https://<host>/` and the
    worker at `https://<host>/api`; set the app's worker URL to `https://<host>/api`.
- `deploy/Caddyfile` is the reference HTTPS setup for both paths.

### Teams: per-user tokens

For more than one person, set `LATTICE_USERS=/etc/lattice/users.json` instead of `LATTICE_TOKEN`
(mode 0600, owned by `lattice`). Manage users with
`sudo -u lattice LATTICE_USERS=/etc/lattice/users.json LATTICE_RUNS=/var/lib/lattice/runs python3 /opt/lattice/worker.py users add <name> --role operator`.
Passing the runs dir makes user changes appear in the audit log. Behind Caddy or nginx, set
`LATTICE_TRUST_PROXY=1` so audit IPs come from `X-Forwarded-For`; only do this when port 8787 is not
reachable directly.

### Environment file `/etc/lattice/worker.env` (mode 0600, owner lattice)

```
LATTICE_HOST=127.0.0.1          # bind locally; the reverse proxy terminates HTTPS
LATTICE_PORT=8787
LATTICE_RUNS=/var/lib/lattice/runs
LATTICE_EXEC=1                  # run engines for real (omit for dry run)
LATTICE_TOKEN=<long random secret, e.g. `openssl rand -hex 32`>
LATTICE_REGION=US               # ISO alpha-2 of the country the VM runs in
LATTICE_GPU_USD_HR=2.50         # optional; the customer's $/GPU-hour for cost_usd in metrics
```

Do not put an HF token in this file. Tokens come per job from the client.

### systemd unit `/etc/systemd/system/lattice-worker.service`

```
[Unit]
Description=Lattice worker
After=network-online.target
Wants=network-online.target

[Service]
User=lattice
Group=lattice
EnvironmentFile=/etc/lattice/worker.env
WorkingDirectory=/opt/lattice
ExecStart=/usr/bin/python3 /opt/lattice/worker.py
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/lattice
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`systemctl daemon-reload && systemctl enable --now lattice-worker`, then
`curl -s localhost:8787/health`.

### HTTPS via reverse proxy (Caddy example)

```
lattice.customer.example {
    reverse_proxy 127.0.0.1:8787
    request_body {
        max_size 64MB
    }
}
```

With nginx, set `client_max_body_size 64m;` and `proxy_buffering off;` for video Range requests.
Keep port 8787 closed in the firewall or security group; only 443 is public. Restrict the source
IP ranges to the customer's network or VPN when possible. `/health` is unauthenticated by design,
and every other endpoint requires `Authorization: Bearer $LATTICE_TOKEN`.

## 4. Region and territory gate

- `LATTICE_REGION` is the ISO 3166 alpha-2 code of where the worker runs. If it is an EU-27
  member, `GB` or `KR`, `/health` reports `"hy_territory_ok": false` and every HY-World or bridge
  job is rejected with `400 "HY-World 2.0 license does not apply in <X>"`. Cosmos jobs still run.
- Clients may send `license.territory` (the requesting user's country). The same rule applies.
- The gate is best-effort: an unset `LATTICE_REGION` or a client that omits `territory` is not
  blocked. For HY-World deployments, always set the region, and have the customer's frontend or
  SSO supply the user's territory.

## 5. Notices and outputs

Each run directory gets `NOTICE-HY-World.txt` and/or `NOTICE-Cosmos.txt`. Export bundles
(`export/<target>/<target>-bundle.zip`) include them. Do not strip them when handing outputs on.
The repo-level `NOTICE` lists third-party components.

## 6. Metrics and cost

Every finished run writes `metrics.json`: per-stage wall time, GPU name and count, peak VRAM
(polled with `nvidia-smi` while a stage runs; null if unavailable) and exit code. When
`LATTICE_GPU_USD_HR` is set, `cost_usd = gpu_hours x rate`, where gpu_hours sums stage wall time
times max(1, gpu_count). This estimate ignores idle time and storage and is not a bill. Dry runs report `gpu_hours` 0 and `cost_usd` null.

## 7. Operations

- Upgrades: replace `/opt/lattice`, then `systemctl restart lattice-worker`. Queued or running jobs
  are marked `failed: worker restarted`.
- Backups/retention: `LATTICE_RUNS` holds inputs and outputs. Agree retention with the customer.
  Delete HY-World outputs that would otherwise be viewed from excluded territories.
- Rotate `LATTICE_TOKEN` by editing the env file and restarting. Clients re-enter it in Settings.
- With `LATTICE_USERS`, rotate one person with `users rotate <name>` and offboard with `users remove <name>`;
  both take effect without a restart.
- `GET /report?since=<date>` (admin) gives per-user and per-engine cost estimates from metrics; it is not a bill.
