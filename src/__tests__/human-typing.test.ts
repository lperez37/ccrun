import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TYPING_PROFILE,
  TYPING_THRESHOLD,
  escapeForSendKeysLiteral,
  keystrokes,
  mulberry32,
  sampleIki,
  sampleRange,
  samplePreSubmitPause,
  samplePreDeliverPause,
  typingProfileFromEnv,
  DEFAULT_PREDELIVER_PAUSE_MS,
  seedFromJobId,
  shouldType,
  type Keystroke,
  type TypingProfile,
} from "../human-typing.js";

function collect(
  text: string,
  profile: TypingProfile,
  seed: number,
): Keystroke[] {
  return [...keystrokes(text, profile, mulberry32(seed))];
}

describe("mulberry32", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = [a(), a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b(), b()];
    assert.deepEqual(seqA, seqB);
  });

  it("produces different streams for different seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    assert.notEqual(a(), b());
  });

  it("yields floats in [0, 1)", () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      assert.ok(v >= 0 && v < 1, `value out of range: ${v}`);
    }
  });

  it("treats seed as uint32 (negative seeds are coerced, not crashing)", () => {
    const rng = mulberry32(-1);
    const v = rng();
    assert.ok(v >= 0 && v < 1);
  });
});

describe("seedFromJobId", () => {
  it("is deterministic for the same id", () => {
    assert.equal(seedFromJobId("otter-1234"), seedFromJobId("otter-1234"));
  });

  it("differs across ids", () => {
    assert.notEqual(seedFromJobId("otter-1234"), seedFromJobId("otter-1235"));
  });

  it("returns a uint32", () => {
    const seed = seedFromJobId("a-very-long-job-id-with-many-chars");
    assert.ok(Number.isInteger(seed));
    assert.ok(seed >= 0 && seed <= 0xffffffff);
  });

  it("handles empty string", () => {
    const seed = seedFromJobId("");
    assert.ok(seed >= 0 && seed <= 0xffffffff);
  });
});

describe("sampleIki", () => {
  it("clamps below floor up to floorMs", () => {
    // medianIkiMs equals floor so the median draw sits at the clamp boundary.
    const profile: TypingProfile = {
      ...DEFAULT_TYPING_PROFILE,
      medianIkiMs: 10,
      floorMs: 55,
      ceilMs: 1400,
    };
    const rng = mulberry32(7);
    for (let i = 0; i < 2000; i++) {
      const v = sampleIki(profile, rng);
      assert.ok(v >= 55, `below floor: ${v}`);
    }
  });

  it("clamps above ceil down to ceilMs", () => {
    const profile: TypingProfile = {
      ...DEFAULT_TYPING_PROFILE,
      medianIkiMs: 5000,
      floorMs: 55,
      ceilMs: 1400,
    };
    const rng = mulberry32(7);
    for (let i = 0; i < 2000; i++) {
      const v = sampleIki(profile, rng);
      assert.ok(v <= 1400, `above ceil: ${v}`);
    }
  });

  it("respects [floor, ceil] for the default profile", () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 5000; i++) {
      const v = sampleIki(DEFAULT_TYPING_PROFILE, rng);
      assert.ok(
        v >= DEFAULT_TYPING_PROFILE.floorMs &&
          v <= DEFAULT_TYPING_PROFILE.ceilMs,
        `out of range: ${v}`,
      );
    }
  });

  it("has its median near medianIkiMs (log-normal is median-parameterized)", () => {
    const rng = mulberry32(2026);
    const samples: number[] = [];
    // Use a wide-clamp profile so clamping does not skew the median.
    const profile: TypingProfile = {
      ...DEFAULT_TYPING_PROFILE,
      medianIkiMs: 200,
      floorMs: 1,
      ceilMs: 100000,
    };
    for (let i = 0; i < 20000; i++) samples.push(sampleIki(profile, rng));
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    assert.ok(
      median > 185 && median < 215,
      `median ${median} not near 200`,
    );
  });
});

describe("sampleRange", () => {
  it("returns min when max <= min", () => {
    assert.equal(sampleRange([100, 100], mulberry32(1)), 100);
    assert.equal(sampleRange([100, 50], mulberry32(1)), 100);
  });

  it("stays within [min, max]", () => {
    const rng = mulberry32(13);
    for (let i = 0; i < 2000; i++) {
      const v = sampleRange([40, 180], rng);
      assert.ok(v >= 40 && v <= 180, `out of range: ${v}`);
    }
  });
});

