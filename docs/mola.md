# Mola Cloud Computer Integration

OpenMausBot can provision and manage cloud computers through [Mola](https://github.com/obaid/mola-core), giving your AI agents instant Linux desktops they can see, control, and operate.

## What is Mola?

Mola provides instant computers powered by Omarchy. Each machine runs in its own virtual machine on hardware you control. Machines start in about one second and become usable in under ten seconds.

### Default Configuration

- **Operating System**: Ubuntu 24.04 XFCE Desktop (`ubuntu-xfce:24.04-4`)
- **Alternative**: Omarchy (Arch Linux + Hyprland) - default in Mola Core
- **Resources**: 4 vCPU, 4096 MB RAM, 40 GB disk (configurable)

## Setup

### Install Mola Core

1. Install and start Mola Core locally:
   ```bash
   npx mola-core
   ```

2. Copy the API token and URL from the startup banner:
   ```
   API    http://127.0.0.1:4141/v1
   Token  7_NmOSph4PWtcZP5QpVW4rJJ-9VIlIx3
   ```

3. In OpenMausBot Settings → API keys, add:
   - **Mola API Key**: Your token from the banner
   - **Mola API URL**: `http://127.0.0.1:4141/v1` (or your custom host/port)

## Configuration

### Environment Variables

```bash
export MOLA_API_KEY="your-token-from-mola-startup"
export MOLA_API_URL="http://127.0.0.1:4141/v1"  # Optional, defaults to localhost:4141
```

### Config File (~/.openmausbot/config.json)

```json
{
  "mola": {
    "token": "your-token-from-mola-startup",
    "apiUrl": "http://127.0.0.1:4141/v1"
  }
}
```

The `apiUrl` field is optional:
- Omit it to use the default (`http://127.0.0.1:4141/v1`)
- Set it to your custom host/port if Mola runs elsewhere
- For remote hosts, use SSH tunneling to keep the connection secure

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

### Ubuntu Desktop Setup

To use Ubuntu desktops (recommended), you'll need to install the Ubuntu image in Mola Core. See the [Ubuntu desktops documentation](https://github.com/obaid/mola-core/blob/main/docs/ubuntu-desktops.md) for build and installation instructions.

OpenMausBot defaults to `image_ref: "ubuntu-xfce:24.04-4"`. If you're using the default Omarchy image instead, you can override the image reference in your Mola host configuration.

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

These match Mola Core's defaults and can be adjusted with environment variables on the Mola host (`MOLA_DEFAULT_VCPUS`, `MOLA_DEFAULT_MEMORY_MB`, `MOLA_DEFAULT_DISK_GB`).

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

### "Mola API key rejected"

Your API key may be:
- Invalid (check the token from Mola's startup banner)
- From a different Mola instance
- Stale after Mola was restarted (tokens regenerate on each start)

Copy the current token from the Mola Core startup output.

### "Could not reach Mola"

Check your network connection and verify:
- The API URL is correct (default: `http://127.0.0.1:4141/v1`)
- Mola Core is running (`npx mola-core` in a terminal)
- The port isn't blocked by a firewall
- For remote hosts: SSH tunnel is active

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

- [Mola Core GitHub](https://github.com/obaid/mola-core)
- [API Reference](https://github.com/obaid/mola-core/blob/main/docs/api.md)
- [Ubuntu Desktops](https://github.com/obaid/mola-core/blob/main/docs/ubuntu-desktops.md)
- [MCP Integration](https://github.com/obaid/mola-core/blob/main/docs/mcp.md)
- [Getting Started](https://github.com/obaid/mola-core/blob/main/docs/getting-started.md)
