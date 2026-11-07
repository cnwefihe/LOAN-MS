# CI/CD deployment with GitHub Actions

Every push to `main` tests the code, builds a Docker image, publishes it to Docker Hub, and deploys it to the Proxmox VM.

```
push to main
  1. Test      type check, unit tests, build, browser tests
  2. Image     build Docker image, smoke test on PostgreSQL, check Nginx and Compose, publish
  3. Deploy    write .env, copy Compose files, pull the image, restart, check health
```

Pull requests run step 1 and the checks in step 2. They publish and deploy nothing.

All services run in Docker on the VM:

| Container | Job |
|---|---|
| `nginx` | Reverse proxy and HTTPS. The only container with open ports (80, 443). |
| `certbot` | Gets the Let's Encrypt certificate and renews it |
| `app` | The Loan Management System |
| `migrate` | Updates the database on each deployment, then stops |
| `scheduler` | Reminders every 5 minutes, loan checks every hour |
| `db` | PostgreSQL, reachable only inside Docker |

## What must be true first

- The VM is set up with Docker (sections 1 and 2 of [DEPLOY_PROXMOX.md](DEPLOY_PROXMOX.md)).
- **The server has a public IP address.** GitHub must reach it over SSH, and Let's Encrypt must reach port 80.
- DNS: an **A record** for your domain points at that public IP.
- Your router or firewall forwards ports 80, 443 and the SSH port to the VM.

If the server cannot be reached from the internet, this design will not work as written. Tell whoever maintains it: it needs a self-hosted GitHub runner on the VM, and a different way to get the certificate.

## Step 1: Prepare the server login

GitHub signs in to the server with the `lmsadmin` password.

**Where: the VM**

```bash
sudo mkdir -p /opt/lms
sudo chown $USER:$USER /opt/lms

# Blocks addresses that keep guessing the password
sudo apt install -y fail2ban
```

Use a long, random password, because the SSH port is open to the internet. To change it, run `passwd`.

**Where: any computer with internet access**, to get the `SSH_KNOWN_HOSTS` value:

```bash
ssh-keyscan -p 22 your.public.address
```

This records the server's identity, so the password is only ever sent to your server.

## Step 2: Generate the secret values

**Where: the VM**

```bash
echo "POSTGRES_PASSWORD: $(openssl rand -hex 32)"
echo "AUTH_SECRET: $(openssl rand -hex 48)"
echo "DATA_ENCRYPTION_KEY: $(openssl rand -base64 32)"
echo "CRON_SECRET: $(openssl rand -hex 32)"
```

**Keep a copy of these somewhere safe, outside GitHub.** GitHub secrets cannot be read back. If `DATA_ENCRYPTION_KEY` is lost, uploaded documents and bank details can never be read again, even from a backup.

## Step 3: Add the GitHub secrets

**Where: github.com/<your-account>/<your-repository> > Settings > Secrets and variables > Actions > New repository secret**

### Server connection (required)

| Secret | Value |
|---|---|
| `SSH_HOST` | The server's public IP address or host name |
| `SSH_USER` | `lmsadmin` |
| `SSH_PASSWORD` | The `lmsadmin` password |
| `SSH_KNOWN_HOSTS` | The `ssh-keyscan` output from Step 1 |

### Docker Hub (required)

Create a **private** repository named `loan-ms` on hub.docker.com, because the image contains the application. Then go to **Account settings > Personal access tokens** and create a token with **Read & Write** access.

| Secret | Value |
|---|---|
| `DOCKERHUB_USERNAME` | Your Docker Hub username |
| `DOCKERHUB_TOKEN` | The access token, not your password |

### Website (required)

| Secret | Value |
|---|---|
| `DOMAIN` | `loans.example.edu.ng` (no `https://`) |
| `LETSENCRYPT_EMAIL` | Address for certificate expiry notices |

### Application secrets (required)

| Secret | Value |
|---|---|
| `POSTGRES_PASSWORD` | From Step 2 |
| `AUTH_SECRET` | From Step 2 |
| `DATA_ENCRYPTION_KEY` | From Step 2 |
| `CRON_SECRET` | From Step 2 |