describe("keystrokes", () => {
  it("is deterministic given a fixed seed", () => {
    const text = "fix the bug in the parser.";
    const a = collect(text, DEFAULT_TYPING_PROFILE, 555);
    const b = collect(text, DEFAULT_TYPING_PROFILE, 555);
    assert.deepEqual(a, b);
  });

  it("emits one keystroke per character (preserving content)", () => {
    const text = "hello world";
    const out = collect(text, DEFAULT_TYPING_PROFILE, 1);
    assert.equal(out.length, text.length);
    assert.equal(out.map((k) => k.ch).join(""), text);
  });

  it("handles multi-byte / unicode characters by code point", () => {
    const text = "café — 日本";
    const out = collect(text, DEFAULT_TYPING_PROFILE, 1);
    assert.equal(out.map((k) => k.ch).join(""), text);
    assert.equal(out.length, [...text].length);
  });

  it("every delay respects floor/ceil bounds at minimum", () => {
    // Disable boundary bonuses and think-pauses to isolate the base IKI clamp.
    const profile: TypingProfile = {
      ...DEFAULT_TYPING_PROFILE,
      wordPauseMs: [0, 0],
      sentencePauseMs: [0, 0],
      thinkPauseChance: 0,
    };
    const out = collect("the quick brown fox jumps.", profile, 8);
    for (const k of out) {
      assert.ok(k.delayMs >= profile.floorMs, `under floor: ${k.delayMs}`);
      assert.ok(k.delayMs <= profile.ceilMs, `over ceil: ${k.delayMs}`);
    }
  });

  it("applies a word-boundary bonus after a space", () => {
    // Fixed large word bonus, zero sentence bonus, no think-pause. The char
    // following a space must be slower than a comparable non-boundary char.
    // Cap base IKI at ceil=200 so the base can never reach the 500ms bonus
    // floor; this makes the assertion deterministic, not probabilistic.
    const profile: TypingProfile = {
      ...DEFAULT_TYPING_PROFILE,
      wordPauseMs: [500, 500],
      sentencePauseMs: [0, 0],
      thinkPauseChance: 0,
      ceilMs: 200,
    };
    const out = collect("ab cd", profile, 3);
    // index: 0='a' 1='b' 2=' ' 3='c'(after space) 4='d'
    const afterSpace = out[3].delayMs;
    assert.ok(
      afterSpace >= 500,
      `expected word bonus >=500 on post-space char, got ${afterSpace}`,
    );
    // 'b' (index 1) follows 'a', no boundary → base IKI is capped at 200.
    assert.ok(out[1].delayMs <= 200, `unexpected bonus on non-boundary char`);
  });

  it("applies a sentence-boundary bonus after . ? ! and newline", () => {
    const profile: TypingProfile = {
      ...DEFAULT_TYPING_PROFILE,
      wordPauseMs: [0, 0],
      sentencePauseMs: [900, 900],
      thinkPauseChance: 0,
      ceilMs: 300,
    };
    // After each ender the NEXT char carries the sentence bonus.
    for (const ender of [".", "?", "!", "\n"]) {
      const out = collect(`a${ender}b`, profile, 5);
      // index 0='a' 1=ender 2='b'(after ender)
      assert.ok(
        out[2].delayMs >= 900,
        `expected sentence bonus after "${ender === "\n" ? "\\n" : ender}", got ${out[2].delayMs}`,
      );
    }
  });

  it("never applies a boundary bonus to the very first character", () => {
    const profile: TypingProfile = {
      ...DEFAULT_TYPING_PROFILE,
      wordPauseMs: [5000, 5000],
      sentencePauseMs: [5000, 5000],
      thinkPauseChance: 0,
      ceilMs: 1000,
    };
    const out = collect("x", profile, 11);
    assert.ok(out[0].delayMs < 5000, "first char must not carry a bonus");
  });

  it("triggers think-pauses when chance is 1 (and only then)", () => {
    const always: TypingProfile = {
      ...DEFAULT_TYPING_PROFILE,
      wordPauseMs: [0, 0],
      sentencePauseMs: [0, 0],
      thinkPauseChance: 1,
      ceilMs: 100000,
    };
    // Cap the no-pause base under 400 so the assertion is deterministic.
    const never: TypingProfile = {
      ...always,
      thinkPauseChance: 0,
      ceilMs: 399,
    };
    const withPause = collect("aaaaaaaaaa", always, 21);
    const noPause = collect("aaaaaaaaaa", never, 21);
    // Think-pause adds 400..1200ms on top of the base IKI on every char.
    for (const k of withPause) {
      assert.ok(k.delayMs >= 400, `think-pause not applied: ${k.delayMs}`);
    }
    const maxNoPause = Math.max(...noPause.map((k) => k.delayMs));
    assert.ok(maxNoPause < 400, "think-pause leaked when chance is 0");
  });

  it("yields nothing for empty text", () => {
    assert.deepEqual(collect("", DEFAULT_TYPING_PROFILE, 1), []);
  });

  it("distribution sanity: mean IKI lands in a human band for an Aalto-like profile", () => {
    // Aalto study: mean IKI ~238ms. A median ~190 with sigma 0.5 gives a
    // log-normal mean ~215ms; word/sentence bonuses over natural prose push
    // the observed mean into the ~200-280ms band.
    const aaltoLike: TypingProfile = {
      ...DEFAULT_TYPING_PROFILE,
      medianIkiMs: 190,
      sigma: 0.5,
      ceilMs: 4000,
    };
    const sentence =
      "The quick brown fox jumps over the lazy dog. " +
      "Pack my box with five dozen liquor jugs! Is this real? ";
    let total = 0;
    let count = 0;
    // Average over many seeds to smooth out per-stream variance.
    for (let seed = 0; seed < 400; seed++) {
      for (const k of keystrokes(sentence, aaltoLike, mulberry32(seed))) {
        total += k.delayMs;
        count++;
      }
    }
    const mean = total / count;
    assert.ok(
      mean > 200 && mean < 300,
      `mean IKI ${mean.toFixed(1)}ms outside expected human band`,
    );
  });

  it("default-profile mean stays modest (fast typist, long prompts tolerable)", () => {
    let total = 0;
    let count = 0;
    const text = "implement the feature and write tests for it as well.";
    for (let seed = 0; seed < 300; seed++) {
      for (const k of keystrokes(text, DEFAULT_TYPING_PROFILE, mulberry32(seed))) {
        total += k.delayMs;
        count++;
      }
    }
    const mean = total / count;
    // Base log-normal mean ~108ms + boundary bonuses; comfortably under 250ms.
    assert.ok(mean > 90 && mean < 250, `default mean ${mean.toFixed(1)}ms`);
  });
});

