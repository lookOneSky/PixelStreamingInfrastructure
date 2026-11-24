// Copyright Epic Games, Inc. All Rights Reserved.
import { ChildProcess, execFile, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { IStreamer } from '@epicgames-ps/lib-pixelstreamingsignalling-ue5.8';
import { UEProgramSessions } from './ueProgram';

jest.mock('child_process', () => ({ execFile: jest.fn(), spawn: jest.fn() }));
jest.mock('@epicgames-ps/lib-pixelstreamingsignalling-ue5.8', () => ({ Logger: { info: jest.fn() } }));

const options = {
    UEProgram: 'game.exe',
    streamer_host: '',
    streamer_port: 8888,
    PixelStreamingEncoderCodec: 'VP9',
    ResX: 1920,
    ResY: 1080,
    SimulcastParameters: 1
};
function newChild(): ChildProcess {
    const child = Object.assign(new EventEmitter(), {
        pid: 100,
        exitCode: null,
        signalCode: null,
        kill: jest.fn()
    });
    return child as unknown as ChildProcess;
}

beforeEach(() => jest.clearAllMocks());

it('shares one UE until the last browser leaves, even when the first browser disconnects twice', () => {
    const child = newChild();
    jest.mocked(spawn).mockReturnValue(child);
    const sessions = new UEProgramSessions({ ...options, MultiIProgress: false }, '');
    sessions.connect('first');
    sessions.connect('second');
    sessions.disconnect('first');
    sessions.disconnect('first');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(execFile).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    sessions.disconnect('second');
    if (process.platform === 'win32') {
        expect(execFile).toHaveBeenCalledWith(
            'taskkill',
            ['/PID', '100', '/T', '/F'],
            { windowsHide: true },
            expect.any(Function)
        );
    } else {
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    }
});

it('launches separate streamers and restricts players to their own id', () => {
    jest.mocked(spawn).mockImplementation(newChild);
    const sessions = new UEProgramSessions({ ...options, MultiIProgress: true }, 'token with space');
    sessions.connect('first');
    sessions.connect('second');
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(jest.mocked(spawn).mock.calls[0][1]).toEqual(
        expect.arrayContaining([
            '-PixelStreamingURL=ws://127.0.0.1:8888/?token=token+with+space',
            '-PixelStreamingID=PlayerStreamer-first-Session',
            '-PixelStreamingEncoderCodec=VP9'
        ])
    );
    const first = { streamerId: 'PlayerStreamer-first-Session' } as IStreamer;
    expect(sessions.canSubscribe('first', first)).toBe(true);
    expect(sessions.canSubscribe('second', first)).toBe(false);
});

it('offers externally managed streamers to one player at a time in multi-instance mode', () => {
    const sessions = new UEProgramSessions({ ...options, UEProgram: '', MultiIProgress: true }, '');
    const streamer = { subscribers: new Set(['first']) } as IStreamer;
    expect(sessions.canSubscribe('first', streamer)).toBe(true);
    expect(sessions.canSubscribe('second', streamer)).toBe(false);
    streamer.subscribers.clear();
    expect(sessions.canSubscribe('second', streamer)).toBe(true);
});
