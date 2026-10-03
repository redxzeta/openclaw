/** Canonical projection from skill workshop config to system-owned cron jobs. */
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentModelFallbacksOverride,
  resolveSubagentModelConfigSelectionResult,
  resolveSubagentModelFallbacksOverride,
} from "../agents/agent-scope.js";
import { resolveEffectiveToolPolicy } from "../agents/agent-tools.policy.js";
import { resolveAvailableAgentHarnessPolicy } from "../agents/harness/availability.js";
import { resolveModelCandidateChain } from "../agents/model-fallback-candidates.js";
import { resolveCliRuntimeExecutionProvider } from "../agents/model-runtime-aliases.js";
import { isCliProvider } from "../agents/model-selection-cli.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import {
  buildModelAliasIndex,
  inferUniqueProviderFromConfiguredModels,
  normalizeModelSelection,
  resolveModelRefFromString,
} from "../agents/model-selection-shared.js";
import { resolveSandboxToolPolicyForAgent } from "../agents/sandbox/tool-policy.js";
import { createToolAccessDiagnostics } from "../agents/tool-access-diagnostics.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
} from "../agents/tool-policy-pipeline.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "../agents/tool-policy.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatSchedulerSeed } from "../infra/heartbeat-runner.js";
import { resolveHeartbeatPhaseMs } from "../infra/heartbeat-schedule.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { ManifestModelIdNormalizationSource } from "../plugins/manifest-model-id-normalization.js";
import { resolveSkillWorkshopConfig } from "../skills/workshop/config.js";
import {
  SKILL_WORKSHOP_MAINTENANCE_PROMPT,
  SKILL_WORKSHOP_MAINTENANCE_TOOLS,
} from "../skills/workshop/maintenance-prompt.js";
import { supportsCronExecutionRoot } from "./execution-root-runtime.js";
import { resolveCronAgentConfigFromSnapshot } from "./isolated-agent/run-config.js";
import { resolveCronAgentSessionKey } from "./isolated-agent/session-key.js";
import { partitionSystemMonitors } from "./system-monitor-jobs.js";
import { SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX } from "./system-owned-declaration.js";
import type { CronJob, CronJobCreate } from "./types.js";

const SKILL_COLLECTION_REVIEW_EVERY_MS = 7 * 24 * 60 * 60_000;
const SKILL_COLLECTION_REVIEW_NO_ROOTED_RUNTIME_REASON = "no-rooted-runtime";

type ReviewEligibility = { eligible: true | undefined } | { eligible: false; reason: string };

function combineReviewEligibility(outcomes: ReviewEligibility[]): ReviewEligibility {
  return (
    outcomes.find((outcome) => outcome.eligible === true) ??
    outcomes.find((outcome) => outcome.eligible === undefined) ??
    outcomes[0] ?? { eligible: undefined }
  );
}

/** Projection can prove policy exclusion, never tool construction or a future hook result. */
function resolveMaintenanceToolPolicyBlock(
  cfg: OpenClawConfig,
  agentId: string,
  model?: { provider: string; model: string },
): string | undefined {
  const policy = resolveEffectiveToolPolicy({
    config: cfg,
    agentId,
    modelProvider: model?.provider,
    modelId: model?.model,
  });
  const diagnostics = createToolAccessDiagnostics({
    profiles: policy.profiles,
    toolNames: SKILL_WORKSHOP_MAINTENANCE_TOOLS,
  });
  const agentConfig = resolveAgentConfig(cfg, agentId);
  // Review sessions are isolated, so both all and non-main enable sandbox policy.
  const sandboxMode = agentConfig?.sandbox?.mode ?? cfg.agents?.defaults?.sandbox?.mode;
  const tools = applyToolPolicyPipeline({
    tools: SKILL_WORKSHOP_MAINTENANCE_TOOLS.map((name) => ({ name })),
    toolMeta: () => undefined,
    warn: () => undefined,
    steps: [
      ...buildDefaultToolPolicyPipelineSteps({
        ...policy,
        profilePolicy: mergeAlsoAllowPolicy(
          resolveToolProfilePolicy(policy.profile),
          policy.profileAlsoAllow,
        ),
        providerProfilePolicy: mergeAlsoAllowPolicy(
          resolveToolProfilePolicy(policy.providerProfile),
          policy.providerProfileAlsoAllow,
        ),
      }),
      ...(sandboxMode && sandboxMode !== "off"
        ? [
            {
              policy: resolveSandboxToolPolicyForAgent(cfg, agentId),
              label: "sandbox tools",
              source: { kind: "runtime" as const, path: "tools.sandbox.tools" },
            },
          ]
        : []),
    ],
    onFilter: diagnostics.onFilter,
  });
  const names = new Set<string>(tools.map((tool) => tool.name));
  // Listing, reading, and editing are required; shell and patch tools are alternatives.
  const missing = [
    ["ls", "exec"],
    ["read", "exec"],
    ["write", "edit", "apply_patch", "exec"],
  ].find((alternatives) => !alternatives.some((name) => names.has(name)));
  if (!missing) {
    return undefined;
  }
  const reason =
    tools.length === 0 ? "EFFECTIVE_TOOLSET_EMPTY" : "MAINTENANCE_CAPABILITIES_MISSING";
  const sources = [
    ...new Set(
      diagnostics
        .finish()
        .tools.filter((tool) => missing.includes(tool.id))
        .flatMap((tool) => tool.reasons.map((entry) => entry.source ?? entry.label)),
    ),
  ];
  return `${reason}: ${sources.join(", ")}`;
}