describe("samplePreSubmitPause", () => {
  it("stays within the profile's preSubmitPauseMs range", () => {
    const rng = mulberry32(77);
    const [min, max] = DEFAULT_TYPING_PROFILE.preSubmitPauseMs;
    for (let i = 0; i < 1000; i++) {
      const v = samplePreSubmitPause(DEFAULT_TYPING_PROFILE, rng);
      assert.ok(v >= min && v <= max, `out of range: ${v}`);
    }
  });
});

describe("shouldType", () => {
  it("types short single-line prompts", () => {
    assert.equal(shouldType("fix the typo"), true);
    assert.equal(shouldType("a".repeat(TYPING_THRESHOLD)), true);
  });

  it("pastes prompts longer than the threshold", () => {
    assert.equal(shouldType("a".repeat(TYPING_THRESHOLD + 1)), false);
  });

  it("pastes multiline prompts even when short", () => {
    assert.equal(shouldType("line one\nline two"), false);
    assert.equal(shouldType("trailing newline\n"), false);
  });

  it("types an empty prompt (boundary)", () => {
    assert.equal(shouldType(""), true);
  });

  it("uses the documented threshold default", () => {
    assert.equal(TYPING_THRESHOLD, 220);
  });
});

describe("escapeForSendKeysLiteral", () => {
  it("escapes a lone semicolon to \\;", () => {
    assert.equal(escapeForSendKeysLiteral(";"), "\\;");
  });

  it("leaves every other risky char untouched (verified literal-safe under -l --)", () => {
    // Full verified-good set from the §10 ground-truth capture: all delivered
    // byte-perfect via `send-keys -l --` with no escaping needed.
    const safe = [
      " ",
      '"',
      "'",
      "`",
      "&",
      "$",
      "{",
      "}",
      "(",
      ")",
      "|",
      "#",
      "~",
      "\\",
      "%",
      "!",
      "*",
      "?",
      "<",
      ">",
      "^",
      "@",
      ":",
      ",",
      ".",
      "=",
      "+",
      "-",
      "[",
      "]",
    ];
    for (const ch of safe) {
      assert.equal(escapeForSendKeysLiteral(ch), ch, `must not alter ${ch}`);
    }
  });

  it("does not alter ordinary letters/digits", () => {
    assert.equal(escapeForSendKeysLiteral("a"), "a");
    assert.equal(escapeForSendKeysLiteral("Z"), "Z");
    assert.equal(escapeForSendKeysLiteral("7"), "7");
  });

  it("is a pure single-char transform (does not mutate input)", () => {
    const ch = ";";
    const out = escapeForSendKeysLiteral(ch);
    assert.equal(ch, ";");
    assert.equal(out, "\\;");
  });
});

