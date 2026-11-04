import { describe, expect, it } from "vitest";
import { scrub } from "../src/main/diagnostics";

describe("diagnostics", () => {
  it("removes credentials wherever they appear", () => {
    const text = JSON.stringify({
      authorization: "Bearer abc.def.ghi",
      apiKey: "cue-key-123456789",
      data: { accessToken: "x", refresh_token: "y" },
      url: "https://files.example/f.png?X-Amz-Signature=zzz&name=f.png",
      note: "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLWhlcmU and Bearer qwerty123",
    });
    const out = scrub(text);
    for (const secret of ["abc.def.ghi", "cue-key-123456789", '"x"', '"y"', "zzz", "eyJhbGciOiJIUzI1NiJ9", "qwerty123"]) expect(out).not.toContain(secret);
    expect(out).toContain("name=f.png");
  });
});
