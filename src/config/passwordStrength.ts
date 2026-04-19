/**
 * Lightweight password-strength estimator. Deliberately does NOT bundle
 * zxcvbn (60+ KB dep) — vsCRT's shipped bundle is ~90 KB and we don't
 * want to double it for a strength meter. Instead, we compute a
 * heuristic score from:
 *   - length (the dominant factor for high-entropy passphrases)
 *   - character-class diversity (lowercase / uppercase / digit / symbol)
 *   - dictionary / pattern penalties (repetition, simple sequences,
 *     the literal word "password" and friends)
 *
 * The score is on a 0..4 scale matching zxcvbn's, so users who switch
 * to a real zxcvbn-backed implementation later get the same UX.
 *
 * Pure: no VS Code imports, no I/O.
 */

export type StrengthScore = 0 | 1 | 2 | 3 | 4;

export interface StrengthResult {
  score: StrengthScore;
  /** Human-readable label for UI. */
  label: "very weak" | "weak" | "fair" | "strong" | "very strong";
  /** Short actionable tip when the score is < 3. */
  suggestion?: string;
}

const COMMON_BLACKLIST: readonly string[] = [
  "password",
  "passw0rd",
  "p@ssword",
  "qwerty",
  "abc123",
  "letmein",
  "admin",
  "welcome",
  "iloveyou",
  "monkey",
  "1234567890",
  "12345678",
  "111111",
  "123qwe",
  "dragon",
  "sunshine",
  "princess",
  "football",
  "master",
  "trustno1",
  "superman",
  "shadow",
  "hunter2",
  "changeme",
  "default",
  "secret",
  "god123",
  "root",
  "test1234",
];

export function scorePassphrase(input: string): StrengthResult {
  if (!input) {
    return {
      score: 0,
      label: "very weak",
      suggestion: "Choose a passphrase of at least 12 characters.",
    };
  }
  const pw = input;
  const lower = pw.toLowerCase();

  // Start with a length-based score.
  let score: StrengthScore = 0;
  if (pw.length >= 8) {score = 1;}
  if (pw.length >= 12) {score = 2;}
  if (pw.length >= 16) {score = 3;}
  if (pw.length >= 20) {score = 4;}

  // Character-class diversity — each distinct class adds entropy.
  const hasLower = /[a-z]/.test(pw);
  const hasUpper = /[A-Z]/.test(pw);
  const hasDigit = /[0-9]/.test(pw);
  const hasSymbol = /[^A-Za-z0-9]/.test(pw);
  const classes = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length;
  if (classes >= 3 && score < 4) {
    score = ((score + 1) > 4 ? 4 : score + 1) as StrengthScore;
  }

  // Penalties.
  if (pw.length < 8) {
    score = 0;
  }
  const penalise = (n: number): StrengthScore => {
    const v = Math.max(0, n);
    return (v > 4 ? 4 : v) as StrengthScore;
  };
  if (isMostlyRepeated(pw)) {
    score = penalise(score - 2);
  }
  if (isSimpleSequence(pw)) {
    score = penalise(score - 2);
  }
  for (const bad of COMMON_BLACKLIST) {
    if (lower.includes(bad)) {
      score = penalise(score - 2);
      break;
    }
  }

  const label = labelFor(score);
  const suggestion =
    score < 3 ? suggestionFor(pw, score, classes) : undefined;
  return { score, label, suggestion };
}

function labelFor(score: StrengthScore): StrengthResult["label"] {
  switch (score) {
    case 0: return "very weak";
    case 1: return "weak";
    case 2: return "fair";
    case 3: return "strong";
    case 4: return "very strong";
  }
}

function suggestionFor(
  pw: string,
  score: StrengthScore,
  classes: number,
): string {
  if (pw.length < 12) {
    return "Too short. Use at least 12 characters.";
  }
  if (classes < 3) {
    return "Mix letters, digits, and symbols for more entropy.";
  }
  if (score < 3) {
    return "Avoid common words and simple sequences.";
  }
  return "";
}

/**
 * Returns true when the password is dominated by a small number of
 * repeating characters (e.g. "aaaaaaaa", "abab..abab", "passwordpassword").
 * Threshold: any 2-5 char window that repeats to cover ≥70% of the
 * input triggers the penalty.
 */
export function isMostlyRepeated(pw: string): boolean {
  if (pw.length < 6) {return false;}
  for (let windowLen = 1; windowLen <= 5; windowLen += 1) {
    if (pw.length < windowLen * 2) {continue;}
    const window = pw.slice(0, windowLen);
    let i = 0;
    let repeats = 0;
    while (i + windowLen <= pw.length) {
      if (pw.slice(i, i + windowLen) === window) {
        repeats += 1;
      }
      i += windowLen;
    }
    if ((repeats * windowLen) / pw.length >= 0.7) {
      return true;
    }
  }
  return false;
}

/** "abcdefgh" / "12345678" / "qwertyui" — keyboard-adjacent or alphanumeric sequences. */
export function isSimpleSequence(pw: string): boolean {
  if (pw.length < 6) {return false;}
  const lower = pw.toLowerCase();
  const sequences = [
    "abcdefghijklmnopqrstuvwxyz",
    "0123456789",
    "qwertyuiop",
    "asdfghjkl",
    "zxcvbnm",
  ];
  for (const seq of sequences) {
    for (let start = 0; start + 6 <= seq.length; start += 1) {
      const run = seq.slice(start, start + 6);
      if (lower.includes(run)) {return true;}
      // Also check reverse runs.
      const rev = run.split("").reverse().join("");
      if (lower.includes(rev)) {return true;}
    }
  }
  return false;
}
