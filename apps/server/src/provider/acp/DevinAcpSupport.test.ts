import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyDevinAcpModelSelection,
  buildDevinAcpSpawnInput,
  resolveDevinAcpBaseModelId,
} from "./DevinAcpSupport.ts";

describe("resolveDevinAcpBaseModelId", () => {
  it("normalizes empty and custom Devin model ids", () => {
    expect(resolveDevinAcpBaseModelId(undefined)).toBe("adaptive");
    expect(resolveDevinAcpBaseModelId("   ")).toBe("adaptive");
    expect(resolveDevinAcpBaseModelId("  devin-test-custom-model  ")).toBe(
      "devin-test-custom-model",
    );
  });

  it("uses the configured defaultModel as fallback when provided", () => {
    expect(resolveDevinAcpBaseModelId(undefined, "my-model")).toBe("my-model");
    expect(resolveDevinAcpBaseModelId("   ", "my-model")).toBe("my-model");
  });
});

describe("buildDevinAcpSpawnInput", () => {
  it("builds args without --model when defaultModel is empty", () => {
    const spawn = buildDevinAcpSpawnInput(
      { binaryPath: "/usr/local/bin/devin", defaultModel: "" },
      "/tmp/project",
      { DEVIN_API_KEY: "secret" },
    );

    expect(spawn).toEqual({
      command: "/usr/local/bin/devin",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { DEVIN_API_KEY: "secret" },
    });
  });

  it("builds args with --model when defaultModel is set", () => {
    const spawn = buildDevinAcpSpawnInput(
      { binaryPath: "/usr/local/bin/devin", defaultModel: "adaptive" },
      "/tmp/project",
    );

    expect(spawn.args).toEqual(["--model", "adaptive", "acp"]);
  });

  it("falls back to the devin binary name when binaryPath is empty", () => {
    const spawn = buildDevinAcpSpawnInput({ binaryPath: "", defaultModel: "" }, "/tmp");
    expect(spawn.command).toBe("devin");
    expect(spawn.args).toEqual(["acp"]);
  });
});

describe("applyDevinAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<string> = [];
    const runtime = {
      setSessionModel: (modelId: string) =>
        Effect.gen(function* () {
          modelCalls.push(modelId);
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls };
  };

  it.effect("calls session/set_model when the requested model differs from current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: "adaptive",
        requestedModelId: "devin-mock-alt",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["devin-mock-alt"]);
      expect(result).toBe("devin-mock-alt");
    }),
  );

  it.effect("skips set_model when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: "adaptive",
        requestedModelId: "adaptive",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("adaptive");
    }),
  );

  it.effect("skips set_model when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyDevinAcpModelSelection({
        runtime,
        currentModelId: "adaptive",
        requestedModelId: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("adaptive");
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyDevinAcpModelSelection({
          runtime,
          currentModelId: "adaptive",
          requestedModelId: "devin-mock-alt",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});
