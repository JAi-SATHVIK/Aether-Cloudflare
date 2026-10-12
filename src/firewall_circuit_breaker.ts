export enum CircuitState {
    CLOSED,
    OPEN,
    HALF_OPEN
}
export class SemanticCircuitBreaker {
    private state: CircuitState = CircuitState.CLOSED;
    private consecutiveFailures: number = 0;
    private readonly failureThreshold: number = 5;
    private readonly cooldownPeriodMs: number = 30000;
    private lastStateTransitionTime: number = Date.now();
    private latencyEma: number = 250.0;
    public getState(): CircuitState {
        this.evaluateStateTransitions();
        return this.state;
    }
    public recordSuccess(latencyMs: number): void {
        this.consecutiveFailures = 0;
        this.latencyEma = 0.85 * this.latencyEma + 0.15 * latencyMs;
        if (this.state === CircuitState.HALF_OPEN) {
            this.state = CircuitState.CLOSED;
            this.lastStateTransitionTime = Date.now();
        }
    }
    public recordFailure(): void {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.failureThreshold || this.latencyEma > 800) {
            this.state = CircuitState.OPEN;
            this.lastStateTransitionTime = Date.now();
        }
    }
    private evaluateStateTransitions(): void {
        if (this.state === CircuitState.OPEN) {
            const elapsed = Date.now() - this.lastStateTransitionTime;
            if (elapsed >= this.cooldownPeriodMs) {
                this.state = CircuitState.HALF_OPEN;
                this.lastStateTransitionTime = Date.now();
            }
        }
    }
}
