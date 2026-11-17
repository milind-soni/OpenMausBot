# OTECH License Server

Standalone lightweight Node.js license verification server for OTECH.
Deployed on Hetzner cloud at `https://license.otech.jo`.

## Features
- Zero external npm dependencies (uses native Node.js HTTP & crypto).
- Fast JSON file-based persistence (`data/keys.json`).
- CLI tool (`admin.mjs`) to easily generate, view, and revoke licenses.
- CORS-enabled for Desktop and Web clients.
- Verification endpoint: `/api/verify?key=OTECH-JO-XXXX-XXXX`.

## Quick Start on Hetzner Server

### 1. Install Node.js (v18+)
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Copy and Run
```bash
cd /opt/otech-license-server
node server.mjs
```

### 3. Systemd Service (`/etc/systemd/system/otech-license.service`)
```ini
[Unit]
Description=OTECH License Verification Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/otech-license-server
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=5
Environment=PORT=4000
Environment=ADMIN_SECRET=otech-secret-key-2026

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now otech-license
```

### 4. Caddy / Nginx Reverse Proxy (SSL)
```caddyfile
license.otech.jo {
    reverse_proxy localhost:4000
}
```

## Admin CLI Usage

```bash
# List all keys
node admin.mjs list

# Generate new license (Local Managed, 30 days)
node admin.mjs gen local "مطعم الأصالة" "+962791234567" "فرع عمان" 30

# Generate new license (Cloud Always On, 30 days)
node admin.mjs gen cloud "شركة الأفق" "+962790001122" "المقر" 30

# Verify key
node admin.mjs verify OTECH-JO-A7K9-2M4P

# Revoke key
node admin.mjs revoke OTECH-JO-A7K9-2M4P
```

## Key Management Rules
- **Customer License Duration**: Real customer keys default to **30 days** monthly billing.
- **Revoked Keys**: `OTECH-JO-CLD8-5W3X` is permanently revoked.
- **Test Keys**: All temporary demo test keys have been deleted. Real keys are issued via `node admin.mjs gen local ... 30` or the API.