/** Returns undefined when static config cannot prove the full runtime chain. */
function resolveSkillCollectionReviewEligibility(
  cfg: OpenClawConfig,
  agentId: string,
  manifestPlugins: ManifestModelIdNormalizationSource,
): ReviewEligibility {
  const normalization = { manifestPlugins, allowPluginNormalization: false } as const;
  const agentConfig = resolveAgentConfig(cfg, agentId);
  const { cfgWithAgentDefaults } = resolveCronAgentConfigFromSnapshot({
    config: cfg,
    agentConfigOverride: agentConfig,
  });
  const defaultRef = resolveDefaultModelForAgent({
    cfg: cfgWithAgentDefaults,
    agentId,
    ...normalization,
  });
  const selection = resolveSubagentModelConfigSelectionResult({
    cfg,
    agentId,
    agentConfigOverride: agentConfig,
  });
  const selectedRaw = selection ? normalizeModelSelection(selection.raw) : undefined;
  const aliasIndex = buildModelAliasIndex({
    cfg,
    agentId,
    defaultProvider: defaultRef.provider,
    ...normalization,
  });
  const selected = selectedRaw
    ? resolveModelRefFromString({
        cfg,
        agentId,
        aliasIndex,
        ...normalization,
        raw: selectedRaw,
        defaultProvider: !selectedRaw.includes("/")
          ? (inferUniqueProviderFromConfiguredModels({
              cfg,
              agentId,
              model: selectedRaw,
              manifestPlugins,
            }) ?? defaultRef.provider)
          : defaultRef.provider,
      })?.ref
    : defaultRef;
  if (!selected) {
    return { eligible: undefined };
  }

  const agentModel = agentConfig?.model;
  const inheritsDefaultFallbacks =
    typeof agentModel === "string" &&
    resolveAgentModelPrimaryValue(agentModel) ===
      resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model);
  const defaultFallbacks =
    (inheritsDefaultFallbacks
      ? resolveAgentModelFallbackValues(cfgWithAgentDefaults.agents?.defaults?.model)
      : resolveAgentModelFallbacksOverride(cfgWithAgentDefaults, agentId)) ??
    resolveAgentModelFallbackValues(cfgWithAgentDefaults.agents?.defaults?.model);
  const fallbacksOverride =
    (selection?.source === "subagent" || selection?.source === "default-subagent"
      ? resolveSubagentModelFallbacksOverride(cfgWithAgentDefaults, agentId)
      : defaultFallbacks) ?? defaultFallbacks;

  // Advisory model selections are accepted only against the execution owner's live
  // catalog/policy. Projection cannot prove that acceptance, so also consider the
  // default chain that execution retains when the advisory selection is rejected.
  const chains = [
    { selected, fallbacksOverride },
    { selected: defaultRef, fallbacksOverride: defaultFallbacks },
  ];
  const eligibility = chains.map((chain): ReviewEligibility => {
    // A plugin-owned or otherwise unresolved ref may become runnable after runtime preparation.
    // Keep the job enabled unless every configured candidate can be classified now.
    if (
      chain.fallbacksOverride.some(
        (raw) =>
          !resolveModelRefFromString({
            cfg: cfgWithAgentDefaults,
            agentId,
            aliasIndex,
            ...normalization,
            raw,
            defaultProvider: chain.selected.provider,
          }),
      )
    ) {
      return { eligible: undefined };
    }

    const candidates = resolveModelCandidateChain({
      cfg: cfgWithAgentDefaults,
      ...normalization,
      agentId,
      provider: chain.selected.provider,
      model: chain.selected.model,
      requestedRouteResolution: "resolved",
      fallbacksOverride: chain.fallbacksOverride,
    });
    if (candidates.length === 0) {
      return { eligible: undefined };
    }
    return combineReviewEligibility(
      candidates.map((candidate): ReviewEligibility => {
        const policy = resolveAvailableAgentHarnessPolicy({
          mode: "projection",
          config: cfgWithAgentDefaults,
          provider: candidate.provider,
          modelId: candidate.model,
          agentId,
        });
        const executionProvider =
          resolveCliRuntimeExecutionProvider({
            cfg: cfgWithAgentDefaults,
            provider: candidate.provider,
            modelId: candidate.model,
            agentId,
          }) ?? candidate.provider;
        // Implicit/auto runtime selection can still fall back to embedded
        // execution after harness preparation; it cannot prove rejection here.
        const rooted =
          policy.runtimeSource === "implicit" ||
          policy.runtime === "auto" ||
          supportsCronExecutionRoot(
            policy.runtime,
            isCliProvider(executionProvider, cfgWithAgentDefaults),
          );
        if (!rooted) {
          return { eligible: false, reason: SKILL_COLLECTION_REVIEW_NO_ROOTED_RUNTIME_REASON };
        }
        const toolBlock = resolveMaintenanceToolPolicyBlock(
          cfgWithAgentDefaults,
          agentId,
          candidate,
        );
        return toolBlock ? { eligible: false, reason: toolBlock } : { eligible: true };
      }),
    );
  });
  return combineReviewEligibility(eligibility);
}

