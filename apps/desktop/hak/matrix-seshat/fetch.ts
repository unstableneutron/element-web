/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import fsProm from "node:fs/promises";
import path from "node:path";

import type HakEnv from "../../scripts/hak/hakEnv.ts";
import type { DependencyInfo } from "../../scripts/hak/dep.ts";
import defaultFetch from "../../scripts/hak/fetch.ts";

const SESHAT_REPOSITORY = "https://github.com/unstableneutron/seshat.git";
const SESHAT_REVISION = "ff658479958d75f2331970e9ea548aad516bf59a";
const PATCH_START = "# BEGIN ELEMENT PERFORMANCE SESHAT PATCH";
const PATCH_END = "# END ELEMENT PERFORMANCE SESHAT PATCH";

function seshatPatch(): string {
    return [
        PATCH_START,
        "[patch.crates-io]",
        `seshat = { git = "${SESHAT_REPOSITORY}", rev = "${SESHAT_REVISION}" }`,
        PATCH_END,
    ].join("\n");
}

/**
 * Fetch the released matrix-seshat Node wrapper, then pin its Rust `seshat`
 * crate to our reviewed performance branch. Keeping the JavaScript wrapper at
 * the upstream release avoids maintaining a fork of the npm packaging while
 * making the native Rust source reproducible by full commit hash.
 */
export default async function (hakEnv: HakEnv, moduleInfo: DependencyInfo): Promise<void> {
    await defaultFetch(hakEnv, moduleInfo);

    const cargoTomlPath = path.join(moduleInfo.moduleBuildDir, "Cargo.toml");
    let cargoToml = await fsProm.readFile(cargoTomlPath, "utf8");
    const patch = seshatPatch();

    if (cargoToml.includes(PATCH_START)) {
        const start = cargoToml.indexOf(PATCH_START);
        const end = cargoToml.indexOf(PATCH_END, start);
        if (end === -1) {
            throw new Error(`Malformed Seshat source patch in ${cargoTomlPath}`);
        }
        cargoToml = `${cargoToml.slice(0, start)}${patch}${cargoToml.slice(end + PATCH_END.length)}`;
    } else {
        cargoToml = `${cargoToml.trimEnd()}\n\n${patch}\n`;
    }

    await fsProm.writeFile(cargoTomlPath, cargoToml, "utf8");
}
