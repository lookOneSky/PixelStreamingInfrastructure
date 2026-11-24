// Copyright Epic Games, Inc. All Rights Reserved.

import { Config, Flags } from '../Config/Config';
import { mockRTCRtpReceiver, unmockRTCRtpReceiver } from '../__test__/mockRTCRtpReceiver';
import { StreamMessageController } from '../UeInstanceMessage/StreamMessageController';
import { ActiveKeys } from './InputClassesFactory';
import { KeyboardController } from './KeyboardController';

describe('KeyboardController', () => {
    const sendKey = jest.fn();
    const messages = new StreamMessageController();
    messages.toStreamerHandlers.set('KeyDown', sendKey);
    messages.toStreamerHandlers.set('KeyUp', sendKey);
    messages.toStreamerHandlers.set('KeyPress', sendKey);

    beforeAll(mockRTCRtpReceiver);
    afterAll(unmockRTCRtpReceiver);

    it.each([true, false])('keeps F1–F12 local with SuppressBrowserKeys=%s', (suppressBrowserKeys) => {
        const config = new Config({ initialSettings: { [Flags.SuppressBrowserKeys]: suppressBrowserKeys } });
        const activeKeys = new ActiveKeys();
        const keyboard = new KeyboardController(messages, config, activeKeys);
        sendKey.mockClear();

        for (let i = 1; i <= 12; i++) {
            const init = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i, cancelable: true };
            const down = new KeyboardEvent('keydown', init);
            const up = new KeyboardEvent('keyup', init);
            keyboard.onKeyDownListener(down);
            keyboard.onKeyPressListener(new KeyboardEvent('keypress', init));
            keyboard.onKeyUpListener(up);
            expect(down.defaultPrevented).toBe(suppressBrowserKeys);
            expect(up.defaultPrevented).toBe(suppressBrowserKeys);
        }

        expect(sendKey).not.toHaveBeenCalled();
        expect(activeKeys.getActiveKeys()).toEqual([]);
    });

    it('forwards printable characters whose charCode overlaps a function key', () => {
        const keyboard = new KeyboardController(messages, new Config({}), new ActiveKeys());
        sendKey.mockClear();
        keyboard.onKeyPressListener(
            new KeyboardEvent('keypress', { code: 'KeyP', key: 'p', charCode: 112, keyCode: 112 })
        );
        expect(sendKey).toHaveBeenCalledWith([112]);
    });
});
