# Mola Cloud Computer Integration

OpenMausBot can provision and manage cloud computers through [Mola](https://mola.sh), giving your AI agents instant Linux desktops they can see, control, and operate.

## What is Mola?

Mola provides instant computers powered by Omarchy. Each machine runs in its own virtual machine on hardware you control (self-hosted) or in the cloud (managed service). Machines start in about one second and become usable in under ten seconds.

### Default Configuration

- **Operating System**: Ubuntu 24.04 XFCE Desktop (default)
- **Alternative**: Omarchy (Arch Linux + Hyprland)
- **Resources**: 4 vCPU, 4096 MB RAM, 40 GB disk (configurable)

## Setup

### Self-Hosted Mola

1. Install Mola Core locally:
   ```bash
   npx mola-core
   ```

2. Copy the API token and URL from the startup banner

3. In OpenMausBot Settings → API keys, add:
   - **Mola API Key**: Your token
   - **Mola API URL**: `http://127.0.0.1:4141/v1` (or your custom URL)

### Cloud-Managed Mola (cloud.mola.sh)

1. Sign up at [cloud.mola.sh](https://cloud.mola.sh)
2. Generate an API key from your account dashboard
3. In OpenMausBot Settings → API keys, add:
   - **Mola API Key**: Your API key
   - **Mola API URL**: `https://api.mola.sh/v1` (or leave empty for default)

## Configuration

### Environment Variables

```bash
export MOLA_API_KEY="your-api-key-here"
export MOLA_API_URL="https://api.mola.sh/v1"  # Optional, defaults to cloud
```

### Config File (~/.openmausbot/config.json)

```json
{
  "mola": {
    "token": "your-api-key-here",
    "apiUrl": "https://api.mola.sh/v1"
  }
}
```

The `apiUrl` field is optional:
- Omit it to use the default cloud service (`https://api.mola.sh/v1`)
- Set it to `http://127.0.0.1:4141/v1` for local self-hosted Mola
- Set it to your custom URL for private deployments

## Features

### Supported Operations

✅ **Lifecycle Management**
- Create machines with custom resources (CPU, RAM, disk)
- Start stopped machines
- Stop running machines
- Delete machines and their disks

✅ **Shell Access**
- Execute commands via SSH
- Isolated environment (no credential leakage)
- Output capture (stdout/stderr)
- Timeout support

✅ **File Operations**
- Read files from the machine
- Write files to the machine
- Base64 encoding for binary safety

✅ **Desktop Access**
- Browser-based desktop viewer (VNC)
- 60-second single-use tickets
- Mouse and keyboard control
- Screen capture/screenshots

✅ **Input Control**
- Click (left, middle, right button)
- Mouse movement
- Scrolling
- Text typing
- Keyboard shortcuts

### Machine States

- `booting` - Machine is starting up
- `ready` - Machine is running and responsive
- `stopped` - Machine is shut down
- `starting` - Transitioning to running state
- `unknown` - State could not be determined

## Usage

### Bot Configuration

Assign a Mola-backed cloud computer to a bot in OpenMausBot:

1. Create or edit a bot
2. Enable cloud computer access
3. Select Mola as the provider
4. The bot will automatically provision a machine on first use

### Machine Naming

OpenMausBot automatically manages machine names to prevent conflicts:
- Pattern: `ogb-<scope>-<bot-prefix>-<hash>`
- Scope ensures machines from different OpenMausBot installations don't overlap
- Bot prefix derived from bot ID (first 8 alphanumeric characters)
- Hash provides uniqueness and verification

### Resource Limits

Default machine resources:
- vCPU: 4 cores
- Memory: 4096 MB
- Disk: 40 GB

These defaults match Mola's standard configuration and can be adjusted by environment variables on the Mola host (`MOLA_DEFAULT_VCPUS`, `MOLA_DEFAULT_MEMORY_MB`, `MOLA_DEFAULT_DISK_GB`).

## API Compatibility

Mola uses a REST API (v1) over HTTPS. All requests require a bearer token in the `Authorization` header.

### Key Differences from Boat

| Feature | Mola | Boat |
|---------|------|------|
| Machine lifecycle | Manual start/stop/delete | Auto-archive with TTL |
| Desktop access | 60s single-use ticket | Rotating stream tokens |
| SSH connection | Built-in (exposed in API) | Manual setup |
| File operations | First-class API actions | SSH-based only |
| Default OS | Ubuntu 24.04 XFCE | Custom |

## Troubleshooting

### "Mola is not configured"

Check that `MOLA_API_KEY` is set or `mola.token` exists in `~/.openmausbot/config.json`.

### "mola.sh rejected the Mola API key"

Your API key may be:
- Invalid or expired
- Revoked
- For the wrong environment (local vs cloud)

Generate a fresh key from your Mola dashboard or local instance.

### "Could not reach mola.sh"

Check your network connection and verify:
- The API URL is correct
- Firewall allows outbound HTTPS (port 443)
- For self-hosted: Mola Core is running on the specified port

### Machine stuck in "booting"

Machines should reach `ready` state within 90 seconds. If not:
- Check Mola host has adequate resources
- Verify guest agent is running in the VM
- Look for errors in Mola Core logs

## Security

- API tokens are stored in `~/.openmausbot/config.json` (file mode 0600)
- Tokens are never passed to spawned processes or logged
- Desktop URLs contain single-use tickets with 60-second expiry
- Commands run in isolated environments without credential access

## Limitations

⚠️ **No automatic TTL**: Mola machines don't auto-sleep like Boat. You must explicitly stop or delete them.

⚠️ **No snapshot/resume**: Stopping a machine shuts it down; starting it boots from the disk.

⚠️ **Manual resource tuning**: Machine resources are set at creation time and cannot be changed without recreating the machine.

## References

- [Mola Documentation](https://mola.sh)
- [Mola Core GitHub](https://github.com/obaid/mola-core)
- [API Reference](https://mola.sh/docs/api)
- [Mola MCP Integration](https://mola.sh/docs/mcp)