describe("DEFAULT_TYPING_PROFILE", () => {
  it("matches the PLAN.md §5 defaults", () => {
    assert.equal(DEFAULT_TYPING_PROFILE.medianIkiMs, 95);
    assert.equal(DEFAULT_TYPING_PROFILE.sigma, 0.5);
    assert.equal(DEFAULT_TYPING_PROFILE.floorMs, 55);
    assert.equal(DEFAULT_TYPING_PROFILE.ceilMs, 1400);
    assert.equal(DEFAULT_TYPING_PROFILE.thinkPauseChance, 0.03);
    assert.deepEqual(DEFAULT_TYPING_PROFILE.wordPauseMs, [40, 180]);
    assert.deepEqual(DEFAULT_TYPING_PROFILE.sentencePauseMs, [180, 650]);
    assert.deepEqual(DEFAULT_TYPING_PROFILE.preSubmitPauseMs, [350, 1200]);
  });
});

describe("samplePreDeliverPause", () => {
  it("samples within the profile's pre-deliver range", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 200; i++) {
      const v = samplePreDeliverPause(DEFAULT_TYPING_PROFILE, rng);
      assert.ok(v >= 400 && v <= 1500, `out of range: ${v}`);
    }
  });

  it("falls back to DEFAULT_PREDELIVER_PAUSE_MS when the profile omits the field", () => {
    const rng = mulberry32(7);
    const profile = {
      ...DEFAULT_TYPING_PROFILE,
      preDeliverPauseMs: undefined,
    } as TypingProfile;
    const [min, max] = DEFAULT_PREDELIVER_PAUSE_MS;
    const v = samplePreDeliverPause(profile, rng);
    assert.ok(v >= min && v <= max);
  });
});

describe("typingProfileFromEnv", () => {
  it("returns the default profile when env is empty", () => {
    assert.deepEqual(typingProfileFromEnv({}), DEFAULT_TYPING_PROFILE);
  });

  it("applies numeric and range overrides, leaving others default", () => {
    const p = typingProfileFromEnv({
      TYPING_MEDIAN_IKI_MS: "120",
      TYPING_WORD_PAUSE_MS: "10,50",
      TYPING_PREDELIVER_PAUSE_MS: "200,900",
    });
    assert.equal(p.medianIkiMs, 120);
    assert.deepEqual(p.wordPauseMs, [10, 50]);
    assert.deepEqual(p.preDeliverPauseMs, [200, 900]);
    assert.equal(p.sigma, DEFAULT_TYPING_PROFILE.sigma);
  });

  it("ignores invalid numbers and bad ranges (max<min, non-numeric)", () => {
    const p = typingProfileFromEnv({
      TYPING_MEDIAN_IKI_MS: "abc",
      TYPING_WORD_PAUSE_MS: "50,10",
      TYPING_SENTENCE_PAUSE_MS: "nope",
    });
    assert.equal(p.medianIkiMs, DEFAULT_TYPING_PROFILE.medianIkiMs);
    assert.deepEqual(p.wordPauseMs, DEFAULT_TYPING_PROFILE.wordPauseMs);
    assert.deepEqual(p.sentencePauseMs, DEFAULT_TYPING_PROFILE.sentencePauseMs);
  });
});
