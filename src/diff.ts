/** A minimal unified diff for dry-run output. */
export function renderDiff(before: string, after: string, context = 2): string {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i]![j] =
        a[i] === b[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }

  const lines: { mark: " " | "-" | "+"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ mark: " ", text: a[i]! });
      i += 1;
      j += 1;
    } else if (i < a.length && (j >= b.length || lengths[i + 1]![j]! >= lengths[i]![j + 1]!)) {
      lines.push({ mark: "-", text: a[i]! });
      i += 1;
    } else {
      lines.push({ mark: "+", text: b[j]! });
      j += 1;
    }
  }

  const visible = lines.map((_, index) =>
    lines
      .slice(Math.max(0, index - context), index + context + 1)
      .some((near) => near.mark !== " "),
  );
  const output: string[] = [];
  lines.forEach((line, index) => {
    if (visible[index]) {
      output.push(`${line.mark} ${line.text}`);
    } else if (visible[index - 1]) {
      output.push("  …");
    }
  });
  return output.join("\n");
}

const SECRET_LINE = /(token|bearer|authorization|secret|password|api[_-]?key|credential)/i;

/** Dry-run output must not print credentials that live next to the edited settings. */
export function redactSecrets(text: string): string {
  return text
    .split("\n")
    .map((line) => (SECRET_LINE.test(line) ? line.replace(/(=|:)\s*.*$/, "$1 <redacted>") : line))
    .join("\n");
}
