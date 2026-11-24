// Copyright Epic Games, Inc. All Rights Reserved.
import { createConnection, Socket } from 'net';
import { Command } from 'commander';
import {
    Logger,
    PlayerConnection,
    SignallingServer,
    StreamerConnection
} from '@epicgames-ps/lib-pixelstreamingsignalling-ue5.8';
import { booleanValue } from './ueProgram';

interface MatchmakerOptions {
    UseMatchmaker?: boolean;
    MatchmakerAddress?: string;
    MatchmakerPort?: string | number;
    MatchmakerRetryInterval?: string | number;
    PublicIp?: string;
    https?: boolean;
    https_port?: string | number;
    player_port?: string | number;
}

export function addMatchmakerOptions(program: Command, config: MatchmakerOptions): void {
    program
        .option(
            '--UseMatchmaker [boolean]',
            'Register with a legacy Matchmaker.',
            booleanValue,
            config.UseMatchmaker ?? false
        )
        .option(
            '--MatchmakerAddress <host>',
            'Legacy Matchmaker host.',
            config.MatchmakerAddress || '127.0.0.1'
        )
        .option(
            '--MatchmakerPort <port>',
            'Legacy Matchmaker TCP port.',
            String(config.MatchmakerPort ?? 9999)
        )
        .option(
            '--MatchmakerRetryInterval <seconds>',
            'Retry delay after a disconnect.',
            String(config.MatchmakerRetryInterval ?? 5)
        )
        .option(
            '--PublicIp <host>',
            'Player-facing hostname advertised to the Matchmaker.',
            config.PublicIp || '127.0.0.1'
        );
}

export function attachMatchmaker(server: SignallingServer, options: MatchmakerOptions): void {
    if (!options.UseMatchmaker) return;

    const port = Number(options.MatchmakerPort);
    const retryDelay = Number(options.MatchmakerRetryInterval) * 1000;
    if (
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535 ||
        !Number.isFinite(retryDelay) ||
        retryDelay <= 0
    ) {
        throw new Error('MatchmakerPort must be a TCP port and MatchmakerRetryInterval must be positive.');
    }

    let socket: Socket;
    let updateTimer: NodeJS.Timeout | undefined;
    let reportedPlayers = 0;
    let reportedReady = false;
    let lastWrite = 0;
    let pingDue = false;

    const playerCount = () =>
        server.playerRegistry.listPlayers().filter((player) => player instanceof PlayerConnection).length;
    const hasStreamer = () =>
        server.streamerRegistry.streamers.some((streamer) => streamer instanceof StreamerConnection);

    function send(message: object) {
        socket.write(JSON.stringify(message));
        lastWrite = Date.now();
    }

    function scheduleUpdate() {
        // The old Matchmaker parses one JSON object per TCP data event without any framing.
        // Keep writes apart and reconcile registry snapshots after 'removed' handlers have returned.
        if (socket.readyState === 'open' && !updateTimer) {
            updateTimer = setTimeout(update, Math.max(0, 50 - (Date.now() - lastWrite)));
        }
    }

    function update() {
        updateTimer = undefined;
        if (socket.readyState !== 'open') return;
        const players = playerCount();
        const ready = hasStreamer();
        if (pingDue) {
            pingDue = false;
            send({ type: 'ping' });
        } else if (reportedReady && !ready) {
            reportedReady = false;
            send({ type: 'streamerDisconnected' });
        } else if (reportedPlayers !== players) {
            const added = players > reportedPlayers;
            reportedPlayers += added ? 1 : -1;
            send({ type: added ? 'clientConnected' : 'clientDisconnected' });
        } else if (!reportedReady && ready) {
            reportedReady = true;
            send({ type: 'streamerConnected' });
        } else {
            return;
        }
        scheduleUpdate();
    }

    function connect() {
        socket = createConnection({ host: options.MatchmakerAddress, port });
        socket.setNoDelay(true);
        socket.on('connect', () => {
            pingDue = false;
            reportedReady = hasStreamer();
            // A legacy registration can encode only 0/1 players. Replay any remaining count.
            reportedPlayers = playerCount() > 0 ? 1 : 0;
            send({
                type: 'connect',
                address: options.PublicIp,
                https: Boolean(options.https),
                port: Number(options.https ? options.https_port : options.player_port),
                ready: reportedReady,
                playerConnected: reportedPlayers > 0
            });
            scheduleUpdate();
        });
        socket.on('error', (error) => Logger.warn(`Matchmaker connection failed: ${error.message}`));
        socket.once('close', () => {
            clearTimeout(updateTimer);
            updateTimer = undefined;
            setTimeout(connect, retryDelay).unref();
        });
    }

    connect();
    server.streamerRegistry.on('added', scheduleUpdate);
    server.streamerRegistry.on('removed', scheduleUpdate);
    server.playerRegistry.on('added', scheduleUpdate);
    server.playerRegistry.on('removed', scheduleUpdate);
    setInterval(() => {
        pingDue = true;
        scheduleUpdate();
    }, 30000).unref();
    // The legacy server removes an endpoint on a socket error, including a TCP reset.
    process.once('exit', () => {
        if (socket.readyState === 'open') socket.resetAndDestroy();
    });
}
