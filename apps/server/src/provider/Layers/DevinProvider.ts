import {
  type DevinSettings,
  type ModelCapabilities,
  type ProviderOptionDescriptor,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { makeDevinAcpRuntime, resolveDevinAcpBaseModelId } from "../acp/DevinAcpSupport.ts";

const DEVIN_PRESENTATION = {
  displayName: "Devin",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

const DEVIN_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "adaptive",
    name: "Adaptive",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialDevinProviderSnapshot(
  devinSettings: DevinSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = devinModelsFromSettings(devinSettings.customModels, devinSettings.defaultModel);

    if (!devinSettings.enabled) {
      return buildServerProvider({
        presentation: DEVIN_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Devin is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Devin CLI availability...",
      },
    });
  });
}

function devinModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  _defaultModel: string | null | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = DEVIN_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

// Convert SessionModelState.availableModels into the flat {value, name} shape
// that groupDevinModels expects, then run the same grouping pipeline as
// buildDevinDiscoveredModelsFromConfigOptions.  This prevents duplicate
// entries (e.g. `glm-5-2` and `glm-5-2-high` showing as separate models).
function buildDevinDiscoveredModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
  defaultModel: string | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const flatOptions = modelState.availableModels.map((m) => ({
    value: m.modelId,
    name: m.name?.trim() || m.modelId,
  }));
  return buildGroupedDevinModels(flatOptions, defaultModel);
}

// ── Reasoning level + context window extraction ──────────────────────
// Devin encodes reasoning levels as model ID suffixes (e.g. `glm-5-2-max`,
// `claude-opus-5-high`) and context windows as `-1m`. We group variants by
// base model and expose reasoning level + context window as option
// descriptors, matching how Codex exposes `reasoningEffort` and Claude
// exposes `contextWindow`. This collapses 184 raw entries into ~30 base
// models with dropdowns.

const REASONING_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
type ReasoningLevel = (typeof REASONING_LEVELS)[number];

const REASONING_LABELS: Readonly<Record<ReasoningLevel, string>> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

// Suffixes that modify the model but are NOT reasoning levels.
// `-fast` / `-priority` = speed tier, `-1m` = context window, `-lightning` = variant.
const NON_REASONING_SUFFIXES = ["fast", "priority", "1m", "lightning"] as const;

// Context window option values exposed in the UI.
const CONTEXT_WINDOW_STANDARD = "standard";
const CONTEXT_WINDOW_1M = "1m";

interface DevinModelVariant {
  readonly modelId: string;
  readonly name: string;
  readonly reasoningLevel: ReasoningLevel | undefined;
  readonly isFast: boolean;
  readonly isLargeContext: boolean;
}

interface DevinModelGroup {
  readonly baseId: string;
  readonly baseName: string;
  readonly variants: ReadonlyArray<DevinModelVariant>;
  readonly reasoningLevels: ReadonlyArray<ReasoningLevel>;
  readonly defaultLevel: ReasoningLevel | undefined;
  readonly hasLargeContext: boolean;
}

// Remove reasoning level indicators from a display name so the model
// picker shows "GLM 5.2" instead of "GLM 5.2 High". The reasoning level
// is communicated via the option descriptor, not the model name.
function cleanBaseDisplayName(name: string): string {
  let cleaned = name.trim();
  // Remove trailing reasoning level words (case-insensitive).
  for (const level of REASONING_LEVELS) {
    const label = REASONING_LABELS[level];
    // Match " High", " Max", " Extra High" at end of string.
    const suffixPattern = new RegExp(`\\s+${label}$`, "i");
    if (suffixPattern.test(cleaned)) {
      cleaned = cleaned.replace(suffixPattern, "");
      break;
    }
    // Also match raw level words like " xhigh", " none".
    const rawPattern = new RegExp(`\\s+${level}$`, "i");
    if (rawPattern.test(cleaned)) {
      cleaned = cleaned.replace(rawPattern, "");
      break;
    }
  }
  // Remove "No Thinking" suffix.
  cleaned = cleaned.replace(/\s+No\s+Thinking$/i, "");
  return cleaned.trim() || name.trim();
}

// Strip reasoning and non-reasoning suffixes to find the base model ID.
function stripModelSuffixes(modelId: string): string {
  // Repeatedly strip known suffixes from the end.
  let result = modelId;
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of [...REASONING_LEVELS, ...NON_REASONING_SUFFIXES]) {
      if (result.endsWith(`-${suffix}`)) {
        result = result.slice(0, -suffix.length - 1);
        changed = true;
        break;
      }
    }
  }
  return result;
}

