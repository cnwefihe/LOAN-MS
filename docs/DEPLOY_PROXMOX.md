# Deploying on Proxmox with Docker Compose

This guide sets up the Ubuntu virtual machine (VM) in Proxmox that runs the Loan Management System. Each step says **where** to do it.

**Releases are deployed by GitHub Actions.** After sections 0 to 2 and 4, follow **[CI_CD.md](CI_CD.md)**, then come back to section 9. The containers are listed there.

## 0. What you need first

| Item | Why |
|---|---|
| A web address, for example `loans.example.edu.ng` | Microsoft sign-in and HTTPS need a real name |
| Someone who can edit the `example.edu.ng` DNS | To point that name at the server |
| Access to the Microsoft Entra admin centre | **Staff can only sign in through Microsoft. There are no passwords, so nobody can get in until section 4 is done.** |
| The email addresses of the first Super Administrators | They are given access at first sign-in |
| An Ubuntu Server 24.04 LTS ISO | Download from ubuntu.com/download/server |

## 1. Create the VM

**Where: Proxmox web interface** (`https://<proxmox-ip>:8006`)

1. Select your node, then **local > ISO Images > Upload**, and upload the Ubuntu ISO.
2. Click **Create VM** and use these values:

   | Tab | Setting | Value |
   |---|---|---|
   | General | Name | `pau-lms` |
   | OS | ISO image | The Ubuntu ISO |
   | System | Qemu Agent | Ticked |
   | Disks | Bus | SCSI, with **Discard** ticked |
   | Disks | Disk size | 100 GB minimum (documents and backups need room) |
   | CPU | Cores | 4, type `host` |
   | Memory | RAM | 8192 MB |
   | Network | Bridge | `vmbr0` (or your LAN bridge) |

3. Under **Options**, set **Start at boot** to Yes.
4. Start the VM, open **Console**, and install Ubuntu:
   - give it a **static IP address**;
   - create a user, for example `lmsadmin`;
   - tick **Install OpenSSH server**;
   - do not tick Docker in the optional packages list, because section 2 installs the official version.

Use a VM rather than an LXC container. Docker inside LXC needs extra settings and is more fragile.

## 2. Prepare the VM

**Where: the VM, over SSH.** From Windows PowerShell: `ssh lmsadmin@<vm-ip>`

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y qemu-guest-agent ufw
sudo systemctl enable --now qemu-guest-agent

# Docker and Docker Compose
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER

# Firewall: only SSH and the web ports
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
```

Sign out and back in so the Docker permission applies, then check:

```bash
docker compose version
```

## 3. Copying the project

This is no longer needed: the pipeline copies what the server needs. If you already copied the project to `/opt/lms`, leave it there. The pipeline replaces the files it uses.

## 4. Register Microsoft sign-in

**Where: entra.microsoft.com** (needs an Entra administrator)

1. Go to **App registrations > New registration**.
   - Name: `Loan Management System`
   - Account types: this organisational directory only (single tenant)
   - Redirect URI: **Web**, `https://loans.example.edu.ng/api/auth/callback` (use your address)
2. Copy the **Application (client) ID** and **Directory (tenant) ID**.
3. Go to **API permissions > Add a permission > Microsoft Graph > Delegated > User.Read**, then **Grant admin consent**.
4. Go to **Certificates & secrets > New client secret**. Copy the **Value** straight away; it is only shown once. Note the expiry date, because sign-in stops when it expires.

Keep these values for the GitHub secrets. Email is optional at first and can be added later. Its steps are in [DEPLOYMENT.md](DEPLOYMENT.md), section 5.

## 5 to 8. Settings, HTTPS and starting the system

All of these are handled by the pipeline. Follow **[CI_CD.md](CI_CD.md)**.

## 9. First sign-in and set-up

**Where: a browser, signed in with a `BOOTSTRAP_SUPER_ADMIN_EMAIL` address**

The current admin set-up is installed automatically: settings, role titles and permissions, products and their policies, templates, loan terms, document requirements, and the organisation structure. Demo accounts and test data are not. You only need to:

- choose the real approver for each department, because the demo approvers are gone;
- give staff their roles;
- replace the placeholder loan terms and guarantor agreement.

### Create the administrator account

Accounts are not created by hand, and there are no passwords. An account is created the first time someone signs in with Microsoft.

