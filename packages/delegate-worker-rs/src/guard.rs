use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::time::{Duration, Instant};

pub(crate) struct Budget {
    pub(crate) max_turns: f64,
    context: f64,
}

pub(crate) enum BudgetCheck {
    Clear,
    Notice(String),
    Stop(String),
}

impl Budget {
    pub(crate) fn new(request: &Value) -> Self {
        Self {
            max_turns: request["maxTurns"].as_f64().unwrap_or(0.0),
            context: request["contextBudget"].as_f64().unwrap_or(0.0),
        }
    }

    pub(crate) fn check(
        &self,
        turns: f64,
        tokens: f64,
        starting_next: bool,
        warned: bool,
    ) -> BudgetCheck {
        let max_turns = self.max_turns;
        let context = self.context;
        if max_turns > 0.0 && (turns > max_turns || (starting_next && turns == max_turns)) {
            return BudgetCheck::Stop(format!("Turn budget reached: the child ran {turns} turns, the limit is {max_turns}. Its changes stay in the project. Continue with a new child on the same scope after accept."));
        }
        if context <= 0.0 {
            return BudgetCheck::Clear;
        }
        if tokens > context {
            return BudgetCheck::Stop(format!("Context budget reached: the child carried {tokens} tokens in one request, above the budget of {context}. Its changes stay in the project. Continue with a new child on the same scope after accept."));
        }
        if !warned && tokens >= context * 0.8 {
            return BudgetCheck::Notice(format!("Context budget warning: this child carried {tokens} of {context} tokens in one request."));
        }
        BudgetCheck::Clear
    }
}

pub(crate) enum LoopAction {
    Steer(String),
    Stop(String),
}

pub(crate) struct LoopGuard {
    recent: VecDeque<String>,
    steered: HashSet<String>,
    seen_ids: HashSet<String>,
    pending: Option<(Instant, LoopAction)>,
    grace: Duration,
}

impl LoopGuard {
    pub(crate) fn new(scoped: bool) -> Self {
        Self {
            recent: VecDeque::new(),
            steered: HashSet::new(),
            seen_ids: HashSet::new(),
            pending: None,
            grace: if scoped {
                Duration::from_millis(100)
            } else {
                Duration::ZERO
            },
        }
    }

    pub(crate) fn observe(&mut self, id: Option<&str>, name: &str, args: &Value) {
        if id.is_some_and(|id| !self.seen_ids.insert(id.to_string())) {
            return;
        }
        let name = if name.is_empty() { "tool" } else { name };
        let fingerprint = format!("{name}\0{args}");
        self.recent.push_back(fingerprint.clone());
        if self.recent.len() > 20 {
            self.recent.pop_front();
        }
        let count = self
            .recent
            .iter()
            .filter(|entry| **entry == fingerprint)
            .count();
        if self
            .pending
            .as_ref()
            .is_some_and(|(_, action)| matches!(action, LoopAction::Stop(_)))
        {
            return;
        }
        let message = || {
            if let Some(command) = args["command"].as_str() {
                let preview: String = command.chars().take(120).collect();
                format!("{name}: {preview}")
            } else {
                name.to_string()
            }
        };
        if count >= 5 {
            self.pending = Some((Instant::now() + self.grace, LoopAction::Stop(format!("Loop detected: the child repeated {} {count} times without changing files. Its changes stay in the project; continue with a new child after accept.", message()))));
        } else if count >= 3 && self.steered.insert(fingerprint) && self.pending.is_none() {
            self.pending = Some((Instant::now() + self.grace, LoopAction::Steer(format!("The parent guard saw {} repeated {count} times with no file change. Change approach, ask the parent user, or stop and report BLOCKED. Do not repeat it again.", message()))));
        }
    }

    pub(crate) fn take_action(&mut self) -> Option<LoopAction> {
        if self
            .pending
            .as_ref()
            .is_some_and(|(at, _)| Instant::now() >= *at)
        {
            self.pending.take().map(|(_, action)| action)
        } else {
            None
        }
    }

    pub(crate) fn progress(&mut self) {
        self.recent.clear();
        self.steered.clear();
        self.pending = None;
    }
}