// Extract the reasoning level from a model ID.
// Strips non-reasoning suffixes (-fast, -priority, -1m) first, then checks
// for a reasoning suffix. Falls back to inferring from the display name.
function extractReasoningLevel(modelId: string, name: string): ReasoningLevel | undefined {
  // Strip non-reasoning suffixes from the end, then check for reasoning.
  let stripped = modelId;
  for (const suffix of NON_REASONING_SUFFIXES) {
    if (stripped.endsWith(`-${suffix}`)) {
      stripped = stripped.slice(0, -suffix.length - 1);
    }
  }
  for (const level of REASONING_LEVELS) {
    if (stripped.endsWith(`-${level}`)) return level;
  }
  // No suffix found — try to infer from the display name.
  const lowerName = name.toLowerCase();
  if (lowerName.includes("no thinking") || lowerName.includes("none")) return "none";
  if (lowerName.includes("max")) return "max";
  if (lowerName.includes("xhigh") || lowerName.includes("x-high")) return "xhigh";
  if (lowerName.includes("high")) return "high";
  if (lowerName.includes("medium")) return "medium";
  if (lowerName.includes("low")) return "low";
  return undefined;
}

function hasSuffix(modelId: string, suffix: string): boolean {
  return modelId.endsWith(`-${suffix}`);
}

// Parse a flat list of (value, name) model options into grouped base models.
function groupDevinModels(
  flatOptions: ReadonlyArray<{ value: string; name: string }>,
): ReadonlyArray<DevinModelGroup> {
  // Build variants with parsed metadata.
  const variants: DevinModelVariant[] = flatOptions.map((opt) => {
    const reasoningLevel = extractReasoningLevel(opt.value, opt.name);
    const isFast = hasSuffix(opt.value, "fast") || hasSuffix(opt.value, "priority");
    const isLargeContext = hasSuffix(opt.value, "1m");
    return {
      modelId: opt.value,
      name: opt.name.trim() || opt.value,
      reasoningLevel,
      isFast,
      isLargeContext,
    };
  });

  // Group by base ID.
  const groupsMap = new Map<string, DevinModelVariant[]>();
  for (const variant of variants) {
    const baseId = stripModelSuffixes(variant.modelId);
    const existing = groupsMap.get(baseId) ?? [];
    existing.push(variant);
    groupsMap.set(baseId, existing);
  }

  // Build group objects, only including groups that have reasoning variants.
  const groups: DevinModelGroup[] = [];
  for (const [baseId, groupVariants] of groupsMap) {
    const reasoningLevels = new Set<ReasoningLevel>();
    let baseName = baseId;
    let defaultLevel: ReasoningLevel | undefined;
    let hasLargeContext = false;

    for (const v of groupVariants) {
      if (v.isLargeContext) hasLargeContext = true;
      if (v.reasoningLevel) {
        reasoningLevels.add(v.reasoningLevel);
        // The "default" variant is the one without -fast/-1m suffix.
        // If the base ID itself appears as a variant (e.g. `glm-5-2` = High),
        // that's the default. Otherwise, pick the first non-fast variant.
        if (!v.isFast && !v.isLargeContext) {
          if (v.modelId === baseId) {
            baseName = v.name;
            defaultLevel = v.reasoningLevel;
          } else if (!defaultLevel) {
            defaultLevel = v.reasoningLevel;
            if (v.modelId === baseId) baseName = v.name;
          }
        }
      } else if (v.modelId === baseId) {
        baseName = v.name;
      }
    }

    // If base name is still the raw baseId, try to find a display name.
    if (baseName === baseId) {
      const named = groupVariants.find((v) => v.modelId === baseId);
      if (named) baseName = named.name;
    }

    // Clean the display name: remove reasoning level suffix so the picker
    // shows "GLM 5.2" instead of "GLM 5.2 High". The reasoning level is
    // communicated via the option descriptor dropdown.
    baseName = cleanBaseDisplayName(baseName);

    groups.push({
      baseId,
      baseName,
      variants: groupVariants,
      reasoningLevels: [...reasoningLevels].sort(
        (a, b) => REASONING_LEVELS.indexOf(a) - REASONING_LEVELS.indexOf(b),
      ),
      defaultLevel,
      hasLargeContext,
    });
  }

  // Sort: models with reasoning variants first, then alphabetical.
  groups.sort((a, b) => {
    const aHasReasoning = a.reasoningLevels.length > 0 ? 0 : 1;
    const bHasReasoning = b.reasoningLevels.length > 0 ? 0 : 1;
    if (aHasReasoning !== bHasReasoning) return aHasReasoning - bHasReasoning;
    return a.baseId.localeCompare(b.baseId);
  });

  return groups;
}