1. Make sure your address is in the `BOOTSTRAP_SUPER_ADMIN_EMAIL` GitHub secret. Separate several addresses with commas.
2. Open the web address and click **Sign in with Microsoft**. Use that same Microsoft 365 account.
3. You arrive as a Super Administrator. Check that **Control centre** is in the menu.

Other administrators sign in once first, so that they appear under **Users**. You can then give them roles from the three-dot menu.

### Check the set-up

1. **Branding:** check names, contacts and logos.
2. **Products:** check each product's policy.
3. **Templates:** replace the placeholder loan terms and guarantor agreement with the approved text.
4. **Organisation:** enter the real departments, schools and approvers.
5. **Users:** give the HR Administrator, Bursary Officer, HR Director, Bursar and Accounts Payable Officer roles to different people. People appear here after they first sign in.
6. **Settings:** review each section. Under **Security**, turn on two-step verification.
7. **Emails:** once email is set up, send a test email.

Then remove the bootstrap access.

**Where: GitHub.** Delete the `BOOTSTRAP_SUPER_ADMIN_EMAIL` secret, then go to **Actions > CI/CD > Run workflow**.

Before opening to all staff, run one small real loan through every stage, with real people in each role.

### Installing the app on a computer or phone

The system can be installed like an app once it is running on HTTPS. Staff need nothing from an app store.

| Device | Steps |
|---|---|
| Windows or Mac, Chrome or Edge | Open the web address, then click the install icon at the right of the address bar |
| Android, Chrome | Open the address, then menu (three dots) > **Add to Home screen** or **Install app** |
| iPhone or iPad, Safari | Open the address, then **Share** > **Add to Home Screen** |

The app needs a connection. Offline it shows a message, because pages and staff data are never stored on the device.

## 10. Backups

**Where: the VM**

```bash
sudo crontab -e
```

Add this line for a backup at 01:30 every night:

```
30 1 * * * /opt/lms/deploy/backup.sh >> /var/log/pau-lms-backup.log 2>&1
```

Test it once now:

```bash
sudo /opt/lms/deploy/backup.sh
sudo ls -lh /var/backups/pau-lms
```

**Where: Proxmox web interface**

Go to **Datacenter > Backup > Add** and schedule a nightly backup of the VM to storage on a **different disk or machine**.

Also copy `/var/backups/pau-lms` off the server regularly. A backup on the same disk is lost with the disk.

**To restore the database** (**Where: the VM**). This replaces all current data:

```bash
cd /opt/lms
docker compose stop app scheduler
docker compose exec -T db pg_restore -U loans -d loans --clean --if-exists --no-owner < /var/backups/pau-lms/db-YYYY-MM-DD.dump
docker compose start app scheduler
```

Try a restore on a test VM before going live, so you know it works.

## 11. Installing an update

Push to `main`. The pipeline tests and deploys it. Your settings, database and documents are kept. Take a backup first for large releases:

```bash
sudo /opt/lms/deploy/backup.sh
```

## 12. If something goes wrong

Pipeline problems are covered in [CI_CD.md](CI_CD.md).

| What you see | What to do |
|---|---|
| `app` stays `unhealthy` | Run `docker compose logs app`. A missing `AUTH_SECRET` or `DATA_ENCRYPTION_KEY` is the usual cause. |
| The browser warns about the certificate | Run `docker compose logs certbot`. Check the DNS record and that port 80 reaches the VM. |
| "HTTPS is being set up" | The certificate has not arrived yet. Run `docker compose logs certbot`. |
| "Microsoft sign-in has not been configured" | The `ENTRA_` secrets are missing. Add them and run the workflow again. |
| Microsoft shows a redirect URI error | The redirect URI in section 4 must be exactly `https://your-domain/api/auth/callback`. |
| A large upload fails | Check the limit under **Branding > Documents**. It can go up to 25 MB. |
| Reminders do not arrive | Run `docker compose logs scheduler`. It should say `ok`, not `FAILED`. |

Useful commands, all from `/opt/lms`:

```bash
docker compose ps                  # what is running
docker compose logs -f app         # live app log
docker compose restart app         # restart the app
docker compose down                # stop everything (data is kept)
```

Do not run `docker compose down -v`. The `-v` deletes the database and documents.
