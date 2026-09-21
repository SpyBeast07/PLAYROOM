export type Game = {
	name: 'Mafia' | 'Housie' | 'Connect 4' | 'Tic Tac Toe';
	description: string;
};

export const GAMES: Game[] = [
	{ name: 'Mafia', description: 'A social deduction game of secrets, suspicion and survival.' },
	{ name: 'Housie', description: 'Classic housie, built for the whole room.' },
	{ name: 'Connect 4', description: 'Four in a row. Two players. One winner.' },
	{ name: 'Tic Tac Toe', description: 'The classic, without the paper.' }
];
