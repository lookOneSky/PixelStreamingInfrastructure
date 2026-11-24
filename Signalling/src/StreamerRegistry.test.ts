// Copyright Epic Games, Inc. All Rights Reserved.
import type WebSocket from 'ws';
import { Messages } from '@epicgames-ps/lib-pixelstreamingcommon-ue5.8';
import { StreamerConnection } from './StreamerConnection';
import { StreamerRegistry } from './StreamerRegistry';
import { SignallingServer } from './SignallingServer';

// A streamer the registry can add and talk to, with no socket behind it.
function unconnectedStreamer(): StreamerConnection {
    return new StreamerConnection({} as unknown as SignallingServer, {} as unknown as WebSocket);
}

describe('StreamerRegistry endpointId handling', () => {
    it('keeps a repeated endpoint id stable and disambiguates collisions on ids ending in digits', () => {
        const registry = new StreamerRegistry();
        const first = unconnectedStreamer();
        const second = unconnectedStreamer();
        registry.add(first);
        registry.add(second);
        const identify = { type: Messages.endpointId.typeName, id: 'stream42' };
        first.protocol.emit(Messages.endpointId.typeName, identify);
        first.protocol.emit(Messages.endpointId.typeName, identify);
        second.protocol.emit(Messages.endpointId.typeName, identify);

        expect(first.streamerId).toBe('stream42');
        expect(second.streamerId).toBe('stream421');
        registry.remove(first);
        expect(registry.find('stream42')).toBeUndefined();
        expect(registry.find('stream421')).toBe(second);
    });

    it('treats a non-string id as no id, so a later registration still works', () => {
        const registry = new StreamerRegistry();
        const first = unconnectedStreamer();
        registry.add(first);

        // The id arrives as any JSON value; a number here used to be stored as the streamer id.
        first.protocol.emit(Messages.endpointId.typeName, { type: Messages.endpointId.typeName, id: 5 });
        expect(typeof first.streamerId).toBe('string');

        const second = unconnectedStreamer();
        expect(() => registry.add(second)).not.toThrow();
        expect(second.streamerId).not.toBe(first.streamerId);
    });
});