// Build ModelCapabilities for a model group, exposing reasoningEffort
// when the group has multiple reasoning levels and contextWindow when the
// group has both standard and 1M context variants.
function buildDevinModelCapabilities(group: DevinModelGroup): ModelCapabilities {
  const optionDescriptors: ProviderOptionDescriptor[] = [];

  if (group.reasoningLevels.length > 1) {
    const reasoningOptions = group.reasoningLevels.map((level) => ({
      id: level,
      label: REASONING_LABELS[level] ?? level,
      ...(level === group.defaultLevel ? { isDefault: true } : {}),
    }));
    optionDescriptors.push({
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select" as const,
      options: reasoningOptions,
      ...(group.defaultLevel ? { currentValue: group.defaultLevel } : {}),
    });
  }

  if (group.hasLargeContext) {
    optionDescriptors.push({
      id: "contextWindow",
      label: "Context Window",
      type: "select" as const,
      options: [
        { id: CONTEXT_WINDOW_STANDARD, label: "Standard", isDefault: true },
        { id: CONTEXT_WINDOW_1M, label: "1M" },
      ],
      currentValue: CONTEXT_WINDOW_STANDARD,
    });
  }

  if (optionDescriptors.length === 0) {
    return EMPTY_CAPABILITIES;
  }

  return createModelCapabilities({ optionDescriptors });
}

// Find the full model ID for a base model + reasoning level + context window.
// Falls back to the base ID itself if no variant matches.
export function resolveDevinModelId(
  baseModelId: string,
  reasoningEffort: string | undefined,
  contextWindow: string | undefined,
  groups: ReadonlyArray<DevinModelGroup>,
): string {
  const group = groups.find((g) => g.baseId === baseModelId);
  if (!group) {
    // No group — apply suffixes manually.
    let modelId = baseModelId;
    if (reasoningEffort?.trim()) modelId = `${modelId}-${reasoningEffort.trim()}`;
    if (contextWindow === CONTEXT_WINDOW_1M) modelId = `${modelId}-1m`;
    return modelId;
  }

  const wantLargeContext = contextWindow === CONTEXT_WINDOW_1M;
  const effort = reasoningEffort?.trim();

  // If no reasoning effort specified, use the group's default level.
  const effectiveEffort = effort || group.defaultLevel;

  if (effectiveEffort) {
    // Find a variant matching reasoning level + context window, preferring non-fast.
    const variant = group.variants.find(
      (v) =>
        v.reasoningLevel === effectiveEffort && v.isLargeContext === wantLargeContext && !v.isFast,
    );
    if (variant) return variant.modelId;
    // Fallback: any variant with the reasoning level + context window.
    const anyVariant = group.variants.find(
      (v) => v.reasoningLevel === effectiveEffort && v.isLargeContext === wantLargeContext,
    );
    if (anyVariant) return anyVariant.modelId;
    // Fallback: just the reasoning level, ignore context window.
    const effortOnly = group.variants.find(
      (v) => v.reasoningLevel === effectiveEffort && !v.isFast,
    );
    if (effortOnly) {
      return wantLargeContext && !effortOnly.isLargeContext
        ? `${effortOnly.modelId}-1m`
        : effortOnly.modelId;
    }
  }

  // No reasoning match — try context window only.
  if (wantLargeContext) {
    const ctxVariant = group.variants.find((v) => v.isLargeContext && !v.isFast);
    if (ctxVariant) return ctxVariant.modelId;
    const base = group.variants.find((v) => v.modelId === baseId) ?? group.variants[0];
    return base ? `${base.modelId}-1m` : `${baseModelId}-1m`;
  }

  // Default: base model without context window suffix.
  const baseVariant = group.variants.find((v) => v.modelId === baseId && !v.isLargeContext);
  return baseVariant?.modelId ?? baseModelId;
}

// Module-level cache of model groups, populated during model discovery.
// Used by resolveDevinModelIdForAdapter to map (baseModelId, reasoningEffort)
// to the actual Devin model ID without needing to pass groups through layers.
let cachedModelGroups: ReadonlyArray<DevinModelGroup> = [];

// Resolve a base model ID + reasoning effort + context window into the
// actual Devin model ID. Uses cached model groups from the last discovery.
// Falls back to appending suffixes if no group matches (legacy behavior).
export function resolveDevinModelIdForAdapter(
  baseModelId: string,
  reasoningEffort: string | undefined,
  contextWindow: string | undefined,
): string {
  if (cachedModelGroups.length === 0) {
    // No groups cached — fall back to simple suffix append.
    let modelId = baseModelId;
    if (reasoningEffort?.trim()) modelId = `${modelId}-${reasoningEffort.trim()}`;
    if (contextWindow === CONTEXT_WINDOW_1M) modelId = `${modelId}-1m`;
    return modelId;
  }
  return resolveDevinModelId(baseModelId, reasoningEffort, contextWindow, cachedModelGroups);
}

