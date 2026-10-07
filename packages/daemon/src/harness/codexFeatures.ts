/** Names of Codex's feature flags the service reads or sets (`codex features list`, `-c features.<name>=true`). */

/** The flag Codex keeps its Daybreak switch under (0.162: under development, off unless enabled): without it
 *  `/daybreak` is no command and the user's own default does nothing (docs/simple-view-v0.md §5.8). */
export const CODEX_DAYBREAK_FEATURE = "cli_daybreak";
