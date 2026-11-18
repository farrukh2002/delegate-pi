/**
 * Budget checks for a delegated child: turns and the peak context of one request.
 *
 * Let the last allowed turn finish. Block a continuation, or a provider that reports more turns
 * than allowed. Warn once when a request approaches the context limit.
 */
export interface BudgetLimits {
	maxTurns?: number;
	contextBudget?: number;
}

export interface BudgetUsage {
	turns: number;
	contextTokens: number;
}

export interface BudgetCheck {
	stop?: string;
	notice?: string;
}

const CONTEXT_WARN_AT = 0.8;

export function checkBudget(
	limits: BudgetLimits,
	usage: BudgetUsage,
	priorNotice?: string,
	startingNextTurn = false,
): BudgetCheck {
	const maxTurns = limits.maxTurns ?? 0;
	if (maxTurns > 0 && (usage.turns > maxTurns || (startingNextTurn && usage.turns === maxTurns))) {
		return {
			stop: `Turn budget reached: the child ran ${usage.turns} turns, the limit is ${maxTurns}. Its changes stay in the project. Continue with a new child on the same scope after accept.`,
		};
	}
	const contextBudget = limits.contextBudget ?? 0;
	if (contextBudget <= 0) return {};
	if (usage.contextTokens > contextBudget) {
		return {
			stop: `Context budget reached: the child carried ${usage.contextTokens} tokens in one request, above the budget of ${contextBudget}. Its changes stay in the project. Continue with a new child on the same scope after accept.`,
		};
	}
	if (priorNotice || usage.contextTokens < contextBudget * CONTEXT_WARN_AT) return {};
	return {
		notice: `Context budget warning: this child carried ${usage.contextTokens} of ${contextBudget} tokens in one request.`,
	};
}
