# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Cirrus** — Epic Games' reference Pixel Streaming signalling server for UE 5.3+. It brokers WebRTC peer connections between Unreal Engine streaming instances and browser players.

This project has been extended with custom UE process management: the server can launch/kill UE executables per player session.

## Development Commands

```bash
npm start                              # Production start (Windows: direct, Linux: sudo)
npm run start-local                    # Local development (uses shell scripts)
npm run start-signalling-server        # Signalling only (no matchmaker)
npm run start-with-turn-signalling-server  # With TURN server
npm run store_password                 # Set auth password in database
```

No build step required — pure Node.js runtime. No lint or test commands configured.

## Architecture

### Three WebSocket Servers

| Port | Role | Who Connects |
|------|------|--------------|
| 8888 (`StreamerPort`) | Streamer endpoint | UE application instances |
| 8889 (`SFUPort`) | SFU routing layer | Selective Forwarding Units |
| 6888 (`HttpPort`) | HTTP + Player WS | Browser clients |

All signalling logic lives in `cirrus.js` (~1600 lines). There is no separate module structure for the core logic — the file handles WebSocket connection lifecycle, WebRTC offer/answer/ICE relay, and UE process management.

### Key Abstractions

- **`Streamer`** — represents a connected UE instance; has an ID, WebSocket, and type
- **`Player`** — represents a browser client; subscribes to a Streamer for video
- **`playerProcessMap`** — maps `playerId → child_process` for custom UE process management

### Custom UE Process Management

`startUEProgram(playerId)` spawns a UE executable with pixel streaming arguments when a player connects. `stopUEProgram(playerId)` terminates it via `taskkill` on Windows. Config key: `UEProgram` (path to `.exe`).

### Configuration

Priority order (highest wins): CLI args `--key=value` → `config.json` → built-in defaults.

Key toggles in `config.json`:
- `UseHTTPS`, `UseAuthentication`, `UseMatchmaker`, `MultiIProgress`
- Port settings: `HttpPort`, `StreamerPort`, `SFUPort`
- `UEProgram` — path to UE executable for auto-launch
- `Localhost` — bind to 127.0.0.1 only

### Signalling Protocol

Message types are documented in `Docs/SignallingProtocol.md`. The protocol flows:
1. UE connects to port 8888, sends `endpointId`
2. Browser connects to port 6888, sends `subscribe` with streamer ID
3. Server relays WebRTC `offer`/`answer`/`iceCandidate` messages between them

### Authentication / Static Files

- Optional Passport.js auth in `modules/authentication/`
- Config loading in `modules/config.js` (merges defaults + file + CLI)
- Logging in `modules/logging.js` (colored console + optional file output)
- Player HTML/JS served from `Public/`
