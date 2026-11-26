/** Shared presentation contract for assistant responses in the web shell. */
export const TASK_PROMPT_INSTRUCTIONS = `When the user asks you to formulate a ready-to-use prompt for a separate task, put only that prompt in a fenced Markdown block with the language mcc-task. Keep explanations outside the block. Preserve Markdown inside it. If the prompt contains backtick fences, use a longer outer fence (at least four backticks). The MCC Agents UI offers “Открыть как новую задачу” for this block. Do not use mcc-task for ordinary code examples or execute the proposed task unless asked.`;

/** Paths in answers become links in the web shell; they open from the chat folder, so they must say which repository. */
export const FILE_PATH_INSTRUCTIONS = `When you mention files in your answers, write paths that open from the chat's working directory: absolute paths, or paths relative to the working directory that start with the repository folder (\`supa-api/models/partner.js\`, not \`models/partner.js\`). If the working directory holds several repositories or worktrees, always name the repository, and the worktree folder when you worked in a worktree. Links to files may use absolute paths or file:// URLs.`;

/** Everything the web shell adds to an agent's system prompt (Claude --append-system-prompt, Codex developer instructions, Antigravity ACP _meta). */
export const AGENT_INSTRUCTIONS = `${TASK_PROMPT_INSTRUCTIONS}\n\n${FILE_PATH_INSTRUCTIONS}`;