// Shared function that takes flat (value, name) model options, groups them
// by base model, caches the groups for adapter model ID resolution, and
// returns ServerProviderModel[] with capabilities. Used by both the
// SessionModelState path and the configOptions path to prevent duplicates.
function buildGroupedDevinModels(
  flatOptions: ReadonlyArray<{ value: string; name: string }>,
  defaultModel: string | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const groups = groupDevinModels(flatOptions);
  // Cache groups for the adapter's model ID resolution.
  cachedModelGroups = groups;
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];

  for (const group of groups) {
    const slug = resolveDevinAcpBaseModelId(group.baseId, defaultModel);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    // If the group has reasoning variants or context window variants,
    // use the base ID as the slug and expose options via capabilities.
    // Otherwise, use the full model ID for single-variant groups.
    if (group.reasoningLevels.length > 1 || group.hasLargeContext) {
      models.push({
        slug,
        name: group.baseName,
        isCustom: false,
        capabilities: buildDevinModelCapabilities(group),
      });
    } else {
      // Single variant or no reasoning — use the original model ID.
      const variant = group.variants[0];
      const fullSlug = resolveDevinAcpBaseModelId(variant.modelId, defaultModel);
      if (fullSlug && !seen.has(fullSlug)) {
        seen.add(fullSlug);
        models.push({
          slug: fullSlug,
          name: cleanBaseDisplayName(variant.name),
          isCustom: false,
          capabilities: EMPTY_CAPABILITIES,
        });
      }
    }
  }

  return models;
}

// Devin CLI does not populate SessionModelState.availableModels. Instead it
// advertises models as a "select" config option with category "model". Extract
// them from there so the UI shows the full model list.
function buildDevinDiscoveredModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  defaultModel: string | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!configOptions) return [];
  const modelOption = configOptions.find(
    (opt) => opt.category === "model" && opt.type === "select",
  );
  if (!modelOption || modelOption.type !== "select") return [];

  // Flatten both ungrouped and grouped option shapes into a single value/name list.
  const flatOptions: ReadonlyArray<{ value: string; name: string }> =
    "options" in modelOption && Array.isArray(modelOption.options)
      ? modelOption.options.flatMap((entry) =>
          "value" in entry
            ? [{ value: entry.value, name: entry.name }]
            : "options" in entry && Array.isArray(entry.options)
              ? entry.options.map((o) => ({ value: o.value, name: o.name }))
              : [],
        )
      : [];

  return buildGroupedDevinModels(flatOptions, defaultModel);
}

const discoverDevinModelsViaAcp = (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeDevinAcpRuntime({
      devinSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    // Devin populates configOptions (not SessionModelState), so check both.
    const fromModelState = buildDevinDiscoveredModelsFromSessionModelState(
      started.sessionSetupResult.models,
      devinSettings.defaultModel,
    );
    if (fromModelState.length > 0) return fromModelState;
    return buildDevinDiscoveredModelsFromConfigOptions(
      started.sessionSetupResult.configOptions,
      devinSettings.defaultModel,
    );
  }).pipe(Effect.scoped);

const runDevinVersionCommand = (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = devinSettings.binaryPath || "devin";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkDevinProviderStatus = Effect.fn("checkDevinProviderStatus")(function* (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = devinModelsFromSettings(
    devinSettings.customModels,
    devinSettings.defaultModel,
  );

  if (!devinSettings.enabled) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Devin is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runDevinVersionCommand(devinSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Devin CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Devin CLI (`devin`) is not installed or not on PATH."
          : "Failed to execute Devin CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but timed out while running `devin --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Devin CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverDevinModelsViaAcp(devinSettings, environment).pipe(
    Effect.timeoutOption(DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Devin ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but ACP startup failed. Check server logs for details.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `Devin ACP model discovery timed out after ${DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Devin CLI is installed but ACP startup timed out after ${DEVIN_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      },
    });
  }
  const discoveredModels = discoveryExit.value.value;
  const models =
    discoveredModels.length > 0
      ? devinModelsFromSettings(
          devinSettings.customModels,
          devinSettings.defaultModel,
          discoveredModels,
        )
      : fallbackModels;

  return buildServerProvider({
    presentation: DEVIN_PRESENTATION,
    enabled: devinSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});

export const enrichDevinSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Devin version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
