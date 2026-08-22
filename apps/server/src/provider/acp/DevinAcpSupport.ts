// @effect-diagnostics nodeBuiltinImport:off
import { type DevinSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeFs from "node:fs";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const DEVIN_AUTH_METHOD_BROWSER = "devin-browser";
const DEVIN_DRIVER_KIND = ProviderDriverKind.make("devin");

type DevinAcpRuntimeDevinSettings = Pick<DevinSettings, "binaryPath" | "defaultModel">;

interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeDevinSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const defaultModel = devinSettings?.defaultModel?.trim();
  const args = defaultModel ? ["--model", defaultModel, "acp"] : ["acp"];
  // Strip ACP_BACKEND so `devin acp` uses local CLI credentials directly.
  // When ACP_BACKEND=windsurf (set by the Devin desktop app), ACP requires
  // explicit API key auth and refuses to use stored CLI credentials.
  const env: NodeJS.ProcessEnv = { ...environment };
  delete env.ACP_BACKEND;
  return {
    command: devinSettings?.binaryPath || "devin",
    args,
    cwd,
    env,
  };
}

// Read the API key from Devin CLI's credentials file so the ACP runtime can
// authenticate even when the user is not "logged in" via `devin auth login`.
// Devin CLI stores credentials at ~/.local/share/devin/credentials.toml with
// either `windsurf_api_key` or `devin_api_key`.
function readDevinApiKey(environment?: NodeJS.ProcessEnv): string | undefined {
  const home = environment?.HOME || NodeOS.homedir();
  const credPath = NodePath.join(home, ".local", "share", "devin", "credentials.toml");
  try {
    const content = NodeFs.readFileSync(credPath, "utf-8");
    // TOML values may be quoted or unquoted; strip quotes and whitespace.
    for (const key of ["devin_api_key", "windsurf_api_key", "api_key"]) {
      const match = content.match(new RegExp(`^${key}\\s*=\\s*["']?([^"'\\n]+)["']?`, "m"));
      if (match?.[1]?.trim()) return match[1].trim();
    }
  } catch {
    // Credentials file missing or unreadable — ACP will fail with a clear error.
  }
  return undefined;
}

export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const apiKey = readDevinApiKey(input.environment);
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(input.devinSettings, input.cwd, input.environment),
        authMethodId: DEVIN_AUTH_METHOD_BROWSER,
        ...(apiKey ? { authMeta: { api_key: apiKey } } : {}),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
    return runtime;
  });

export function resolveDevinAcpBaseModelId(
  model: string | null | undefined,
  defaultModel?: string | null | undefined,
): string {
  const configuredDefault = defaultModel?.trim();
  const fallback =
    configuredDefault && configuredDefault.length > 0 ? configuredDefault : "adaptive";
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : fallback;
  return normalizeModelSlug(base, DEVIN_DRIVER_KIND) ?? fallback;
}

// Known reasoning level suffixes that Devin encodes in model IDs.
const DEVIN_REASONING_SUFFIXES = ["none", "low", "medium", "high", "xhigh", "max"] as const;

// Combine a base model ID with a reasoning effort level into the full model ID
// that Devin ACP expects. E.g. `glm-5-2` + `max` → `glm-5-2-max`.
// If the base model ID already ends with a reasoning suffix, it is returned as-is.
export function resolveDevinAcpModelIdWithReasoning(
  baseModelId: string,
  reasoningEffort: string | null | undefined,
): string {
  if (!reasoningEffort?.trim()) return baseModelId;
  const effort = reasoningEffort.trim();
  // If the model ID already has a reasoning suffix, don't double-append.
  for (const suffix of DEVIN_REASONING_SUFFIXES) {
    if (baseModelId.endsWith(`-${suffix}`)) return baseModelId;
  }
  return `${baseModelId}-${effort}`;
}

export function currentDevinModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyDevinAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}
