import type { PublicRoom } from "../rooms/types.ts";

export type ServerMessage =
  | {
      type: "connected";
      playerId: string;
    }
  | {
      type: "room.updated";
      room: PublicRoom;
    }
  | {
      type: "pong";
    }
  | {
      type: "error";
      code: string;
      message: string;
    };

export type ClientMessage = {
  type: "ping";
};

export interface ConnectionSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
}

export interface Connection {
  connectionId: string;
  roomCode: string;
  playerId: string;
  socket: ConnectionSocket;
}