export function skillCollectionReviewMonitorAgentId(job: CronJob): string | undefined {
  const key = job.declarationKey;
  if (!key?.startsWith(SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX)) {
    return undefined;
  }
  return key.slice(SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX.length) || undefined;
}

function hasStoredExecutionPreference(
  cfg: OpenClawConfig,
  agentId: string,
  jobId: string,
): boolean {
  try {
    const entry = loadSessionEntryReadOnly({
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
      sessionKey: resolveCronAgentSessionKey({
        sessionKey: `cron:${jobId}`,
        agentId,
        mainKey: cfg.session?.mainKey,
        cfg,
      }),
      readConsistency: "latest",
    });
    return Boolean(entry?.modelOverride || entry?.agentRuntimeOverride);
  } catch {
    // An unavailable session store is not evidence that no preference exists.
    return true;
  }
}

/** One system-owned review job per configured agent and its Workshop directory. */
export function* resolveSkillCollectionReviewMonitorSpecs(
  cfg: OpenClawConfig,
  jobs: readonly CronJob[],
  options: { schedulerSeed?: string } = {},
): IterableIterator<{ agentId: string; input: CronJobCreate }> {
  const schedulerSeed = resolveHeartbeatSchedulerSeed(options.schedulerSeed);
  const { retained } = partitionSystemMonitors(jobs, skillCollectionReviewMonitorAgentId);
  const workshopEnabled = resolveSkillWorkshopConfig(cfg).autonomous.mode === "auto";
  // Static projection consumes the selected generation, never provider load planning.
  const manifestPlugins =
    getCurrentPluginMetadataSnapshot({ config: cfg, allowWorkspaceScopedSnapshot: true }) ?? [];
  for (const agentId of listAgentIds(cfg)) {
    const configuredEligibility = resolveSkillCollectionReviewEligibility(
      cfg,
      agentId,
      manifestPlugins,
    );
    const existing = retained.get(agentId);
    // Config cannot prove the execution chain while a stored session can select
    // a different model or runtime. Leave preference validation to the runner.
    const eligibility: ReviewEligibility =
      configuredEligibility.eligible === false &&
      existing &&
      hasStoredExecutionPreference(cfg, agentId, existing.id)
        ? { eligible: undefined }
        : configuredEligibility;
    // A stored runtime preference cannot override global/agent/sandbox restrictions.
    const toolBlock = resolveMaintenanceToolPolicyBlock(cfg, agentId);
    const blockedReason =
      toolBlock ?? (eligibility.eligible === false ? eligibility.reason : undefined);
    const enabled = workshopEnabled && !blockedReason;
    yield {
      agentId,
      input: {
        declarationKey: `${SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX}${agentId}`,
        name: `skill-collection-review-${agentId}`,
        displayName:
          workshopEnabled && blockedReason
            ? `[${blockedReason}] Skill collection review (${agentId})`
            : `Skill collection review (${agentId})`,
        agentId,
        enabled,
        schedule: {
          kind: "every",
          everyMs: SKILL_COLLECTION_REVIEW_EVERY_MS,
          anchorMs: resolveHeartbeatPhaseMs({
            schedulerSeed,
            agentId,
            intervalMs: SKILL_COLLECTION_REVIEW_EVERY_MS,
          }),
        },
        payload: {
          kind: "agentTurn",
          message: SKILL_WORKSHOP_MAINTENANCE_PROMPT,
          toolsAllow: [...SKILL_WORKSHOP_MAINTENANCE_TOOLS],
        },
        sessionTarget: "isolated",
        delivery: { mode: "none" },
        wakeMode: "next-heartbeat",
      },
    };
  }
}
