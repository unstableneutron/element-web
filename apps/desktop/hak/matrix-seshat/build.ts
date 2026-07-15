/*
Copyright 2024 New Vector Ltd.
Copyright 2020, 2021 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import fsProm from "node:fs/promises";
import path from "node:path";

import type HakEnv from "../../scripts/hak/hakEnv.ts";
import type { DependencyInfo } from "../../scripts/hak/dep.ts";

const SESHAT_REPOSITORY = "https://github.com/unstableneutron/seshat.git";
const SESHAT_REVISION = "ff658479958d75f2331970e9ea548aad516bf59a";
const PATCH_START = "# BEGIN ELEMENTPLUS SESHAT PATCH";
const PATCH_END = "# END ELEMENTPLUS SESHAT PATCH";

function seshatPatch(): string {
    return [
        PATCH_START,
        "[patch.crates-io]",
        `seshat = { git = "${SESHAT_REPOSITORY}", rev = "${SESHAT_REVISION}" }`,
        PATCH_END,
    ].join("\n");
}

async function pinSeshatSource(moduleInfo: DependencyInfo): Promise<void> {
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

    const verifiedCargoToml = await fsProm.readFile(cargoTomlPath, "utf8");
    if (!verifiedCargoToml.includes(SESHAT_REVISION)) {
        throw new Error(`Failed to pin Seshat revision in ${cargoTomlPath}`);
    }
}

export default async function (hakEnv: HakEnv, moduleInfo: DependencyInfo): Promise<void> {
    // Hak's fetch command does not dispatch module-specific fetch hooks, so pin
    // the Rust crate here immediately before Cargo builds the native wrapper.
    await pinSeshatSource(moduleInfo);

    const env = hakEnv.makeGypEnv();
    // Use the system Git client for the fork dependency so Cargo honors SSH
    // host aliases and URL rewrites from the developer's Git configuration.
    env.CARGO_NET_GIT_FETCH_WITH_CLI = "true";

    if (!hakEnv.isHost()) {
        env.CARGO_BUILD_TARGET = hakEnv.getTargetId();
    }

    // Seshat encrypts its index with AES-256 from the RustCrypto `aes` crate.
    // On aarch64 that crate only uses the ARMv8 hardware AES backend when built
    // with `--cfg aes_armv8`; without it, it falls back to a constant-time
    // software implementation that uses ~10-20x more CPU. (On x86_64, AES-NI is
    // auto-detected at runtime, so no flag is needed there.) Append rather than
    // overwrite so any caller-provided RUSTFLAGS are preserved.
    if (hakEnv.getTargetArch() === "arm64") {
        env.RUSTFLAGS = [env.RUSTFLAGS, "--cfg aes_armv8"].filter(Boolean).join(" ");
    }

    console.log("Running yarn install");
    await hakEnv.spawn("yarn", ["install"], {
        cwd: moduleInfo.moduleBuildDir,
        env,
        shell: true,
    });

    const buildTarget = hakEnv.wantsStaticSqlCipher() ? "build-bundled" : "build";

    console.log("Running yarn build");
    await hakEnv.spawn("yarn", ["run", buildTarget], {
        cwd: moduleInfo.moduleBuildDir,
        env,
        shell: true,
    });
}
