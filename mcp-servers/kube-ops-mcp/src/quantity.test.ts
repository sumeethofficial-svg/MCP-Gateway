import { describe, expect, it } from "vitest";
import { parseBytes, parseCpuMillicores, toMiB } from "./quantity.js";

describe("quantities", () => {
  it.each([
    ["250m", 250],
    ["1", 1000],
    ["0.5", 500],
    ["23456789n", 23.5],
    ["500u", 0.5],
  ])("cpu %s -> %s millicores", (q, expected) => expect(parseCpuMillicores(q)).toBe(expected));

  it.each([
    ["128Mi", 134217728],
    ["98304Ki", 100663296],
    ["1Gi", 1073741824],
    ["1000000", 1000000],
    ["2M", 2000000],
  ])("memory %s -> %s bytes", (q, expected) => expect(parseBytes(q)).toBe(expected));

  it("rejects garbage instead of guessing", () => {
    expect(parseCpuMillicores("lots")).toBeUndefined();
    expect(parseBytes("12 parsecs")).toBeUndefined();
    expect(parseBytes(undefined)).toBeUndefined();
  });
  it("converts to MiB with one decimal", () => expect(toMiB(100663296)).toBe(96));
});
