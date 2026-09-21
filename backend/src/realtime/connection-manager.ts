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
    this.sendToRoom(room.code, message);
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

  private sendToRoom(roomCode: string, message: string): void {
    for (const connection of this.forRoom(roomCode)) {
      if (connection.socket.readyState === OPEN_READY_STATE) {
        connection.socket.send(message);
      }
    }
  }
}