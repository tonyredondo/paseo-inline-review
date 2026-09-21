/**
 * Live flag mirror for the user-message-card transformer. Transformers are
 * registered once at contribute time, so the flag value must live outside
 * React state; the settings screen syncs it on every change.
 */
let enabled = false;

export function setUserMessageCardsEnabled(value: boolean): void {
  enabled = value;
}

export function userMessageCardsEnabled(): boolean {
  return enabled;
}
