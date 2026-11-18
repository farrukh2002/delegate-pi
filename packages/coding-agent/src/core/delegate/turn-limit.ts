import type { Agent } from "@earendil-works/pi-agent-core";

export function installDelegateTurnLimit(
	agent: Pick<Agent, "prepareNextTurn" | "prepareNextTurnWithContext" | "prepareRequest" | "abort">,
	maxTurns: number,
	onLimit: (turns: number) => void,
): void {
	const prepareNext = agent.prepareNextTurnWithContext;
	const prepare = agent.prepareRequest;
	let turns = 0;
	const requireAvailableTurn = () => {
		if (turns < maxTurns) return;
		onLimit(turns);
		agent.abort();
		throw new Error("Delegate turn limit reached.");
	};
	agent.prepareNextTurnWithContext = async (previous, signal) => {
		requireAvailableTurn();
		return prepareNext ? await prepareNext(previous, signal) : await agent.prepareNextTurn?.(signal);
	};
	agent.prepareRequest = async (request, signal) => {
		requireAvailableTurn();
		const prepared = await prepare?.(request, signal);
		turns++;
		return prepared || undefined;
	};
}
