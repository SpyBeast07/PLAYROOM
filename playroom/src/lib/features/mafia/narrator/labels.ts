/**
 * Narrator copy — shared labels for roles and winning teams.
 */
import type { MafiaRole, MafiaTeam } from '../multiplayer/types';

export const ROLE_LABELS: Record<MafiaRole, string> = {
	MAFIA: 'Mafia',
	DOCTOR: 'Doctor',
	DETECTIVE: 'Detective',
	VILLAGER: 'Villager'
};

export const TEAM_LABELS: Record<MafiaTeam, string> = {
	MAFIA: 'The Mafia win.',
	TOWN: 'The Town wins.'
};