### Microsoft sign-in (required)

Staff can only sign in through Microsoft. The steps to get these are in section 4 of [DEPLOY_PROXMOX.md](DEPLOY_PROXMOX.md).

| Secret | Value |
|---|---|
| `ENTRA_TENANT_ID` | Directory (tenant) ID |
| `ENTRA_CLIENT_ID` | Application (client) ID |
| `ENTRA_CLIENT_SECRET` | The client secret **Value** |
| `ALLOWED_EMAIL_DOMAIN` | `example.edu.ng` |
| `BOOTSTRAP_SUPER_ADMIN_EMAIL` | Your email. Delete this secret after go-live. |

### Optional

| Secret | When to add it |
|---|---|
| `SSH_PORT` | SSH is not on port 22 |
| `APP_DIR` | You are not using `/opt/lms` |
| `EMAIL_TRANSPORT` | Set to `graph` when email is ready |
| `EMAIL_SENDER_ADDRESS` | Shared mailbox, for example `loans@example.edu.ng` |
| `EMAIL_GRAPH_TENANT_ID` | Email app registration ([DEPLOYMENT.md](DEPLOYMENT.md), section 5) |
| `EMAIL_GRAPH_CLIENT_ID` | Email app registration |
| `EMAIL_GRAPH_CLIENT_SECRET` | Email app registration |
| `PAYROLL_API_BASE_URL` | When a payroll API exists. CSV import works without it. |
| `PAYROLL_API_KEY` | Same |
| `PAYROLL_LOAN_DEDUCTION_CODE` | Same |

`GITHUB_TOKEN` is created automatically. Do not add it.

Secrets must not contain a single quote (`'`). The values generated above never do.

## Step 4: Upload the code

**Where: PowerShell on your PC, in the project folder**

```powershell
git init -b main
git add .
git status
```

Check the `git status` list. It must **not** show `.env.local`, `.data`, `storage` or `node_modules`. Then:

```powershell
git commit -m "Initial commit"
git remote add origin https://github.com/<your-account>/<your-repository>.git
git push -u origin main
```

## Step 5: Watch the first deployment

**Where: github.com/<your-account>/<your-repository> > Actions**

The first run takes about 20 to 30 minutes. If **Deploy** is green, open `https://your-domain`.

The certificate is requested just after the first deployment, so HTTPS can take a few minutes. Nginx switches to it within a minute of it arriving.

**Where: the VM**, to look at it directly:

```bash
cd /opt/lms
docker compose ps
docker compose logs certbot
```

Then continue from section 9 of [DEPLOY_PROXMOX.md](DEPLOY_PROXMOX.md): first sign-in and set-up.

## Everyday use

| To do this | Do this |
|---|---|
| Release a change | Push to `main` |
| Change a setting | Edit the GitHub secret, then **Actions > CI/CD > Run workflow** |
| Go back to an older version | Open that older run under **Actions**, then **Re-run all jobs** |
| Require approval before deploying | **Settings > Environments > production > Required reviewers** |

Going back only replaces the app. It does not undo database changes, so take a backup before any large release.

## If something fails

| What you see | What to do |
|---|---|
| `Missing GitHub secret for NAME` | Add that secret (Step 3) |
| `Permission denied` | Check `SSH_USER` and `SSH_PASSWORD`. After repeated failures fail2ban blocks the address for a while, so try again later. |
| `Host key verification failed` | Run `ssh-keyscan` again and update `SSH_KNOWN_HOSTS` |
| SSH times out | Port forwarding or firewall. GitHub must reach the SSH port. |
| `docker: permission denied` | The `SSH_USER` is not in the `docker` group. See section 2 of the Proxmox guide. |
| `denied` when pushing or pulling the image | Check `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`, that the `loan-ms` repository exists, and that the token has Read & Write access. |
| The certificate is not issued | Run `docker compose logs certbot`. Usually DNS is wrong or port 80 is blocked. It retries every hour. |
| Secret changed, database will not connect | `POSTGRES_PASSWORD` cannot be changed by editing the secret alone, because the database keeps the first one. |

**Never change `DATA_ENCRYPTION_KEY` once real data exists.**
