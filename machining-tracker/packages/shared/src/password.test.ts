import { describe, expect, it } from "vitest";
import { passwordProblems } from "./password";

describe("password policy", () => {
  it("requires 12+ characters with upper, lower and digit", () => {
    expect(passwordProblems("Short1A")).toContain("At least 12 characters");
    expect(passwordProblems("alllowercase123")).toContain("An upper-case letter");
    expect(passwordProblems("ALLUPPERCASE123")).toContain("A lower-case letter");
    expect(passwordProblems("NoDigitsHereAtAll")).toContain("A digit");
    expect(passwordProblems("Machining-Tracker-2026")).toEqual([]);
  });
  it("must not contain the email name", () => {
    expect(passwordProblems("Samyak-Passw0rd-2026", "samyak@cess.example")).toContain("Must not contain your email name");
  });
});
