/**
 * Keeps each request inside the model's context window.
 *
 * Research (2026-10-12): the window is 4,096 tokens and overflow is silent.
 * The start of the prompt, which holds the instructions and the task, is
 * dropped with no error. So the agent counts for itself and trims old steps.
 */

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export const CONTEXT_WINDOW_TOKENS = 4096;
export const MAX_REPLY_TOKENS = 400;
/** What a prompt may use: the window, less the reply, less a safety margin. */
export const PROMPT_BUDGET_TOKENS = CONTEXT_WINDOW_TOKENS - MAX_REPLY_TOKENS - 300;

export const OMITTED_NOTE = "[Earlier steps were removed to save space.]";

/** Measured at about 3.04 characters per token on code; 3 errs on the safe side. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

const total = (messages: Message[]) =>
  messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0);

/**
 * The messages to send: always the instructions and the task, then as many of
 * the most recent steps as fit. Steps are dropped oldest first, a reply and
 * its result together.
 */
export function fitMessages(messages: Message[], budget = PROMPT_BUDGET_TOKENS): Message[] {
  const fixed = messages.slice(0, 2);
  const steps = messages.slice(2);
  let dropped = false;
  const assemble = (): Message[] =>
    dropped ? [...fixed, { role: "user", content: OMITTED_NOTE }, ...steps] : [...fixed, ...steps];

  while (total(assemble()) > budget && steps.length > 2) {
    steps.splice(0, 2);
    dropped = true;
  }
  // Still too big: one step is enormous. Cut its text rather than lose the task.
  let fitted = assemble();
  while (total(fitted) > budget) {
    const largest = fitted.slice(2).reduce((a, b) => (b.content.length > a.content.length ? b : a), fitted[2]);
    if (!largest || largest.content.length < 200) break;
    largest.content = largest.content.slice(0, Math.floor(largest.content.length / 2)) + "\n[cut to fit]";
    fitted = assemble();
  }
  return fitted;
}
