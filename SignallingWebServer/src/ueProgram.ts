// Copyright Epic Games, Inc. All Rights Reserved.
import { ChildProcess, execFile, spawn, spawnSync } from 'child_process';
import path from 'path';
import { Command, InvalidArgumentError } from 'commander';
import {
    IStreamer,
    Logger,
    PlayerConnection,
    SignallingServer
} from '@epicgames-ps/lib-pixelstreamingsignalling-ue5.8';
import { IProgramOptions } from './Utils';

export function booleanValue(value: string): boolean {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
    throw new InvalidArgumentError('Expected true or false.');
}

export function addUEProgramOptions(program: Command, config: IProgramOptions): void {
    const executable: unknown = config.UEProgram ?? '';
    if (typeof executable !== 'string') throw new Error('UEProgram must be an executable path.');
    program
        .option(
            '--UEProgram <path>',
            'Launch this packaged UE application when a player connects.',
            executable
        )
        .option(
            '--MultiIProgress [boolean]',
            'Give each player a separate streamer.',
            booleanValue,
            booleanValue(String(config.MultiIProgress ?? true))
        )
        .option(
            '--Localhost [boolean]',
            'Bind the player WebSocket and web server to loopback.',
            booleanValue,
            booleanValue(String(config.Localhost ?? false))
        )
        .option(
            '--PixelStreamingEncoderCodec <codec>',
            'UE encoder codec.',
            String(config.PixelStreamingEncoderCodec || 'VP9')
        )
        .option('--ResX <pixels>', 'UE render width.', String(config.ResX ?? 1920))
        .option('--ResY <pixels>', 'UE render height.', String(config.ResY ?? 1080))
        .option(
            '--SimulcastParameters <scale>',
            'Scale of the legacy SFU layer.',
            String(config.SimulcastParameters ?? 1)
        );
}

function buildArguments(options: IProgramOptions, streamerToken: string, streamerId?: string): string[] {
    const host = options.streamer_host as string;
    const address = !host || host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
    const url = new URL(
        `ws://${address.includes(':') ? '[' + address + ']' : address}:${options.streamer_port}`
    );
    if (streamerToken) url.searchParams.set('token', streamerToken);

    return [
        '-WINDOWED',
        '-AllowPixelStreamingCommands',
        '-ForceRes',
        `-ResX=${options.ResX}`,
        `-ResY=${options.ResY}`,
        '-PixelStreamingHideCursor',
        '-DisableWindowSizeLimit',
        '-SaveToUserDir',
        '-RenderOffScreen',
        // Both the original plugin and Pixel Streaming 2 accept the URL form, including a streamer token.
        `-PixelStreamingURL=${url.toString()}`,
        ...(streamerId ? [`-PixelStreamingID=${streamerId}`] : []),
        `-PixelStreamingEncoderCodec=${options.PixelStreamingEncoderCodec}`,
        // DasPixel configures one SFU layer. PS2 selects a single encoding with simulcast disabled.
        '-PixelStreamingEncoderEnableSimulcast=false',
        `-SimulcastParameters=${options.SimulcastParameters},0,1000000000`,
        '-PixelStreamingWebRTCDisableReceiveAudio',
        '-PixelStreamingWebRTCDisableTransmitAudio',
        '-PixelStreamingVPXUseCompute'
    ];
}

/** Manages the lifetimes of the UE applications launched by browser connections. */
export class UEProgramSessions {
    private players = new Set<string>();
    private running = new Map<string, ChildProcess>();
    // Keep children being stopped until 'close' so a concurrent server exit can still reap them.
    private children = new Set<ChildProcess>();

    constructor(
        private options: IProgramOptions,
        private streamerToken: string
    ) {}

    canSubscribe(playerId: string, streamer: IStreamer): boolean {
        if (this.options.UEProgram) return streamer.streamerId === this.sessionId(playerId);
        return !streamer.subscribers.size || streamer.subscribers.has(playerId);
    }

    private sessionId(playerId: string): string {
        return `PlayerStreamer-${playerId}-Session`;
    }

    connect(playerId: string): void {
        this.players.add(playerId);
        const key = this.options.MultiIProgress ? this.sessionId(playerId) : 'shared';
        if (this.running.has(key)) return;

        const args = buildArguments(
            this.options,
            this.streamerToken,
            this.options.MultiIProgress ? key : undefined
        );
        const executable = path.resolve(this.options.UEProgram as string);
        // With a token the engine may echo its command line, so keep its output out of server logs.
        let child: ChildProcess;
        try {
            child = spawn(executable, args, {
                windowsHide: true,
                stdio: this.streamerToken ? 'ignore' : ['ignore', 'pipe', 'pipe']
            });
        } catch (error) {
            Logger.error('Failed to start UE %s: %s', key, String(error));
            return;
        }
        this.running.set(key, child);
        this.children.add(child);
        child.stdout?.on('data', (data: Buffer) => Logger.debug('[UE %s] %s', key, data.toString().trim()));
        child.stderr?.on('data', (data: Buffer) => Logger.warn('[UE %s] %s', key, data.toString().trim()));
        child.once('spawn', () => Logger.info('Started UE %s, PID %s.', key, child.pid));
        child.on('error', (error) => Logger.error('UE %s: %s', key, error.message));
        child.once('close', (code, signal) => {
            Logger.info('UE %s closed (code %s, signal %s).', key, code, signal);
            this.children.delete(child);
            if (this.running.get(key) === child) this.running.delete(key);
        });
    }

    disconnect(playerId: string): void {
        if (!this.players.delete(playerId)) return;
        if (!this.options.MultiIProgress && this.players.size > 0) return;

        const key = this.options.MultiIProgress ? this.sessionId(playerId) : 'shared';
        const child = this.running.get(key);
        if (!child) return;
        this.running.delete(key);
        this.stop(child, false);
    }

    cleanup(): void {
        for (const child of this.children) this.stop(child, true);
    }

    private stop(child: ChildProcess, synchronous: boolean): void {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
        if (process.platform !== 'win32') {
            child.kill('SIGKILL');
            return;
        }
        // A Windows packaged game can spawn the actual binary below a bootstrap executable.
        const args = ['/PID', String(child.pid), '/T', '/F'];
        if (synchronous) {
            const result = spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore' });
            if (result.status !== 0) child.kill();
        } else {
            execFile('taskkill', args, { windowsHide: true }, (error) => {
                if (error && child.exitCode === null && child.signalCode === null) child.kill();
            });
        }
    }
}

export function attachUEProgramSessions(
    server: SignallingServer,
    options: IProgramOptions,
    streamerToken: string
): void {
    const sessions = new UEProgramSessions(options, streamerToken);
    if (options.MultiIProgress) server.config.canSubscribe = sessions.canSubscribe.bind(sessions);
    if (!options.UEProgram) return;
    if (String(options.SimulcastParameters) !== '1') {
        Logger.warn(
            'Pixel Streaming 2 uses fixed SFU layer scales; custom SimulcastParameters are passed to the legacy plugin.'
        );
    }

    server.playerRegistry.on('added', (id: string) => {
        if (server.playerRegistry.get(id) instanceof PlayerConnection) sessions.connect(id);
    });
    server.playerRegistry.on('removed', (id: string) => sessions.disconnect(id));

    // Node also emits 'exit' during an uncaught exception or fatal unhandled rejection.
    process.once('exit', () => sessions.cleanup());
    const shutdown = () => process.exit(0);
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    process.once('SIGHUP', shutdown);
    if (process.platform === 'win32') process.once('SIGBREAK', shutdown);
}
