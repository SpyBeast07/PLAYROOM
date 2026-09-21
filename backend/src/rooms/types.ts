export type RoomStatus = "waiting" | "playing";

export interface Room {
  id: string;
  code: string;
  status: RoomStatus;
  players: Player[];
  createdAt: number;
}

export interface Player {
  id: string;
  name: string;
  joinedAt: number;
  isHost: boolean;
}

export interface PublicRoom {
  code: string;
  status: RoomStatus;
  players: PublicPlayer[];
  createdAt: number;
}

export interface PublicPlayer {
  id: string;
  name: string;
  isHost: boolean;
}

export function toPublicPlayer(player: Player): PublicPlayer {
  return {
    id: player.id,
    name: player.name,
    isHost: player.isHost,
  };
}

export function toPublicRoom(room: Room): PublicRoom {
  return {
    code: room.code,
    status: room.status,
    players: room.players.map(toPublicPlayer),
    createdAt: room.createdAt,
  };
}