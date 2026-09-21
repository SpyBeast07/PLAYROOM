import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Player, Room, RoomStatus } from "./types.ts";

const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const MAX_ROOM_SIZE = 20;
const MAX_PLAYER_NAME_LENGTH = 20;

export class RoomError extends Error {
  readonly statusCode: ContentfulStatusCode;

  constructor(statusCode: ContentfulStatusCode, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class RoomManager {
  private readonly roomsByCode = new Map<string, Room>();

  createRoom(): Room {
    const code = this.generateUniqueCode();
    const room: Room = {
      id: crypto.randomUUID(),
      code,
      status: "waiting" satisfies RoomStatus,
      players: [],
      createdAt: Date.now(),
    };
    this.roomsByCode.set(code, room);
    return room;
  }

  getRoomByCode(roomCode: string): Room | undefined {
    return this.roomsByCode.get(this.normalizeCode(roomCode));
  }

  addPlayer(roomCode: string, name: string): Player {
    const code = this.normalizeCode(roomCode);
    const room = this.roomsByCode.get(code);
    if (!room) throw new RoomError(404, "Room not found");
    if (room.status !== "waiting") throw new RoomError(409, "Room already started");
    if (room.players.length >= MAX_ROOM_SIZE) throw new RoomError(409, "Room full");

    const trimmedName = name.trim();
    if (trimmedName.length < 1 || trimmedName.length > MAX_PLAYER_NAME_LENGTH) {
      throw new RoomError(400, "Invalid player name");
    }

    const player: Player = {
      id: crypto.randomUUID(),
      name: trimmedName,
      joinedAt: Date.now(),
      isHost: room.players.length === 0,
    };
    room.players.push(player);
    return player;
  }

  removePlayer(roomCode: string, playerId: string): void {
    const code = this.normalizeCode(roomCode);
    const room = this.roomsByCode.get(code);
    if (!room) throw new RoomError(404, "Room not found");

    const index = room.players.findIndex((player) => player.id === playerId);
    if (index === -1) throw new RoomError(404, "Player not found");

    const removed = room.players.splice(index, 1)[0];
    if (removed !== undefined && removed.isHost && room.players.length > 0) {
      const nextHost = room.players[0];
      if (nextHost !== undefined) nextHost.isHost = true;
    }

    if (room.players.length === 0) {
      this.roomsByCode.delete(code);
    }
  }

  private generateUniqueCode(): string {
    let code = this.generateCode();
    while (this.roomsByCode.has(code)) {
      code = this.generateCode();
    }
    return code;
  }

  private generateCode(): string {
    let code = "";
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      const byte = crypto.getRandomValues(new Uint8Array(1))[0] ?? 0;
      code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length] ?? "";
    }
    return code;
  }

  private normalizeCode(roomCode: string): string {
    return roomCode.trim().toUpperCase();
  }
}