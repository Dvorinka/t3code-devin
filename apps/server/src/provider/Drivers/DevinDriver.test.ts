import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { DevinSettings, ProviderDriverKind } from "@t3tools/contracts";

import { DevinDriver } from "./DevinDriver.ts";

describe("DevinDriver", () => {
  it("exposes the devin driver kind", () => {
    expect(DevinDriver.driverKind).toEqual(ProviderDriverKind.make("devin"));
  });

  it("declares Devin metadata", () => {
    expect(DevinDriver.metadata).toEqual({
      displayName: "Devin",
      supportsMultipleInstances: true,
    });
  });

  it("decodes a default config from an empty object", () => {
    const config = Schema.decodeSync(DevinSettings)({});
    expect(DevinDriver.defaultConfig()).toEqual(config);
    expect(config.enabled).toBe(true);
    expect(config.binaryPath).toBe("devin");
    expect(config.defaultModel).toBe("");
    expect(config.customModels).toEqual([]);
  });
});
