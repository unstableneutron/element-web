/*
Copyright 2025 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, afterEach, type Mocked } from "vitest";
import {
    Direction,
    type MatrixClient,
    type IEvent,
    MatrixEvent,
    type Room,
    ClientEvent,
    RoomEvent,
    SyncState,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";

import EventIndex from "./EventIndex.ts";
import {
    emitPromise,
    getMockClientWithEventEmitter,
    mockClientMethodsRooms,
    mockPlatformPeg,
} from "../../test/test-utils";
import type BaseEventIndexManager from "./BaseEventIndexManager.ts";
import { type ICrawlerCheckpoint } from "./BaseEventIndexManager.ts";
import SettingsStore from "../settings/SettingsStore.ts";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("EventIndex", () => {
    it("crawls through the loaded checkpoints", async () => {
        const mockIndexingManager = {
            loadCheckpoints: vi.fn(),
            removeCrawlerCheckpoint: vi.fn(),
            isEventIndexEmpty: vi.fn().mockResolvedValue(false),
        } as any as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

        const room1 = { roomId: "!room1:id" } as any as Room;
        const room2 = { roomId: "!room2:id" } as any as Room;
        const mockClient = getMockClientWithEventEmitter({
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn(),
            ...mockClientMethodsRooms([room1, room2]),
        });

        vi.spyOn(SettingsStore, "getValueAt").mockImplementation((_level, settingName): any => {
            if (settingName === "crawlerSleepTime") return 0;
            return undefined;
        });

        mockIndexingManager.loadCheckpoints.mockResolvedValue([
            { roomId: "!room1:id", token: "token1", direction: Direction.Backward } as ICrawlerCheckpoint,
            { roomId: "!room2:id", token: "token2", direction: Direction.Forward } as ICrawlerCheckpoint,
        ]);

        const indexer = new EventIndex();
        await indexer.init();
        let changedCheckpointPromise = emitPromise(indexer, "changedCheckpoint") as Promise<Room>;

        indexer.startCrawler();

        // Mock out the /messags request, and wait for the crawler to hit the first room
        const mock1 = mockCreateMessagesRequest(mockClient);
        let changedCheckpoint = await changedCheckpointPromise;
        expect(changedCheckpoint.roomId).toEqual("!room1:id");

        await mock1.called;
        expect(mockClient.createMessagesRequest).toHaveBeenCalledWith("!room1:id", "token1", 100, "b");

        // Continue, and wait for the crawler to hit the second room
        changedCheckpointPromise = emitPromise(indexer, "changedCheckpoint") as Promise<Room>;
        mock1.resolve({ chunk: [] });
        changedCheckpoint = await changedCheckpointPromise;
        expect(changedCheckpoint.roomId).toEqual("!room2:id");

        // Mock out the /messages request again, and wait for it to be called
        const mock2 = mockCreateMessagesRequest(mockClient);
        await mock2.called;
        expect(mockClient.createMessagesRequest).toHaveBeenCalledWith("!room2:id", "token2", 100, "f");
    });

    it("adds checkpoints for the encrypted rooms after the first sync", async () => {
        const mockIndexingManager = {
            loadCheckpoints: vi.fn().mockResolvedValue([]),
            isEventIndexEmpty: vi.fn().mockResolvedValue(true),
            addCrawlerCheckpoint: vi.fn(),
            removeCrawlerCheckpoint: vi.fn(),
            commitLiveEvents: vi.fn(),
        } as any as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

        const room1 = {
            roomId: "!room1:id",
            getMyMembership: () => KnownMembership.Join,
            getLiveTimeline: () => ({
                getPaginationToken: () => "token1",
            }),
        } as any as Room;
        const room2 = {
            roomId: "!room2:id",
            getMyMembership: () => KnownMembership.Join,
            getLiveTimeline: () => ({
                getPaginationToken: () => "token2",
            }),
        } as any as Room;
        const mockCrypto = {
            isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true),
        };
        const mockClient = getMockClientWithEventEmitter({
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn(),
            getCrypto: () => mockCrypto as any,
            ...mockClientMethodsRooms([room1, room2]),
        });

        const commitLiveEventsCalled = Promise.withResolvers<void>();
        mockIndexingManager.commitLiveEvents.mockImplementation(async () => {
            commitLiveEventsCalled.resolve();
        });

        const indexer = new EventIndex();
        await indexer.init();

        // During the first sync, some events are added to the index, meaning that `isEventIndexEmpty` will now be false.
        mockIndexingManager.isEventIndexEmpty.mockResolvedValue(false);

        // The first sync completes:
        mockClient.emit(ClientEvent.Sync, SyncState.Syncing, null, {});

        // Wait for `commitLiveEvents` to be called, by which time the checkpoints should have been added.
        await commitLiveEventsCalled.promise;
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledTimes(4);
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledWith({
            roomId: "!room1:id",
            token: "token1",
            direction: Direction.Backward,
            fullCrawl: true,
        });
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledWith({
            roomId: "!room1:id",
            token: "token1",
            direction: Direction.Forward,
        });
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledWith({
            roomId: "!room2:id",
            token: "token2",
            direction: Direction.Backward,
            fullCrawl: true,
        });
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledWith({
            roomId: "!room2:id",
            token: "token2",
            direction: Direction.Forward,
        });
    });

    it("reconciles joined encrypted rooms missed by initial checkpointing", async () => {
        const mockIndexingManager = {
            loadCheckpoints: vi.fn().mockResolvedValue([]),
            isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            isRoomIndexed: vi.fn().mockResolvedValue(false),
            addCrawlerCheckpoint: vi.fn().mockResolvedValue(undefined),
        } as any as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

        const room = {
            roomId: "!missed:id",
            getMyMembership: () => KnownMembership.Join,
            getLiveTimeline: () => ({
                getPaginationToken: () => "missed-token",
            }),
        } as any as Room;
        const mockCrypto = {
            isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true),
        };
        getMockClientWithEventEmitter({
            getCrypto: () => mockCrypto as any,
            ...mockClientMethodsRooms([room]),
            isRoomEncrypted: vi.fn().mockReturnValue(true),
        });

        const indexer = new EventIndex();
        await indexer.init();
        await indexer.reconcileMissedRooms();

        expect(mockIndexingManager.isRoomIndexed).toHaveBeenCalledWith(room.roomId);
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledOnce();
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledWith({
            roomId: room.roomId,
            token: "missed-token",
            direction: Direction.Backward,
            fullCrawl: true,
        });
    });

    it("does not reconcile rooms carrying a persisted fully-crawled marker", async () => {
        const mockIndexingManager = {
            loadCheckpoints: vi.fn().mockResolvedValue([
                {
                    roomId: "!complete:id",
                    token: "fully_crawled",
                    direction: Direction.Backward,
                    fullCrawl: true,
                },
            ]),
            isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            isRoomIndexed: vi.fn().mockResolvedValue(false),
            addCrawlerCheckpoint: vi.fn().mockResolvedValue(undefined),
        } as any as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

        const room = {
            roomId: "!complete:id",
            getMyMembership: () => KnownMembership.Join,
            getLiveTimeline: () => ({
                getPaginationToken: () => "old-token",
            }),
        } as any as Room;
        const mockCrypto = {
            isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true),
        };
        getMockClientWithEventEmitter({
            getCrypto: () => mockCrypto as any,
            ...mockClientMethodsRooms([room]),
            isRoomEncrypted: vi.fn().mockReturnValue(true),
        });

        const indexer = new EventIndex();
        await indexer.init();
        await indexer.reconcileMissedRooms();

        expect(mockIndexingManager.isRoomIndexed).not.toHaveBeenCalled();
        expect(mockIndexingManager.addCrawlerCheckpoint).not.toHaveBeenCalled();
    });

    it("persists a fully-crawled marker after reaching the start of room history", async () => {
        const checkpoint: ICrawlerCheckpoint = {
            roomId: "!complete:id",
            token: "old-token",
            direction: Direction.Backward,
            fullCrawl: true,
        };
        const markerPersisted = Promise.withResolvers<void>();
        const mockIndexingManager = {
            loadCheckpoints: vi.fn().mockResolvedValue([checkpoint]),
            isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            addHistoricEvents: vi.fn().mockImplementation(async () => {
                markerPersisted.resolve();
            }),
        } as any as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

        const room = { roomId: checkpoint.roomId } as Room;
        const mockClient = getMockClientWithEventEmitter({
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn().mockResolvedValue({ chunk: [] }),
            ...mockClientMethodsRooms([room]),
        });
        vi.spyOn(SettingsStore, "getValueAt").mockReturnValue(0);

        const indexer = new EventIndex();
        await indexer.init();
        indexer.startCrawler();
        await markerPersisted.promise;
        indexer.stopCrawler();

        expect(mockClient.createMessagesRequest).toHaveBeenCalledWith(
            checkpoint.roomId,
            checkpoint.token,
            100,
            Direction.Backward,
        );
        expect(mockIndexingManager.addHistoricEvents).toHaveBeenCalledWith(
            [],
            {
                roomId: checkpoint.roomId,
                token: "fully_crawled",
                direction: Direction.Backward,
                fullCrawl: true,
            },
            checkpoint,
        );
    });

    it("flushes pending live events before searching", async () => {
        const calls: string[] = [];
        const mockIndexingManager = {
            commitLiveEvents: vi.fn().mockImplementation(async () => {
                calls.push("commit");
            }),
            searchEventIndex: vi.fn().mockImplementation(async () => {
                calls.push("search");
                return { results: [], highlights: [] };
            }),
        } as any as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

        const indexer = new EventIndex();
        await indexer.search({ searchTerm: "needle" } as any);

        expect(calls).toEqual(["commit", "search"]);
    });

    it("deduplicates identical checkpoints while the first database write is in flight", async () => {
        const checkpointWriteStarted = Promise.withResolvers<void>();
        const releaseCheckpointWrite = Promise.withResolvers<void>();
        const mockIndexingManager = {
            loadCheckpoints: vi.fn().mockResolvedValue([]),
            isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            addCrawlerCheckpoint: vi.fn().mockImplementation(async () => {
                checkpointWriteStarted.resolve();
                await releaseCheckpointWrite.promise;
            }),
        } as any as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

        const liveTimelineSet = { id: "live" };
        const room = {
            roomId: "!room1:id",
            getUnfilteredTimelineSet: () => liveTimelineSet,
            getLiveTimeline: () => ({ getPaginationToken: () => "token1" }),
        } as any as Room;
        const mockCrypto = { isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true) };
        getMockClientWithEventEmitter({
            getCrypto: () => mockCrypto as any,
            ...mockClientMethodsRooms([room]),
            isRoomEncrypted: vi.fn().mockReturnValue(true),
        });

        const indexer = new EventIndex();
        await indexer.init();

        const onTimelineReset = (indexer as any).onTimelineReset as (
            room: Room,
            timelineSet: typeof liveTimelineSet,
        ) => Promise<void>;
        const firstReset = onTimelineReset(room, liveTimelineSet);
        await checkpointWriteStarted.promise;
        await onTimelineReset(room, liveTimelineSet);

        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledOnce();

        releaseCheckpointWrite.resolve();
        await firstReset;
    });

    it("only seeds a gap-fill on the room's own live timeline reset, not thread/filtered resets", async () => {
        const mockIndexingManager = {
            loadCheckpoints: vi.fn().mockResolvedValue([]),
            isEventIndexEmpty: vi.fn().mockResolvedValue(false),
            addCrawlerCheckpoint: vi.fn().mockResolvedValue(undefined),
            removeCrawlerCheckpoint: vi.fn(),
        } as any as Mocked<BaseEventIndexManager>;
        mockPlatformPeg({ getEventIndexingManager: () => mockIndexingManager });

        // The room's main (unfiltered) timeline set vs. a thread's timeline set. The
        // SDK re-emits RoomEvent.TimelineReset from both, but only the former is a
        // genuine history gap; thread resets (e.g. Thread.updateThreadMetadata on
        // startup) must be ignored.
        const liveTimelineSet = { id: "live" };
        const threadTimelineSet = { id: "thread" };
        const room = {
            roomId: "!room1:id",
            getMyMembership: () => KnownMembership.Join,
            getUnfilteredTimelineSet: () => liveTimelineSet,
            getLiveTimeline: () => ({ getPaginationToken: () => "token1" }),
        } as any as Room;

        const mockCrypto = { isEncryptionEnabledInRoom: vi.fn().mockResolvedValue(true) };
        const mockClient = getMockClientWithEventEmitter({
            getEventMapper: () => (obj: Partial<IEvent>) => new MatrixEvent(obj),
            createMessagesRequest: vi.fn(),
            getCrypto: () => mockCrypto as any,
            ...mockClientMethodsRooms([room]),
            isRoomEncrypted: () => true,
        });

        const indexer = new EventIndex();
        await indexer.init();

        // A thread (non-unfiltered) timeline reset must be ignored - no checkpoint.
        mockClient.emit(RoomEvent.TimelineReset, room, threadTimelineSet as any);
        // Let the async handler run to completion (it bails synchronously, but flush
        // microtasks to be sure nothing is seeded on a later tick).
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(mockIndexingManager.addCrawlerCheckpoint).not.toHaveBeenCalled();

        // A reset of the room's own live timeline is a real gap - seed a gap-fill.
        const added = Promise.withResolvers<void>();
        mockIndexingManager.addCrawlerCheckpoint.mockImplementation(async () => {
            added.resolve();
        });
        mockClient.emit(RoomEvent.TimelineReset, room, liveTimelineSet as any);
        await added.promise;
        expect(mockIndexingManager.addCrawlerCheckpoint).toHaveBeenCalledWith({
            roomId: "!room1:id",
            token: "token1",
            direction: Direction.Backward,
            fullCrawl: false,
        });
    });
});

/**
 * Mock out the `createMessagesRequest` method on the client, with an implementation that will block until a resolver is called.
 *
 * @returns An object with the following properties:
 *  * `called`: A promise that resolves when `createMessagesRequest` is called.
 *  * `resolve`: A function that can be called to allow `createMessagesRequest` to complete.
 */
function mockCreateMessagesRequest(mockClient: Mocked<MatrixClient>): {
    called: Promise<void>;
    resolve: (result: any) => void;
} {
    const messagesCalledPromise = Promise.withResolvers<void>();
    const messagesResultPromise = Promise.withResolvers();
    mockClient.createMessagesRequest.mockImplementationOnce(() => {
        messagesCalledPromise.resolve();
        return messagesResultPromise.promise as any;
    });
    return {
        called: messagesCalledPromise.promise,
        resolve: messagesResultPromise.resolve,
    };
}
