/**
 * Label copy in an ask says what the part reads, not which part it is. "A primary button labelled Pay now" asks
 * for a Button; "Pay" and "now" are its text. Left in, those words looked like a second subject after the one part
 * word, so the out-of-domain gate emptied the pick, or they pulled the pick toward a part named after the copy.
 * This drops quoted text and a label clause ("labelled X", "titled X", "that says X") up to the next describing
 * word ("for", "with", "on" and the like), which stays. A label word with no part word before it ("labelled text
 * field", "a labelled text field") is a description of the part and stays. If nothing would be left, the ask is unchanged.
 */
const QUOTED = /(^|[\s(:,])(?:"[^"\n]{1,80}"|“[^”\n]{1,80}”|'[^'\n]{1,80}'|‘[^’\n]{1,80}’)(?=$|[\s).,!?:;])/g;
const LABEL = /\s+(?:labell?ed|captioned|titled|called|named|(?:that|which)\s+(?:says|reads))(?=\s)/i;
const KEEP_FROM = new Set(["for", "to", "with", "when", "while", "on", "in", "inside", "at", "under", "above", "below", "after", "before", "and"]);
const ARTICLE = new Set(["a", "an", "the", "one", "some", "my", "your"]);

export function dropLabelText(ask: string): string {
  const unquoted = ask.replace(QUOTED, "$1").replace(/\s{2,}/g, " ").trim();
  let text = unquoted;
  const label = LABEL.exec(text);
  if (label) {
    const lead = text.slice(0, label.index);
    const leadWords = lead.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (leadWords.some((word) => !ARTICLE.has(word))) {
      const rest = text.slice(label.index + label[0].length).trim().split(/\s+/).filter(Boolean);
      const keepAt = rest.findIndex((word, i) => i > 0 && KEEP_FROM.has(word.toLowerCase().replace(/[^a-z]/g, "")));
      text = [lead.trim(), ...(keepAt > 0 ? rest.slice(keepAt) : [])].join(" ");
    }
  }
  text = text.replace(/[\s,;:]+$/, "").trim();
  return /[a-z0-9]/i.test(text) ? text : ask;
}
