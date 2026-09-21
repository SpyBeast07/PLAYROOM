import { describe, expect, test } from "bun:test";
import { RoomError, type RoomErrorCode, RoomManager } from "./room-manager.ts";
import { toPublicRoom } from "./types.ts";

function makeManager(): RoomManager {
  return new RoomManager();
}

function expectError<T>(fn: () => T, code: RoomErrorCode): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(RoomError);
  expect((thrown as RoomError).code).toBe(code);
}

describe("RoomManager domain rules", () => {
  test("creates a room with a unique 6-char uppercase alphanumeric code and derives a player", () => {
    const manager = makeManager();
    const room = manager.createRoom();
    expect(room.code).toMatch(/^[A-Z0-9]{6}$/);

    const seen = new Set<string>([room.code]);
    for (let i = 0; i < 500; i++) {
      const r = manager.createRoom();
      expect(seen.has(r.code)).toBe(false);
      seen.add(r.code);
    }

    const player = manager.addPlayer(room.code, "Kush");
    expect(player.name).toBe("Kush");
    expect(player.isHost).toBe(true);
    expect(typeof player.id).toBe("string");
    expect(player.id).not.toBe("");
  });

  test("player name is trimmed; whitespace-only or too long names are rejected", () => {
    const manager = makeManager();
    const room = manager.createRoom();

    expectError(() => manager.addPlayer(room.code, ""), "INVALID_PLAYER_NAME");
    expectError(() => manager.addPlayer(room.code, "     "), "INVALID_PLAYER_NAME");
    expectError(() => manager.addPlayer(room.code, "\t\n"), "INVALID_PLAYER_NAME");
    expectError(() => manager.addPlayer(room.code, "012345678901234567890"), "INVALID_PLAYER_NAME");
    expectError(() => manager.addPlayer(room.code, "y".repeat(21)), "INVALID_PLAYER_NAME");

    const player = manager.addPlayer(room.code, "   Alice   ");
    expect(player.name).toBe("Alice");
  });

  test("20-character name is accepted; 21 is not", () => {
    const manager = makeManager();
    const room = manager.createRoom();
    const ok = manager.addPlayer(room.code, "x".repeat(20));
    expect(ok.name).toBe("x".repeat(20));
    expectError(() => manager.addPlayer(room.code, "y".repeat(21)), "INVALID_PLAYER_NAME");
  });

  test("join only allowed while waiting; ROOM_STARTED is thrown when the room has started", () => {
    const manager = makeManager();
    const room = manager.createRoom();
    manager.addPlayer(room.code, "Alice");

    // Mutate internal status to simulate a start that has no HTTP endpoint yet.
    room.status = "playing";
    expectError(() => manager.addPlayer(room.code, "Bob"), "ROOM_STARTED");
  });

  test("unknown room throws ROOM_NOT_FOUND on join", () => {
    const manager = makeManager();
    expectError(() => manager.addPlayer("ZZZZZZ", "A"), "ROOM_NOT_FOUND");
  });

  test("max room size is enforced", () => {
    const manager = makeManager();
    const room = manager.createRoom();
    for (let i = 1; i <= 20; i++) {
      manager.addPlayer(room.code, `P${i}`);
    }
    expect(room.status).toBe("waiting");

    expectError(() => manager.addPlayer(room.code, "P21"), "ROOM_FULL");
    expect(manager.getRoomByCode(room.code)?.players.length).toBe(20);
  });

  test("duplicate player names allowed; ids differ", () => {
    const manager = makeManager();
    const room = manager.createRoom();
    const a = manager.addPlayer(room.code, "Alice");
    const b = manager.addPlayer(room.code, "Alice");
    expect(a.id).not.toBe(b.id);
    expect(room.players.filter((p) => p.name === "Alice").length).toBe(2);
  });

  test("host is assigned to the first player and transferred on removal of the host", () => {
    const manager = makeManager();
    const room = manager.createRoom();
    const first = manager.addPlayer(room.code, "A");
    const second = manager.addPlayer(room.code, "B");
    const third = manager.addPlayer(room.code, "C");

    expect(first.isHost).toBe(true);
    expect(second.isHost).toBe(false);
    expect(third.isHost).toBe(false);

    manager.removePlayer(room.code, first.id);
    expect(room.players.map((p) => ({ id: p.id, isHost: p.isHost }))).toEqual([
      { id: second.id, isHost: true },
      { id: third.id, isHost: false },
    ]);

    manager.removePlayer(room.code, second.id);
    expect(room.players.map((p) => p.id)).toEqual([third.id]);
    expect(room.players[0]?.isHost).toBe(true);

    manager.removePlayer(room.code, third.id);
    expect(manager.getRoomByCode(room.code)).toBeUndefined();
  });

  test("removing a non-host does not change host", () => {
    const manager = makeManager();
    const room = manager.createRoom();
    const first = manager.addPlayer(room.code, "A");
    const second = manager.addPlayer(room.code, "B");
    manager.removePlayer(room.code, second.id);
    expect(manager.getRoomByCode(room.code)?.players[0]?.id).toBe(first.id);
    expect(first.isHost).toBe(true);
  });

  test("removing the final player deletes the room", () => {
    const manager = makeManager();
    const room = manager.createRoom();
    const player = manager.addPlayer(room.code, "A");
    expect(manager.getRoomByCode(room.code)).toBeDefined();
    manager.removePlayer(room.code, player.id);
    expect(manager.getRoomByCode(room.code)).toBeUndefined();
  });

  test("code lookup is case-insensitive and trims whitespace", () => {
    const manager = makeManager();
    const room = manager.createRoom();
    const lower = room.code.toLowerCase();
    const player = manager.addPlayer(room.code, "A");
    expect(manager.getRoomByCode(lower)?.code).toBe(room.code);
    expect(manager.getRoomByCode(`  ${lower}  `)?.code).toBe(room.code);
    expect(manager.getRoomByCode(lower)?.players[0]?.id).toBe(player.id);
  });

  test("unknown room/player errors carry the correct codes", () => {
    const manager = makeManager();
    const room = manager.createRoom();
    const player = manager.addPlayer(room.code, "A");

    expect(manager.getRoomByCode("ZZZZZZ")).toBeUndefined();
    expectError(() => manager.removePlayer("ZZZZZZ", player.id), "ROOM_NOT_FOUND");
    expectError(() => manager.removePlayer(room.code, "nope"), "PLAYER_NOT_FOUND");
  });

  test("public state omits internal room id and player joinedAt", () => {
    const manager = makeManager();
    const room = manager.createRoom();
    manager.addPlayer(room.code, "A");
    const publicRoom = toPublicRoom(room);
    expect(Object.keys(publicRoom).sort()).toEqual(["code", "createdAt", "players", "status"]);
    expect(publicRoom).not.toHaveProperty("id");
    for (const player of publicRoom.players) {
      expect(Object.keys(player).sort()).toEqual(["id", "isHost", "name"]);
      expect(player).not.toHaveProperty("joinedAt");
    }
  });
});