import { toPublicRoom, type Room } from "../rooms/types.ts";
import type { Connection, ServerMessage } from "./types.ts";

const OPEN_READY_STATE = 1;

export class ConnectionManager {
  private readonly connections = new Map<string, Connection>();

  add(connection: Connection): void {
    this.connections.set(connection.connectionId, connection);
  }

  remove(connectionId: string): void {
    this.connections.delete(connectionId);
  }

  broadcastRoomUpdated(room: Room): void {
    const message = JSON.stringify({
      type: "room.updated",
      room: toPublicRoom(room),
    } satisfies ServerMessage);
    this.broadcastMessage(room.code, message);
  }

  /** Send one raw (already JSON-encoded) message to every open connection in a room. */
  broadcastMessage(roomCode: string, message: string): void {
    for (const connection of this.forRoom(roomCode)) {
      this.sendIfOpen(connection, message);
    }
  }

  /** Send one raw message to every connection of a specific player in a room. */
  sendToPlayer(roomCode: string, playerId: string, message: string): void {
    for (const connection of this.forRoom(roomCode)) {
      if (connection.playerId === playerId) this.sendIfOpen(connection, message);
    }
  }

  /** True when a player still has at least one open connection in a room (multi-socket aware). */
  hasPlayerConnections(roomCode: string, playerId: string): boolean {
    return this.forRoom(roomCode).some((connection) => connection.playerId === playerId);
  }

  closePlayerConnections(playerId: string): void {
    for (const connection of this.forPlayer(playerId)) {
      connection.socket.close();
    }
  }

  closeRoomConnections(roomCode: string): void {
    for (const connection of this.forRoom(roomCode)) {
      connection.socket.close();
    }
  }

  private sendIfOpen(connection: Connection, message: string): void {
    if (connection.socket.readyState === OPEN_READY_STATE) {
      connection.socket.send(message);
    }
  }

  private forRoom(roomCode: string): Connection[] {
    return [...this.connections.values()].filter(
      (connection) => connection.roomCode === roomCode,
    );
  }

  private forPlayer(playerId: string): Connection[] {
    return [...this.connections.values()].filter(
      (connection) => connection.playerId === playerId,
    );
  }
}