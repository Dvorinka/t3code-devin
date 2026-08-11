import * as Effect from "effect/Effect";

import { type DevinSettings, TextGenerationError } from "@t3tools/contracts";
import * as TextGeneration from "./TextGeneration.ts";

const NOT_IMPLEMENTED_DETAIL = "Devin text generation not yet implemented.";

const failNotImplemented = (
  operation:
    | "generateCommitMessage"
    | "generatePrContent"
    | "generateBranchName"
    | "generateThreadTitle",
): Effect.Effect<never, TextGenerationError> =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: NOT_IMPLEMENTED_DETAIL,
    }),
  );

export const makeDevinTextGeneration = Effect.fn("makeDevinTextGeneration")(function* (
  _devinSettings: DevinSettings,
  _environment: NodeJS.ProcessEnv = process.env,
) {
  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    () => failNotImplemented("generateCommitMessage");

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] = () =>
    failNotImplemented("generatePrContent");

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] = () =>
    failNotImplemented("generateBranchName");

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] = () =>
    failNotImplemented("generateThreadTitle");

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
