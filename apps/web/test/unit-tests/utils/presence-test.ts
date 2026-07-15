/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import SdkConfig from "../../../src/SdkConfig";
import { isPresenceEnabled } from "../../../src/utils/presence";

describe("isPresenceEnabled", () => {
    const client = { baseUrl: "https://matrix.example.org" } as MatrixClient;

    afterEach(() => {
        SdkConfig.reset();
    });

    it("defaults to enabled without configuration", () => {
        SdkConfig.put({});
        expect(isPresenceEnabled(client)).toBe(true);
    });

    it("uses the wildcard default for unlisted homeservers", () => {
        SdkConfig.put({ enable_presence_by_hs_url: { "*": false } });
        expect(isPresenceEnabled(client)).toBe(false);
    });

    it("lets an exact homeserver override the wildcard", () => {
        SdkConfig.put({
            enable_presence_by_hs_url: {
                "*": false,
                "https://matrix.example.org": true,
            },
        });
        expect(isPresenceEnabled(client)).toBe(true);
    });
});
