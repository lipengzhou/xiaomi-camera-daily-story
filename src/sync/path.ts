export function safePathSegment(value: string, fallback: string): string {
  const sanitize = (input: string): string =>
    input
      .normalize("NFC")
      .replace(/[\\/<>:"|?*\u0000-\u001f\u007f]/g, "_")
      .trim()
      .replace(/[. ]+$/g, "");
  const sanitized = sanitize(value);
  const sanitizedFallback = sanitize(fallback);
  let usable = sanitized && sanitized !== "." && sanitized !== ".." ? sanitized : sanitizedFallback;
  if (!usable || usable === "." || usable === "..") {
    usable = "未命名";
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(usable)) {
    usable = `_${usable}`;
  }
  return [...usable].slice(0, 60).join("");
}
