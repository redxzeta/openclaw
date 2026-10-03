import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { applyEmbeddedAttemptToolsAllow } from "../embedded-agent-runner/run/attempt-tool-construction-plan.js";
import {
  buildEmptyExplicitToolAllowlistError,
  collectExplicitToolAllowlistSources,
} from "../tool-allowlist-guard.js";
import { normalizeToolPolicyName } from "../tool-policy.js";

/** Transport prefix CLI harnesses use for loopback OpenClaw MCP tool names. */
const OPENCLAW_MCP_TOOL_PREFIX = "mcp__openclaw__";
const GEMINI_OPENCLAW_MCP_TOOL_PREFIX = "mcp_openclaw_";

/** Strips the loopback MCP transport prefix so observers see gateway tool names. */
export function stripOpenClawMcpToolPrefix(toolName: string): string {
  return toolName.startsWith(OPENCLAW_MCP_TOOL_PREFIX)
    ? toolName.slice(OPENCLAW_MCP_TOOL_PREFIX.length)
    : toolName.startsWith(GEMINI_OPENCLAW_MCP_TOOL_PREFIX)
      ? toolName.slice(GEMINI_OPENCLAW_MCP_TOOL_PREFIX.length)
      : toolName;
}

/** Match provider-native names against the canonical tool hook and policy ids. */
export function normalizeCliToolName(toolName: string): string {
  return normalizeToolPolicyName(
    toolName.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2"),
  );
}

/** Keeps only explicit runtime caps for backend-owned exact translation. */
export function resolveCliRuntimeToolsAllow(
  toolsAllow?: string[],
  _toolsAllowIsDefault?: boolean,
): string[] | undefined {
  if (toolsAllow === undefined) {
    return undefined;
  }
  return toolsAllow.some((toolName) => normalizeToolPolicyName(toolName) === "*")
    ? undefined
    : toolsAllow;
}

/** Apply the hook cap to the materialized CLI surface before grants or backend preparation. */
export function projectCliPromptTools<T extends { name: string }>(params: {
  tools: T[];
  toolsAllow?: string[];
  rooted: boolean;
  requestedTools?: string[];
  restrictsTools: boolean;
  backend: Pick<CliBackendPlugin, "id" | "nativeToolMode">;
  canEnforceExactToolAvailability: boolean;
}): T[] {
  const tools = applyEmbeddedAttemptToolsAllow(params.tools, params.toolsAllow);
  if (params.rooted) {
    const error = buildEmptyExplicitToolAllowlistError({
      sources: collectExplicitToolAllowlistSources([
        {
          label: "runtime toolsAllow",
          allow: params.requestedTools ?? params.tools.map((tool) => tool.name),
          enforceWhenToolsDisabled: true,
        },
      ]),
      hasCallableTools: tools.length > 0,
      toolsEnabled: true,
      restrictionSource: params.tools.length === 0 ? "tool-construction" : "before_prompt_build",
    });
    if (error) {
      throw error;
    }
  }
  if (
    params.restrictsTools &&
    (params.backend.nativeToolMode === "always-on" ||
      (params.backend.nativeToolMode === "selectable" && !params.canEnforceExactToolAvailability))
  ) {
    throw new Error(
      `CLI backend "${params.backend.id}" cannot enforce before_prompt_build tool restrictions. Use a backend with exact tool availability or remove the hook restriction. OpenClaw did not start the run.`,
    );
  }
  return tools;
}
